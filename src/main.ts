import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { dedupeKey, filterJobs, titleKey } from "./filter.js";
import { formatDigestChunks, sendTelegram } from "./notify.js";
import { loadProfile, type Profile } from "./profile.js";
import { scoreJobs, type ScoredJob } from "./score.js";
import { fetchAllAts, type Company, type FetchAllAtsResult } from "./sources/ats.js";
import { runJobspy, type JobspyConfig } from "./sources/jobspy.js";
import { fetchRemoteEsCompanies } from "./sources/remote-es.js";
import { acquireLock, releaseLock, SeenStore, type SeenEntryInput } from "./store.js";
import type { Job } from "./types.js";

const DEFAULT_DATA_DIR = "/data";
const MIN_SEND_SCORE = 6;

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  DATA_DIR: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().min(1).default(DEFAULT_DATA_DIR),
  ),
  PROFILE_PATH: optionalString,
  PYTHON_BIN: optionalString,
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,
  DEEPSEEK_API_KEY: optionalString,
  DEEPSEEK_BASE_URL: optionalString,
  DEEPSEEK_MODEL: optionalString,
});

interface CliOptions {
  dryRun: boolean;
  limit?: number;
}

export interface RunDependencies {
  loadProfile: (path: string) => Profile;
  fetchRemoteCompanies: () => Promise<Company[]>;
  fetchAtsJobs: (companies: Company[]) => Promise<FetchAllAtsResult>;
  fetchJobspyJobs: (config: JobspyConfig) => Promise<Job[]>;
  score: (jobs: Job[], profile: Profile) => Promise<ScoredJob[]>;
  notify: (messages: string[]) => Promise<void>;
}

export interface RunOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  deps?: Partial<RunDependencies>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface RunResult {
  dryRun: boolean;
  raw: number;
  filtered: number;
  fresh: number;
  scored: number;
  sent: number;
}

interface RuntimeConfig {
  dataDir: string;
  profilePath: string;
  pythonBin?: string;
}

function parseLimit(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`--limit requiere un entero positivo, recibido "${value}"`);
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`--limit requiere un entero positivo, recibido "${value}"`);
  }
  return limit;
}

function parseArgs(argv: string[]): CliOptions {
  let dryRun = false;
  let limit: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--limit") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--limit requiere un valor");
      limit = parseLimit(value);
      index += 1;
      continue;
    }
    throw new Error(`Argumento no reconocido: ${arg ?? ""}`);
  }

  return { dryRun, ...(limit !== undefined ? { limit } : {}) };
}

function parseEnv(env: NodeJS.ProcessEnv, dryRun: boolean): RuntimeConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Variables de entorno inválidas:\n${z.prettifyError(parsed.error)}`);
  }

  if (!dryRun) {
    const missing: string[] = [];
    if (!parsed.data.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
    if (!parsed.data.TELEGRAM_CHAT_ID) missing.push("TELEGRAM_CHAT_ID");
    if (missing.length > 0) {
      throw new Error(`Faltan variables de entorno: ${missing.join(", ")}`);
    }
  }

  return {
    dataDir: parsed.data.DATA_DIR,
    profilePath: parsed.data.PROFILE_PATH ?? join(parsed.data.DATA_DIR, "profile.yml"),
    ...(parsed.data.PYTHON_BIN ? { pythonBin: parsed.data.PYTHON_BIN } : {}),
  };
}

function buildDependencies(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  overrides: Partial<RunDependencies> | undefined,
): RunDependencies {
  const defaults: RunDependencies = {
    loadProfile,
    fetchRemoteCompanies: () => fetchRemoteEsCompanies(fetch),
    fetchAtsJobs: (companies) => fetchAllAts(companies),
    fetchJobspyJobs: (jobspy) =>
      runJobspy(jobspy, config.pythonBin ? { pythonBin: config.pythonBin } : {}),
    score: (jobs, profile) => scoreJobs(jobs, profile, { env }),
    notify: (messages) => sendTelegram(messages, { env }),
  };

  return { ...defaults, ...overrides };
}

function buildSummary(
  remoteCompanies: number,
  extraCompanies: number,
  ats: FetchAllAtsResult,
  jobspyCount: number,
  raw: number,
  filtered: number,
  fresh: number,
  scored: number,
  sentLabel: string,
): string {
  return [
    `resumen: remote-es=${remoteCompanies}, extra=${extraCompanies}`,
    `ats ashby=${ats.coverage.ashby} greenhouse=${ats.coverage.greenhouse} lever=${ats.coverage.lever} workable=${ats.coverage.workable} personio=${ats.coverage.personio} recruitee=${ats.coverage.recruitee} no-soportadas=${ats.coverage.unsupported}`,
    `ats-errores=${ats.errors.length}`,
    `jobspy=${jobspyCount}`,
    `brutas=${raw}`,
    `tras-filtro=${filtered}`,
    `nuevas=${fresh}`,
    `puntuadas=${scored}`,
    `enviadas=${sentLabel}`,
  ].join("; ");
}

function markSeen(store: SeenStore, job: Job, data: SeenEntryInput): void {
  store.mark(dedupeKey(job), data);
  store.mark(titleKey(job), data);
}

function scoreEntryData(job: ScoredJob): SeenEntryInput {
  return {
    score: job.score,
    reason: job.reason,
    scoredBy: job.scoredBy,
    company: job.company,
    title: job.title,
  };
}

export async function run(options: RunOptions = {}): Promise<RunResult> {
  const env = options.env ?? process.env;
  const cli = parseArgs(options.argv ?? process.argv.slice(2));
  const config = parseEnv(env, cli.dryRun);
  const deps = buildDependencies(config, env, options.deps);
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((message: string) => console.log(message));

  let lockToken: string | undefined;
  try {
    if (!cli.dryRun) {
      lockToken = acquireLock(config.dataDir);
    }

    const profile = deps.loadProfile(config.profilePath);
    const maxPerDay = cli.limit ?? profile.maxPerDay;

    const remoteCompanies = await deps.fetchRemoteCompanies();
    const companies = [...remoteCompanies, ...profile.extraCompanies];

    const [ats, jobspyJobs] = await Promise.all([
      deps.fetchAtsJobs(companies),
      deps.fetchJobspyJobs(profile.jobspy),
    ]);

    const rawJobs = [...ats.jobs, ...jobspyJobs];
    if (rawJobs.length === 0) throw new Error("ninguna fuente devolvió ofertas");

    const filtered = filterJobs(rawJobs, profile);

    const store = new SeenStore(config.dataDir);
    store.load(cli.dryRun ? { readOnly: true } : {});
    const isSeen = (job: Job): boolean => store.has(dedupeKey(job)) || store.has(titleKey(job));
    const fresh = filtered.filter((job) => !isSeen(job));

    const scored = await deps.score(fresh, profile);

    if (!cli.dryRun) {
      for (const job of scored) {
        if (job.scoredBy === "llm" && job.score < MIN_SEND_SCORE) {
          markSeen(store, job, scoreEntryData(job));
        }
      }
    }

    if (cli.dryRun) {
      const byScore = [...scored].sort((a, b) => b.score - a.score);
      for (const job of byScore) {
        log(
          `${job.score} | ${job.scoredBy} | ${job.company} | ${job.title} | ${job.location} | ${job.reason}`,
        );
      }
    }

    const top = scored
      .filter((job) => job.score >= MIN_SEND_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxPerDay);

    const date = now().toISOString().slice(0, 10);
    let sent = 0;

    if (top.length > 0) {
      const chunks = formatDigestChunks(top, date);
      if (cli.dryRun) {
        for (const chunk of chunks) log(chunk.text);
      } else {
        for (const chunk of chunks) {
          await deps.notify([chunk.text]);
          for (const job of chunk.jobs) {
            markSeen(store, job, { ...scoreEntryData(job), notified: true });
          }
          store.save();
          sent += chunk.jobs.length;
        }
      }
    } else if (!cli.dryRun) {
      store.save();
    }

    const sentLabel = cli.dryRun ? `0 (dry-run, candidatas=${top.length})` : String(sent);
    const summary = buildSummary(
      remoteCompanies.length,
      profile.extraCompanies.length,
      ats,
      jobspyJobs.length,
      rawJobs.length,
      filtered.length,
      fresh.length,
      scored.length,
      sentLabel,
    );

    log(top.length === 0 ? `nada nuevo; ${summary}` : summary);

    return {
      dryRun: cli.dryRun,
      raw: rawJobs.length,
      filtered: filtered.length,
      fresh: fresh.length,
      scored: scored.length,
      sent,
    };
  } finally {
    if (lockToken !== undefined) releaseLock(config.dataDir, lockToken);
  }
}

const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isMain) {
  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`radar-empleo: ${message}`);
    process.exitCode = 1;
  });
}

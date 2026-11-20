import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dedupeKey } from "./filter.js";
import { run, type RunDependencies } from "./main.js";
import type { Profile } from "./profile.js";
import type { ScoredJob } from "./score.js";
import type { Company, FetchAllAtsResult } from "./sources/ats.js";
import { SeenStore, type SeenData } from "./store.js";
import type { Job } from "./types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "radar-empleo-main-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    includeTitle: ["react"],
    excludeTitle: [],
    locationOk: ["spain"],
    excludeText: [],
    applied: [],
    maxPerDay: 5,
    maxScoredPerRun: 30,
    cvSummary: "Full stack developer with TypeScript and React.",
    jobspy: {
      searches: ["react developer"],
      resultsWanted: 20,
      hoursOld: 72,
      sites: ["indeed", "glassdoor"],
      country: "spain",
    },
    extraCompanies: [],
    ...overrides,
  };
}

function makeJob(label: string): Job {
  return {
    id: `ats:example:${label}`,
    source: "ats",
    company: `Company ${label}`,
    title: `React Developer ${label}`,
    location: "Barcelona, Spain",
    remote: false,
    url: `https://example.com/jobs/${label}`,
    description: "React role.",
  };
}

function emptyCoverage(): FetchAllAtsResult["coverage"] {
  return {
    ashby: 0,
    greenhouse: 0,
    lever: 0,
    workable: 0,
    personio: 0,
    recruitee: 0,
    unsupported: 0,
  };
}

function makeDeps(jobs: Job[], scores: number[], profile: Profile) {
  const score = vi.fn<(jobs: Job[], profile: Profile) => Promise<ScoredJob[]>>(
    async (input) =>
      input.map((job, index) => ({
        ...job,
        score: scores[index] ?? 0,
        reason: "test",
        scoredBy: "rules" as const,
      })),
  );
  const notify = vi.fn<(messages: string[]) => Promise<void>>(async () => {});

  const deps: RunDependencies = {
    loadProfile: () => profile,
    fetchRemoteCompanies: async (): Promise<Company[]> => [],
    fetchAtsJobs: async () => ({ jobs, errors: [], coverage: emptyCoverage() }),
    fetchJobspyJobs: async () => [],
    score,
    notify,
  };

  return { deps, score, notify };
}

function readSeen(): SeenData {
  return JSON.parse(readFileSync(join(dir, "seen.json"), "utf8")) as SeenData;
}

describe("run", () => {
  it("en dry-run imprime el resumen sin enviar ni guardar estado", async () => {
    const job = makeJob("A");
    const profile = makeProfile();
    const { deps, notify } = makeDeps([job], [9], profile);
    const log = vi.fn<(message: string) => void>();

    const result = await run({
      argv: ["--dry-run"],
      env: { DATA_DIR: dir, PROFILE_PATH: join(dir, "profile.yml") },
      deps,
      log,
    });

    expect(result.dryRun).toBe(true);
    expect(result.sent).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "seen.json"))).toBe(false);
    expect(log.mock.calls.some(([message]) => message.includes("React Developer A"))).toBe(true);
  });

  it("no vuelve a procesar las ofertas ya vistas", async () => {
    const seenJob = makeJob("Seen");
    const newJob = makeJob("New");
    const profile = makeProfile();
    const { deps, score, notify } = makeDeps([seenJob, newJob], [9, 9], profile);

    const store = new SeenStore(dir);
    store.load();
    store.mark(dedupeKey(seenJob), { score: 7 });
    store.save();

    const result = await run({
      argv: [],
      env: {
        DATA_DIR: dir,
        PROFILE_PATH: join(dir, "profile.yml"),
        TELEGRAM_BOT_TOKEN: "123:test",
        TELEGRAM_CHAT_ID: "42",
      },
      deps,
      log: () => {},
    });

    expect(score).toHaveBeenCalledTimes(1);
    const passed = score.mock.calls[0]?.[0] ?? [];
    expect(passed.map((job) => job.id)).toEqual([newJob.id]);

    expect(notify).toHaveBeenCalledTimes(1);
    const digest = notify.mock.calls[0]?.[0]?.[0] ?? "";
    expect(digest).toContain("React Developer New");
    expect(digest).not.toContain("React Developer Seen");

    expect(result.sent).toBe(1);
    expect(result.fresh).toBe(1);
    expect(existsSync(join(dir, "run.lock"))).toBe(false);

    const data = readSeen();
    expect(data[dedupeKey(seenJob)]).toMatchObject({ score: 7 });
    expect(data[dedupeKey(newJob)]).toMatchObject({ score: 9, notified: true });
  });

  it("envía como máximo maxPerDay ofertas, las de mayor score", async () => {
    const jobs = [makeJob("A"), makeJob("B"), makeJob("C"), makeJob("D")];
    const profile = makeProfile({ maxPerDay: 2 });
    const { deps, notify } = makeDeps(jobs, [9, 8, 7, 6], profile);

    await run({
      argv: [],
      env: {
        DATA_DIR: dir,
        PROFILE_PATH: join(dir, "profile.yml"),
        TELEGRAM_BOT_TOKEN: "123:test",
        TELEGRAM_CHAT_ID: "42",
      },
      deps,
      log: () => {},
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const messages = notify.mock.calls[0]?.[0] ?? [];
    expect(messages).toHaveLength(1);
    const digest = messages[0] ?? "";
    expect(digest).toContain("2 ofertas");
    expect(digest).toContain("React Developer A");
    expect(digest).toContain("React Developer B");
    expect(digest).not.toContain("React Developer C");
    expect(digest).not.toContain("React Developer D");
  });
});

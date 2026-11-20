import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dedupeKey, titleKey } from "./filter.js";
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

function makeDeps(
  jobs: Job[],
  scores: number[],
  profile: Profile,
  scoredBy: ScoredJob["scoredBy"][] = [],
) {
  const score = vi.fn<(jobs: Job[], profile: Profile) => Promise<ScoredJob[]>>(
    async (input) =>
      input.map((job, index) => ({
        ...job,
        score: scores[index] ?? 0,
        reason: "test",
        scoredBy: scoredBy[index] ?? ("rules" as const),
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

  it("en dry-run imprime una línea por oferta puntuada ordenada por nota", async () => {
    const jobs = [makeJob("A"), makeJob("B"), makeJob("C")];
    const profile = makeProfile();
    const { deps } = makeDeps(jobs, [5, 9, 7], profile, ["rules", "llm", "llm"]);
    const log = vi.fn<(message: string) => void>();

    await run({
      argv: ["--dry-run"],
      env: { DATA_DIR: dir, PROFILE_PATH: join(dir, "profile.yml") },
      deps,
      log,
    });

    const lines = log.mock.calls
      .map(([message]) => message)
      .filter((message) => message.includes(" | "));

    expect(lines).toEqual([
      "9 | llm | Company B | React Developer B | Barcelona, Spain | test",
      "7 | llm | Company C | React Developer C | Barcelona, Spain | test",
      "5 | rules | Company A | React Developer A | Barcelona, Spain | test",
    ]);
  });

  it("guarda nota, motivo, origen, empresa y título al marcar una oferta enviada", async () => {
    const job = makeJob("A");
    const profile = makeProfile();
    const { deps } = makeDeps([job], [9], profile, ["llm"]);

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

    const data = readSeen();
    const expected = {
      score: 9,
      notified: true,
      reason: "test",
      scoredBy: "llm",
      company: "Company A",
      title: "React Developer A",
    };
    expect(data[dedupeKey(job)]).toMatchObject(expected);
    expect(data[titleKey(job)]).toMatchObject(expected);
  });

  it("guarda los datos de las ofertas puntuadas por el LLM y descartadas", async () => {
    const job = makeJob("A");
    const profile = makeProfile();
    const { deps } = makeDeps([job], [4], profile, ["llm"]);

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

    const data = readSeen();
    const entry = data[dedupeKey(job)];
    expect(entry).toMatchObject({
      score: 4,
      reason: "test",
      scoredBy: "llm",
      company: "Company A",
      title: "React Developer A",
    });
    expect(entry?.notified).toBeUndefined();
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
    expect(data[dedupeKey(newJob)]).toMatchObject({ notified: true });
    expect(data[titleKey(newJob)]).toMatchObject({ notified: true });
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

  it("solo marca como vistas las enviadas y las puntuadas por el LLM por debajo de 6", async () => {
    const jobs = [makeJob("A"), makeJob("B"), makeJob("C"), makeJob("D")];
    const profile = makeProfile({ maxPerDay: 1 });
    const { deps } = makeDeps(jobs, [9, 7, 5, 9], profile, ["llm", "llm", "llm", "rules"]);

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

    expect(result.sent).toBe(1);

    const data = readSeen();
    const sent = jobs[0];
    const belowThreshold = jobs[2];
    const notSent = jobs[1];
    const rules = jobs[3];
    if (!sent || !belowThreshold || !notSent || !rules) throw new Error("faltan ofertas");

    expect(data[dedupeKey(sent)]).toMatchObject({ notified: true });
    expect(data[titleKey(sent)]).toMatchObject({ notified: true });
    expect(data[dedupeKey(belowThreshold)]).toMatchObject({ score: 5 });
    expect(data[titleKey(belowThreshold)]).toMatchObject({ score: 5 });
    expect(data[dedupeKey(notSent)]).toBeUndefined();
    expect(data[titleKey(notSent)]).toBeUndefined();
    expect(data[dedupeKey(rules)]).toBeUndefined();
    expect(data[titleKey(rules)]).toBeUndefined();
  });

  it("guarda cada mensaje entregado y no pierde el estado si falla uno posterior", async () => {
    const jobs = Array.from({ length: 24 }, (_, index) => {
      const label = String.fromCharCode(65 + index);
      return {
        ...makeJob(label),
        company: `Company ${label} ${"x".repeat(180)}`,
        title: `React Developer ${label} ${"y".repeat(120)}`,
      };
    });
    const profile = makeProfile({ maxPerDay: 30 });
    const { deps, notify } = makeDeps(
      jobs,
      jobs.map(() => 9),
      profile,
      jobs.map(() => "llm" as const),
    );

    let calls = 0;
    notify.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) throw new Error("fallo de envío");
    });

    await expect(
      run({
        argv: [],
        env: {
          DATA_DIR: dir,
          PROFILE_PATH: join(dir, "profile.yml"),
          TELEGRAM_BOT_TOKEN: "123:test",
          TELEGRAM_CHAT_ID: "42",
        },
        deps,
        log: () => {},
      }),
    ).rejects.toThrow("fallo de envío");

    expect(notify.mock.calls.length).toBeGreaterThanOrEqual(2);
    const firstMessage = notify.mock.calls[0]?.[0]?.[0] ?? "";
    const firstLabels = [...firstMessage.matchAll(/Company ([A-X]) /g)].map((match) => match[1]);
    expect(firstLabels.length).toBeGreaterThan(0);

    const data = readSeen();
    const notified = Object.values(data).filter((entry) => entry.notified === true);
    expect(notified).toHaveLength(firstLabels.length * 2);
  });

  it("incluye los errores de las fuentes en el resumen", async () => {
    const job = makeJob("A");
    const profile = makeProfile();
    const { deps } = makeDeps([job], [9], profile);
    deps.fetchAtsJobs = async () => ({
      jobs: [job],
      errors: [
        { company: "Uno", url: "https://uno.example", error: "boom" },
        { company: "Dos", url: "https://dos.example", error: "boom" },
      ],
      coverage: emptyCoverage(),
    });
    const log = vi.fn<(message: string) => void>();

    await run({
      argv: [],
      env: {
        DATA_DIR: dir,
        PROFILE_PATH: join(dir, "profile.yml"),
        TELEGRAM_BOT_TOKEN: "123:test",
        TELEGRAM_CHAT_ID: "42",
      },
      deps,
      log,
    });

    expect(log.mock.calls.map(([message]) => message).join("\n")).toContain("ats-errores=2");
  });

  it("termina con error si ninguna fuente devuelve ofertas", async () => {
    const profile = makeProfile();
    const { deps } = makeDeps([], [], profile);

    await expect(
      run({
        argv: [],
        env: {
          DATA_DIR: dir,
          PROFILE_PATH: join(dir, "profile.yml"),
          TELEGRAM_BOT_TOKEN: "123:test",
          TELEGRAM_CHAT_ID: "42",
        },
        deps,
        log: () => {},
      }),
    ).rejects.toThrow("ninguna fuente devolvió ofertas");

    expect(existsSync(join(dir, "run.lock"))).toBe(false);
  });

  it("en dry-run no renombra un seen.json corrupto", async () => {
    writeFileSync(join(dir, "seen.json"), "esto no es json", "utf8");
    const job = makeJob("A");
    const profile = makeProfile();
    const { deps } = makeDeps([job], [9], profile);

    await run({
      argv: ["--dry-run"],
      env: { DATA_DIR: dir, PROFILE_PATH: join(dir, "profile.yml") },
      deps,
      log: () => {},
    });

    expect(readFileSync(join(dir, "seen.json"), "utf8")).toBe("esto no es json");
    expect(readdirSync(dir).some((name) => name.startsWith("seen.corrupt-"))).toBe(false);
  });
});

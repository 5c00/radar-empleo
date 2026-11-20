import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLock, releaseLock, SeenStore, type SeenData } from "./store.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "radar-empleo-store-"));
});

afterEach(() => {
  vi.mocked(writeFileSync).mockClear();
  rmSync(dir, { recursive: true, force: true });
});

function readSeen(): SeenData {
  return JSON.parse(readFileSync(join(dir, "seen.json"), "utf8")) as SeenData;
}

describe("SeenStore", () => {
  it("guarda, recarga y consulta entradas", () => {
    const store = new SeenStore(dir);
    store.load();
    expect(store.has("job-1")).toBe(false);

    store.mark("job-1", { score: 8, notified: true });
    store.save();

    const reloaded = new SeenStore(dir);
    reloaded.load();
    expect(reloaded.has("job-1")).toBe(true);

    const data = readSeen();
    expect(data["job-1"]).toMatchObject({ score: 8, notified: true });
    expect(data["job-1"]?.firstSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("conserva firstSeen al volver a marcar una entrada", () => {
    const store = new SeenStore(dir);
    store.load();
    store.mark("job-1", { score: 5 });
    store.save();

    const firstSeen = readSeen()["job-1"]?.firstSeen;
    store.mark("job-1", { notified: true });
    store.save();

    const data = readSeen();
    expect(data["job-1"]?.firstSeen).toBe(firstSeen);
    expect(data["job-1"]).toMatchObject({ score: 5, notified: true });
  });

  it("fusiona los campos nuevos sin perder los anteriores", () => {
    const store = new SeenStore(dir);
    store.load();
    store.mark("job-1", {
      score: 8,
      reason: "Encaja con React",
      scoredBy: "llm",
      company: "Acme",
      title: "Frontend Developer",
    });
    store.save();

    store.mark("job-1", { notified: true });
    store.save();

    const data = readSeen();
    expect(data["job-1"]).toMatchObject({
      score: 8,
      reason: "Encaja con React",
      scoredBy: "llm",
      company: "Acme",
      title: "Frontend Developer",
      notified: true,
    });
  });

  it("recorta a 200 caracteres company, title y reason", () => {
    const store = new SeenStore(dir);
    store.load();
    store.mark("job-1", {
      company: "c".repeat(250),
      title: "t".repeat(250),
      reason: "r".repeat(250),
    });
    store.save();

    const entry = readSeen()["job-1"];
    expect(entry?.company).toHaveLength(200);
    expect(entry?.title).toHaveLength(200);
    expect(entry?.reason).toHaveLength(200);
  });

  it("carga un seen.json antiguo sin los campos nuevos", () => {
    writeFileSync(
      join(dir, "seen.json"),
      JSON.stringify({
        "job-1": { firstSeen: "2024-01-01T00:00:00.000Z", score: 7, notified: false },
      }),
      "utf8",
    );

    const store = new SeenStore(dir);
    store.load();
    expect(store.has("job-1")).toBe(true);

    store.mark("job-1", { notified: true });
    store.save();

    expect(readSeen()["job-1"]).toMatchObject({
      firstSeen: "2024-01-01T00:00:00.000Z",
      score: 7,
      notified: true,
    });
  });

  it("escribe de forma atómica sin dejar ficheros temporales", () => {
    const store = new SeenStore(dir);
    store.load();
    store.mark("job-1");
    store.save();

    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(() => readSeen()).not.toThrow();
  });

  it("renombra un seen.json corrupto y empieza vacío", () => {
    writeFileSync(join(dir, "seen.json"), "esto no es json", "utf8");

    const store = new SeenStore(dir);
    store.load();

    expect(store.has("job-1")).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith("seen.corrupt-"))).toBe(true);

    store.mark("job-1");
    store.save();
    expect(readSeen()["job-1"]).toBeDefined();
  });

  it("en modo readOnly empieza vacío sin renombrar un seen.json corrupto", () => {
    writeFileSync(join(dir, "seen.json"), "esto no es json", "utf8");

    const store = new SeenStore(dir);
    store.load({ readOnly: true });

    expect(store.has("job-1")).toBe(false);
    expect(readFileSync(join(dir, "seen.json"), "utf8")).toBe("esto no es json");
    expect(readdirSync(dir).some((name) => name.startsWith("seen.corrupt-"))).toBe(false);
  });

  it("lanza si no puede apartar un seen.json corrupto", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      writeFileSync(join(dir, "seen.json"), "esto no es json", "utf8");
      mkdirSync(join(dir, "seen.corrupt-1700000000000.json"));

      const store = new SeenStore(dir);

      expect(() => store.load()).toThrow();
      expect(readFileSync(join(dir, "seen.json"), "utf8")).toBe("esto no es json");
    } finally {
      now.mockRestore();
    }
  });
});

describe("lock", () => {
  it("crea el lock con un token único y rechaza una segunda ejecución", () => {
    const token = acquireLock(dir);
    expect(token).toContain(`${process.pid}:`);
    expect(readFileSync(join(dir, "run.lock"), "utf8")).toBe(token);
    expect(() => acquireLock(dir)).toThrow("otra ejecución en curso");

    releaseLock(dir, token);
    expect(existsSync(join(dir, "run.lock"))).toBe(false);
    expect(() => acquireLock(dir)).not.toThrow();
  });

  it("no borra el lock si el token no coincide", () => {
    const token = acquireLock(dir);

    releaseLock(dir, `${token}-otro`);

    expect(existsSync(join(dir, "run.lock"))).toBe(true);
    releaseLock(dir, token);
    expect(existsSync(join(dir, "run.lock"))).toBe(false);
  });

  it("borra el lock si falla la escritura del token", () => {
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("fallo al escribir el token");
    });

    expect(() => acquireLock(dir)).toThrow("fallo al escribir el token");
    expect(existsSync(join(dir, "run.lock"))).toBe(false);
  });

  it("sustituye un lock con más de 2 horas", () => {
    acquireLock(dir);
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(join(dir, "run.lock"), old, old);

    expect(() => acquireLock(dir)).not.toThrow();
    expect(existsSync(join(dir, "run.lock"))).toBe(true);
  });
});

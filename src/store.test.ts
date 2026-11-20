import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, releaseLock, SeenStore, type SeenData } from "./store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "radar-empleo-store-"));
});

afterEach(() => {
  releaseLock(dir);
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
});

describe("lock", () => {
  it("crea el lock y rechaza una segunda ejecución", () => {
    acquireLock(dir);
    expect(existsSync(join(dir, "run.lock"))).toBe(true);
    expect(() => acquireLock(dir)).toThrow("otra ejecución en curso");

    releaseLock(dir);
    expect(existsSync(join(dir, "run.lock"))).toBe(false);
    expect(() => acquireLock(dir)).not.toThrow();
  });

  it("sustituye un lock con más de 2 horas", () => {
    acquireLock(dir);
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(join(dir, "run.lock"), old, old);

    expect(() => acquireLock(dir)).not.toThrow();
    expect(existsSync(join(dir, "run.lock"))).toBe(true);
  });
});

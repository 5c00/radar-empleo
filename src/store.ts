import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const SEEN_FILE = "seen.json";
const LOCK_FILE = "run.lock";

export interface SeenEntry {
  firstSeen: string;
  score?: number;
  notified?: boolean;
}

export type SeenData = Record<string, SeenEntry>;

export interface SeenEntryInput {
  score?: number;
  notified?: boolean;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isSeenData(value: unknown): value is SeenData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  return Object.values(value).every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { firstSeen?: unknown }).firstSeen === "string",
  );
}

export class SeenStore {
  private readonly filePath: string;
  private entries: SeenData = {};

  constructor(dataDir: string) {
    this.filePath = join(dataDir, SEEN_FILE);
  }

  load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        this.entries = {};
        return;
      }
      throw error;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isSeenData(parsed)) throw new Error("estructura de seen.json inválida");
      this.entries = parsed;
    } catch {
      this.backupCorrupt();
      this.entries = {};
    }
  }

  has(key: string): boolean {
    return Object.hasOwn(this.entries, key);
  }

  mark(key: string, data: SeenEntryInput = {}): void {
    const existing = this.entries[key];
    this.entries = {
      ...this.entries,
      [key]: {
        firstSeen: existing?.firstSeen ?? new Date().toISOString(),
        ...(existing?.score !== undefined ? { score: existing.score } : {}),
        ...(existing?.notified !== undefined ? { notified: existing.notified } : {}),
        ...(data.score !== undefined ? { score: data.score } : {}),
        ...(data.notified !== undefined ? { notified: data.notified } : {}),
      },
    };
  }

  save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(this.entries, null, 2), "utf8");
    renameSync(tempPath, this.filePath);
  }

  private backupCorrupt(): void {
    const backupPath = join(dirname(this.filePath), `seen.corrupt-${Date.now()}.json`);
    try {
      renameSync(this.filePath, backupPath);
    } catch {
      // The file may have disappeared between detection and rename; start empty either way.
    }
  }
}

function lockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILE);
}

function createLockFile(path: string): void {
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, String(Date.now()), "utf8");
  } finally {
    closeSync(fd);
  }
}

export function acquireLock(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const path = lockPath(dataDir);

  try {
    createLockFile(path);
    return;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }

  const ageMs = Date.now() - statSync(path).mtimeMs;
  if (ageMs < LOCK_MAX_AGE_MS) throw new Error("otra ejecución en curso");

  unlinkSync(path);
  createLockFile(path);
}

export function releaseLock(dataDir: string): void {
  try {
    unlinkSync(lockPath(dataDir));
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

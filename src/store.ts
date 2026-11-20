import { randomUUID } from "node:crypto";
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
import { z } from "zod";

const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_STORED_TEXT_LENGTH = 200;
const SEEN_FILE = "seen.json";
const LOCK_FILE = "run.lock";

const seenEntrySchema = z.object({
  firstSeen: z.string(),
  score: z.number().optional(),
  notified: z.boolean().optional(),
  reason: z.string().optional(),
  scoredBy: z.enum(["llm", "rules"]).optional(),
  company: z.string().optional(),
  title: z.string().optional(),
});

export interface SeenEntry {
  firstSeen: string;
  score?: number;
  notified?: boolean;
  reason?: string;
  scoredBy?: "llm" | "rules";
  company?: string;
  title?: string;
}

export type SeenData = Record<string, SeenEntry>;

export interface SeenEntryInput {
  score?: number;
  notified?: boolean;
  reason?: string;
  scoredBy?: "llm" | "rules";
  company?: string;
  title?: string;
}

export interface SeenLoadOptions {
  readOnly?: boolean;
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

  return Object.values(value).every((entry) => seenEntrySchema.safeParse(entry).success);
}

function truncate(value: string): string {
  return value.length > MAX_STORED_TEXT_LENGTH ? value.slice(0, MAX_STORED_TEXT_LENGTH) : value;
}

export class SeenStore {
  private readonly filePath: string;
  private entries: SeenData = {};

  constructor(dataDir: string) {
    this.filePath = join(dataDir, SEEN_FILE);
  }

  load({ readOnly = false }: SeenLoadOptions = {}): void {
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
      if (!readOnly) this.backupCorrupt();
      this.entries = {};
    }
  }

  has(key: string): boolean {
    return Object.hasOwn(this.entries, key);
  }

  mark(key: string, data: SeenEntryInput = {}): void {
    const existing = this.entries[key];
    const merged: SeenEntry = {
      ...(existing ?? {}),
      firstSeen: existing?.firstSeen ?? new Date().toISOString(),
      ...(data.score !== undefined ? { score: data.score } : {}),
      ...(data.notified !== undefined ? { notified: data.notified } : {}),
      ...(data.reason !== undefined ? { reason: truncate(data.reason) } : {}),
      ...(data.scoredBy !== undefined ? { scoredBy: data.scoredBy } : {}),
      ...(data.company !== undefined ? { company: truncate(data.company) } : {}),
      ...(data.title !== undefined ? { title: truncate(data.title) } : {}),
    };
    this.entries = { ...this.entries, [key]: merged };
  }

  save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(this.entries, null, 2), "utf8");
    renameSync(tempPath, this.filePath);
  }

  private backupCorrupt(): void {
    const backupPath = join(dirname(this.filePath), `seen.corrupt-${Date.now()}.json`);
    renameSync(this.filePath, backupPath);
  }
}

function lockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILE);
}

function createLockFile(path: string): string {
  const token = `${process.pid}:${randomUUID()}`;
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, token, "utf8");
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Keep the original write error.
    }
    try {
      unlinkSync(path);
    } catch {
      // Keep the original write error.
    }
    throw error;
  }
  closeSync(fd);
  return token;
}

export function acquireLock(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const path = lockPath(dataDir);

  try {
    return createLockFile(path);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }

  const ageMs = Date.now() - statSync(path).mtimeMs;
  if (ageMs < LOCK_MAX_AGE_MS) throw new Error("otra ejecución en curso");

  unlinkSync(path);
  return createLockFile(path);
}

export function releaseLock(dataDir: string, token: string): void {
  const path = lockPath(dataDir);

  let current: string;
  try {
    current = readFileSync(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }

  if (current !== token) return;

  try {
    unlinkSync(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

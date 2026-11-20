import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Job } from "../types.js";

export interface JobspyConfig {
  searches: string[];
  sites: ("indeed" | "glassdoor" | "linkedin")[];
  resultsWanted: number;
  hoursOld: number;
  country: string;
}

export interface RunJobspyOptions {
  pythonBin?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

const SCRIPT_PATH = fileURLToPath(new URL("../../jobspy/scrape.py", import.meta.url));
const MAX_STDERR_BYTES = 64 * 1024;

const jobspyItemSchema = z.object({
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().nullish(),
  job_url: z.string().min(1),
  is_remote: z.boolean().nullish(),
  date_posted: z.string().nullish(),
  description: z.string().nullish(),
});

export function parseJobspyOutput(stdout: string): Job[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const jobs: Job[] = [];
  for (const item of data) {
    const parsed = jobspyItemSchema.safeParse(item);
    if (!parsed.success) continue;

    const value = parsed.data;
    jobs.push({
      id: `jobspy:${value.job_url}`,
      source: "jobspy",
      company: value.company,
      title: value.title,
      location: value.location ?? "",
      remote: value.is_remote === true,
      url: value.job_url,
      ...(value.date_posted ? { postedAt: value.date_posted } : {}),
      ...(value.description ? { description: value.description } : {}),
    });
  }

  return jobs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runJobspy(
  config: JobspyConfig,
  {
    pythonBin = process.env.PYTHON_BIN ?? "python3",
    timeoutMs = 120_000,
    maxBytes = 5_000_000,
  }: RunJobspyOptions = {},
): Promise<Job[]> {
  return new Promise<Job[]>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(pythonBin, [SCRIPT_PATH], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      console.warn(`jobspy no se pudo ejecutar: ${errorMessage(error)}`);
      resolve([]);
      return;
    }

    let done = false;
    let stdout = "";
    let stderr = "";
    let bytes = 0;

    const finish = (jobs: Job[], warning?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (warning) console.warn(warning);
      resolve(jobs);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish([], `jobspy superó el timeout de ${timeoutMs} ms`);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill("SIGKILL");
        finish([], `jobspy superó el límite de ${maxBytes} bytes de salida`);
        return;
      }
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length >= MAX_STDERR_BYTES) return;
      stderr += chunk.toString().slice(0, MAX_STDERR_BYTES - stderr.length);
    });

    child.on("error", (error) => {
      finish([], `jobspy no se pudo ejecutar: ${errorMessage(error)}`);
    });

    child.on("close", (code) => {
      if (done) return;
      if (code !== 0) {
        finish([], `jobspy terminó con código ${code}: ${stderr.trim()}`);
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        finish([], "jobspy no devolvió salida");
        return;
      }

      try {
        JSON.parse(trimmed);
      } catch {
        finish([], "la salida de jobspy no es JSON válido");
        return;
      }

      finish(parseJobspyOutput(trimmed));
    });

    child.stdin.on("error", () => {
      // The child may exit before reading stdin; the close handler reports the failure.
    });
    child.stdin.end(JSON.stringify(config));
  });
}

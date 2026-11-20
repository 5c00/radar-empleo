import { z } from "zod";
import type { ScoredJob } from "./score.js";

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_COMPANY_LENGTH = 100;
const MAX_TITLE_LENGTH = 200;
const MAX_LOCATION_LENGTH = 100;
const MAX_REASON_LENGTH = 200;
const TELEGRAM_TIMEOUT_MS = 15_000;
const TELEGRAM_API_BASE = "https://api.telegram.org";

const telegramResponseSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
});

export interface SendTelegramOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface DigestChunk {
  text: string;
  jobs: ScoredJob[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }

  return escapeHtml(trimmed);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function formatJob(job: ScoredJob): string {
  const company = truncate(job.company, MAX_COMPANY_LENGTH);
  const title = truncate(job.title, MAX_TITLE_LENGTH);
  const location = truncate(job.location.trim(), MAX_LOCATION_LENGTH);
  const reason = truncate(job.reason, MAX_REASON_LENGTH);
  const locationSuffix = job.remote ? (location ? " (remoto)" : "(remoto)") : "";
  const lines = [`<b>${escapeHtml(company)}</b> — ${escapeHtml(title)}`];

  if (location || job.remote) {
    lines.push(`${escapeHtml(location)}${locationSuffix}`);
  }

  lines.push(`Nota: ${job.score}/10 — ${escapeHtml(reason)}`);

  const url = escapeUrl(job.url);
  if (url) lines.push(`<a href="${url}">Ver oferta</a>`);

  return lines.join("\n");
}

export function formatDigestChunks(jobs: ScoredJob[], date: string): DigestChunk[] {
  const header = `🎯 Radar de empleo — ${escapeHtml(date)} — ${jobs.length} ofertas`;
  const chunks: DigestChunk[] = [];
  let current = header;
  let currentJobs: ScoredJob[] = [];
  let currentHasOffers = false;

  for (const job of jobs) {
    const block = formatJob(job);
    const candidate = `${current}\n\n${block}`;

    if (candidate.length <= MAX_MESSAGE_LENGTH) {
      current = candidate;
      currentJobs.push(job);
      currentHasOffers = true;
      continue;
    }

    if (!currentHasOffers) {
      chunks.push({ text: header, jobs: [] });
      current = block;
      currentJobs = [job];
      currentHasOffers = true;
      continue;
    }

    chunks.push({ text: current, jobs: currentJobs });
    current = block;
    currentJobs = [job];
  }

  chunks.push({ text: current, jobs: currentJobs });
  return chunks;
}

export function formatDigest(jobs: ScoredJob[], date: string): string[] {
  return formatDigestChunks(jobs, date).map((chunk) => chunk.text);
}

function sanitize(message: string, token: string): string {
  return message.split(token).join("***");
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function sendMessage(
  text: string,
  token: string,
  chatId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const endpoint = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`telegram: fallo de red: ${sanitize(message, token)}`);
  }

  const payload = await readPayload(response);
  const parsed = telegramResponseSchema.safeParse(payload);
  const description =
    parsed.success && parsed.data.description ? sanitize(parsed.data.description, token) : "";
  const suffix = description ? `: ${description}` : "";

  if (!response.ok) {
    throw new Error(`telegram: error HTTP ${response.status}${suffix}`);
  }

  if (!parsed.success) {
    throw new Error("telegram: respuesta no válida");
  }

  if (parsed.data.ok !== true) {
    throw new Error(`telegram: error${suffix}`);
  }
}

export async function sendTelegram(
  messages: string[],
  opts: SendTelegramOptions = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();

  if (!token) throw new Error("telegram: falta TELEGRAM_BOT_TOKEN en el entorno");
  if (!chatId) throw new Error("telegram: falta TELEGRAM_CHAT_ID en el entorno");

  for (const message of messages) {
    await sendMessage(message, token, chatId, fetchImpl);
  }
}

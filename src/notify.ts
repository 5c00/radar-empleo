import type { ScoredJob } from "./score.js";

const MAX_MESSAGE_LENGTH = 4_000;
const TELEGRAM_TIMEOUT_MS = 15_000;
const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface SendTelegramOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
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

function formatJob(job: ScoredJob): string {
  const location = job.location.trim();
  const locationSuffix = job.remote ? (location ? " (remoto)" : "(remoto)") : "";
  const lines = [`<b>${escapeHtml(job.company)}</b> — ${escapeHtml(job.title)}`];

  if (location || job.remote) {
    lines.push(`${escapeHtml(location)}${locationSuffix}`);
  }

  lines.push(`Nota: ${job.score}/10 — ${escapeHtml(job.reason)}`);

  const url = escapeUrl(job.url);
  if (url) lines.push(`<a href="${url}">Ver oferta</a>`);

  return lines.join("\n");
}

export function formatDigest(jobs: ScoredJob[], date: string): string[] {
  const header = `🎯 Radar de empleo — ${escapeHtml(date)} — ${jobs.length} ofertas`;
  const messages: string[] = [];
  let current = header;
  let currentHasOffers = false;

  for (const job of jobs) {
    const block = formatJob(job);
    const candidate = `${current}\n\n${block}`;

    if (candidate.length <= MAX_MESSAGE_LENGTH) {
      current = candidate;
      currentHasOffers = true;
      continue;
    }

    if (!currentHasOffers) {
      messages.push(header);
      current = block;
      currentHasOffers = true;
      continue;
    }

    messages.push(current);
    current = block;
  }

  messages.push(current);
  return messages;
}

function sanitize(message: string, token: string): string {
  return message.split(token).join("***");
}

async function readDescription(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null) return "";

    const description = (payload as { description?: unknown }).description;
    return typeof description === "string" ? description : "";
  } catch {
    return "";
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

  if (!response.ok) {
    const description = sanitize(await readDescription(response), token);
    const suffix = description ? `: ${description}` : "";
    throw new Error(`telegram: error HTTP ${response.status}${suffix}`);
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

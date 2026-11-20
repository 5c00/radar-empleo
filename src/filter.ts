import { DEFAULT_REMOTE_OK, type Profile } from "./profile.js";
import type { Job } from "./types.js";

const TRACKING_PARAMS = new Set([
  "ref",
  "source",
  "src",
  "gh_src",
  "lever-source",
  "lever-origin",
  "fbclid",
  "gclid",
]);

function isTrackingParam(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "utm" || normalized.startsWith("utm_") || TRACKING_PARAMS.has(normalized);
}

export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const params = [...parsed.searchParams.entries()]
      .filter(([name]) => !isTrackingParam(name))
      .sort(([aName, aValue], [bName, bValue]) => {
        if (aName !== bName) return aName < bName ? -1 : 1;
        if (aValue === bValue) return 0;
        return aValue < bValue ? -1 : 1;
      });
    const search = new URLSearchParams(params).toString();
    return `${parsed.protocol}//${parsed.host}${pathname}${search ? `?${search}` : ""}`;
  } catch {
    return trimmed
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "");
  }
}

export function dedupeKey(job: Job): string {
  return normalizeUrl(job.url);
}

export function titleKey(job: Job): string {
  return `${job.company} ${job.title}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPattern(term: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, "iu");
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const LOCATION_STOP_WORDS = new Set([
  "in",
  "at",
  "on",
  "of",
  "and",
  "or",
  "the",
  "only",
  "based",
  "within",
  "across",
  "from",
  "to",
  "all",
  "fully",
  "100",
]);

function remoteLocationOk(
  location: string,
  locationTerms: string[],
  remoteTerms: string[],
): boolean {
  const normalized = normalizeText(location);
  if (normalized === "") return true;
  if (locationTerms.some((term) => normalized.includes(term))) return true;

  const allowed = new Set(
    [...locationTerms, ...remoteTerms]
      .flatMap((term) => term.split(/\s+/))
      .filter((token) => token !== ""),
  );
  const tokens = normalized.split(/[^a-z0-9#+.]+/).filter((token) => token !== "");
  return tokens.length > 0 && tokens.every((token) => allowed.has(token) || LOCATION_STOP_WORDS.has(token));
}

function isApplied(job: Job, applied: string[]): boolean {
  const company = job.company.trim().toLowerCase();
  const url = normalizeUrl(job.url);

  return applied.some((entry) => {
    const value = entry.trim();
    if (!value) return false;
    if (value.toLowerCase() === company) return true;
    return /^https?:\/\//i.test(value) && normalizeUrl(value) === url;
  });
}

const EXPERIENCE_REQUIREMENT_PATTERNS: readonly RegExp[] = [
  /(\d{1,2})\s*\+\s*(?:years?|yrs?)\b/g,
  /\+\s*(\d{1,2})\s*(?:years?|yrs?)\b/g,
  /at\s+least\s+(\d{1,2})\s*(?:years?|yrs?)\b/g,
  /minimum\s+(?:of\s+)?(\d{1,2})\s*(?:years?|yrs?)\b/g,
  /(\d{1,2})\s+or\s+more\s+(?:years?|yrs?)\b/g,
  /over\s+(\d{1,2})\s*(?:years?|yrs?)\b/g,
  /(\d{1,2})\s*(?:years?|yrs?)['’]?\s+(?:of\s+)?experience\b/g,
  /(\d{1,2})\s*[-–]\s*\d{1,2}\s*(?:years?|yrs?)\b/g,
  /(\d{1,2})\s*anos?\s+de\s+experiencia\b/g,
  /al\s+menos\s+(\d{1,2})\s*anos?\b/g,
  /minimo\s+(?:de\s+)?(\d{1,2})\s*anos?\b/g,
  /mas\s+de\s+(\d{1,2})\s*anos?\b(?!\s+(?:en\s+el\s+mercado|en\s+el\s+sector|de\s+mercado|en\s+funcionamiento|de\s+trayectoria|en\s+la\s+industria|operando))/g,
  /\+\s*(\d{1,2})\s*anos?\b/g,
  /(\d{1,2})\s*\+\s*anos?\b/g,
];

function requiredYears(text: string): number | null {
  const normalized = normalizeText(text);
  let required: number | null = null;

  for (const pattern of EXPERIENCE_REQUIREMENT_PATTERNS) {
    for (const match of normalized.matchAll(pattern)) {
      const raw = match[1];
      if (raw === undefined) continue;
      const value = Number(raw);
      if (required === null || value > required) required = value;
    }
  }

  return required;
}

function appliedNamePatterns(applied: string[]): RegExp[] {
  return applied
    .map((entry) => entry.trim())
    .filter((value) => value !== "" && !/^https?:\/\//i.test(value))
    .map((value) => termPattern(normalizeText(value)));
}

export function filterJobs(jobs: Job[], profile: Profile): Job[] {
  const includeTitle = profile.includeTitle.map((term) => termPattern(term));
  const excludeTitle = profile.excludeTitle.map((term) => termPattern(term));
  const excludeText = profile.excludeText.map((term) => termPattern(term));
  const locationOk = profile.locationOk.map((term) => normalizeText(term)).filter(Boolean);
  const remoteOk = (profile.remoteOk ?? DEFAULT_REMOTE_OK)
    .map((term) => normalizeText(term))
    .filter(Boolean);
  const appliedNames = appliedNamePatterns(profile.applied);

  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const result: Job[] = [];

  for (const job of jobs) {
    if (!matchesAny(job.title, includeTitle)) continue;
    if (matchesAny(job.title, excludeTitle)) continue;

    const location = normalizeText(job.location);
    if (job.remote) {
      if (!remoteLocationOk(job.location, locationOk, remoteOk)) continue;
    } else if (!locationOk.some((term) => location.includes(term))) {
      continue;
    }

    if (matchesAny(job.description ?? "", excludeText)) continue;

    const maxYearsRequired = profile.maxYearsRequired;
    if (maxYearsRequired !== undefined) {
      const required = requiredYears(`${job.title} ${job.description ?? ""}`);
      if (required !== null && required > maxYearsRequired) continue;
    }

    if (isApplied(job, profile.applied)) continue;
    if (matchesAny(normalizeText(job.description ?? ""), appliedNames)) continue;

    const urlKey = dedupeKey(job);
    const companyTitleKey = titleKey(job);
    if (seenUrls.has(urlKey) || seenTitles.has(companyTitleKey)) continue;

    seenUrls.add(urlKey);
    seenTitles.add(companyTitleKey);
    result.push(job);
  }

  return result;
}

export function preScore(job: Job, profile: Profile): number {
  const title = job.title.toLowerCase();
  let score = 0;

  for (const term of profile.includeTitle) {
    if (title.includes(term.toLowerCase())) score += 2;
  }
  if (job.remote) score += 1;

  return score;
}

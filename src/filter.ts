import type { Profile } from "./profile.js";
import type { Job } from "./types.js";

export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${pathname}`;
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

export function filterJobs(jobs: Job[], profile: Profile): Job[] {
  const includeTitle = profile.includeTitle.map((term) => term.toLowerCase());
  const excludeTitle = profile.excludeTitle.map((term) => term.toLowerCase());
  const locationOk = profile.locationOk.map((term) => term.toLowerCase());
  const excludeText = profile.excludeText.map((term) => term.toLowerCase());

  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const result: Job[] = [];

  for (const job of jobs) {
    const title = job.title.toLowerCase();
    if (!includeTitle.some((term) => title.includes(term))) continue;
    if (excludeTitle.some((term) => title.includes(term))) continue;

    const location = job.location.toLowerCase();
    if (!job.remote && !locationOk.some((term) => location.includes(term))) continue;

    const description = (job.description ?? "").toLowerCase();
    if (excludeText.some((term) => description.includes(term))) continue;

    if (isApplied(job, profile.applied)) continue;

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

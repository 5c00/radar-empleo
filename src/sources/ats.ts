import { z } from "zod";
import type { Job } from "../types.js";

const ATS_TIMEOUT_MS = 15_000;

export type AtsKind = "ashby" | "greenhouse" | "lever" | "workable" | "personio" | "recruitee";

export interface AtsInfo {
  kind: AtsKind;
  id: string;
  tld?: "de" | "com";
}

export interface Company {
  name: string;
  url: string;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SourceError {
  company: string;
  url: string;
  error: string;
}

export interface FetchAllAtsOptions {
  concurrency?: number;
  fetchImpl?: FetchLike;
}

export interface FetchAllAtsResult {
  jobs: Job[];
  errors: SourceError[];
  coverage: Record<AtsKind | "unsupported", number>;
}

const ATS_KINDS: AtsKind[] = [
  "ashby",
  "greenhouse",
  "lever",
  "workable",
  "personio",
  "recruitee",
];

export function detectAts(url: string): AtsInfo | null {
  const ashby = url.match(/ashbyhq\.com\/([^/?#]+)/);
  if (ashby?.[1]) return { kind: "ashby", id: ashby[1] };

  const greenhouse = url.match(/greenhouse\.io\/([^/?#]+)/);
  if (greenhouse?.[1] && greenhouse[1] !== "embed") {
    return { kind: "greenhouse", id: greenhouse[1] };
  }

  const lever = url.match(/lever\.co\/([^/?#]+)/);
  if (lever?.[1]) return { kind: "lever", id: lever[1] };

  const workable = url.match(/apply\.workable\.com\/([^/?#]+)/);
  if (workable?.[1]) return { kind: "workable", id: workable[1] };

  const personio = url.match(/([a-z0-9-]+)\.jobs\.personio\.(de|com)/);
  if (personio?.[1] && (personio[2] === "de" || personio[2] === "com")) {
    return { kind: "personio", id: personio[1], tld: personio[2] };
  }

  const recruitee = url.match(/([a-z0-9-]+)\.recruitee\.com/);
  if (recruitee?.[1]) return { kind: "recruitee", id: recruitee[1] };

  return null;
}

function looksRemote(location: string): boolean {
  return /remote|remot[oa]|teletrabajo|anywhere/i.test(location);
}

function joinLocation(...parts: (string | undefined)[]): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "name" in value) {
    const name = (value as { name?: unknown }).name;
    return typeof name === "string" ? name : "";
  }
  return "";
}

interface NewJob {
  atsId: string;
  jobId?: string;
  company: string;
  title?: string;
  location?: string;
  url?: string;
  remoteFlag?: boolean;
  postedAt?: string;
  description?: string;
}

function toJob(kind: AtsKind, input: NewJob): Job | null {
  const title = input.title?.trim();
  const url = input.url?.trim();
  if (!title || !url) return null;

  const location = input.location?.replace(/\s+/g, " ").trim() ?? "";

  return {
    id: `${kind}:${input.atsId}:${input.jobId ?? url}`,
    source: "ats",
    company: input.company,
    title,
    location,
    remote: input.remoteFlag === true || looksRemote(location),
    url,
    ...(input.postedAt ? { postedAt: input.postedAt } : {}),
    ...(input.description ? { description: input.description } : {}),
  };
}

function compact(jobs: (Job | null)[]): Job[] {
  return jobs.filter((job): job is Job => job !== null);
}

async function getJson(url: string, fetchImpl: FetchLike): Promise<unknown> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(ATS_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status} en ${url}`);
  return response.json();
}

async function getText(url: string, fetchImpl: FetchLike): Promise<string> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(ATS_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status} en ${url}`);
  return response.text();
}

function expectObject<S extends z.ZodType>(schema: S, data: unknown, label: string): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(`Respuesta ${label} inválida`);
  return result.data;
}

function parseEach<S extends z.ZodType>(schema: S, items: unknown[]): z.output<S>[] {
  const parsed: z.output<S>[] = [];
  for (const item of items) {
    const result = schema.safeParse(item);
    if (result.success) parsed.push(result.data);
  }
  return parsed;
}

const ashbyResponseSchema = z.object({ jobs: z.array(z.unknown()).default([]) });
const ashbyJobSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  location: z.string().optional(),
  isRemote: z.boolean().optional(),
  secondaryLocations: z.array(z.object({ location: z.string().optional() })).optional(),
  jobUrl: z.string().optional(),
  publishedAt: z.string().optional(),
});

const greenhouseResponseSchema = z.object({ jobs: z.array(z.unknown()).default([]) });
const greenhouseJobSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
  location: z.object({ name: z.string().optional() }).optional(),
  absolute_url: z.string().optional(),
  updated_at: z.string().optional(),
});

const leverJobSchema = z.object({
  id: z.string().optional(),
  text: z.string().optional(),
  categories: z
    .object({
      location: z.string().optional(),
      allLocations: z.array(z.string()).optional(),
    })
    .optional(),
  workplaceType: z.string().optional(),
  hostedUrl: z.string().optional(),
});

const workableResponseSchema = z.object({ jobs: z.array(z.unknown()).default([]) });
const workableJobSchema = z.object({
  shortcode: z.string().optional(),
  title: z.string().optional(),
  country: z.string().optional(),
  city: z.string().optional(),
  telecommuting: z.boolean().optional(),
  url: z.string().optional(),
  shortlink: z.string().optional(),
});

const recruiteeResponseSchema = z.object({ offers: z.array(z.unknown()).default([]) });
const recruiteeJobSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
  location: z.unknown().optional(),
  remote: z.boolean().optional(),
  careers_url: z.string().optional(),
});

async function fetchAshby(ats: AtsInfo, company: Company, fetchImpl: FetchLike): Promise<Job[]> {
  const data = expectObject(
    ashbyResponseSchema,
    await getJson(`https://api.ashbyhq.com/posting-api/job-board/${ats.id}`, fetchImpl),
    "de Ashby",
  );

  return compact(
    parseEach(ashbyJobSchema, data.jobs).map((job) => {
      const secondary = (job.secondaryLocations ?? [])
        .map((entry) => entry.location ?? "")
        .join(" ");
      return toJob("ashby", {
        atsId: ats.id,
        jobId: job.id,
        company: company.name,
        title: job.title,
        location: joinLocation(job.location, secondary, job.isRemote ? "remote" : ""),
        url: job.jobUrl,
        remoteFlag: job.isRemote,
        postedAt: job.publishedAt,
      });
    }),
  );
}

async function fetchGreenhouse(
  ats: AtsInfo,
  company: Company,
  fetchImpl: FetchLike,
): Promise<Job[]> {
  const data = expectObject(
    greenhouseResponseSchema,
    await getJson(`https://boards-api.greenhouse.io/v1/boards/${ats.id}/jobs`, fetchImpl),
    "de Greenhouse",
  );

  return compact(
    parseEach(greenhouseJobSchema, data.jobs).map((job) =>
      toJob("greenhouse", {
        atsId: ats.id,
        jobId: job.id === undefined ? undefined : String(job.id),
        company: company.name,
        title: job.title,
        location: job.location?.name,
        url: job.absolute_url,
        postedAt: job.updated_at,
      }),
    ),
  );
}

async function fetchLever(ats: AtsInfo, company: Company, fetchImpl: FetchLike): Promise<Job[]> {
  const raw = await getJson(`https://api.lever.co/v0/postings/${ats.id}?mode=json`, fetchImpl);
  if (!Array.isArray(raw)) throw new Error("Respuesta de Lever inválida");

  return compact(
    parseEach(leverJobSchema, raw).map((job) => {
      const allLocations = (job.categories?.allLocations ?? []).join(" ");
      return toJob("lever", {
        atsId: ats.id,
        jobId: job.id,
        company: company.name,
        title: job.text,
        location: joinLocation(job.categories?.location, allLocations, job.workplaceType),
        url: job.hostedUrl,
        remoteFlag: job.workplaceType?.toLowerCase() === "remote",
      });
    }),
  );
}

async function fetchWorkable(ats: AtsInfo, company: Company, fetchImpl: FetchLike): Promise<Job[]> {
  const data = expectObject(
    workableResponseSchema,
    await getJson(`https://apply.workable.com/api/v1/widget/accounts/${ats.id}`, fetchImpl),
    "de Workable",
  );

  return compact(
    parseEach(workableJobSchema, data.jobs).map((job) =>
      toJob("workable", {
        atsId: ats.id,
        jobId: job.shortcode,
        company: company.name,
        title: job.title,
        location: joinLocation(job.country, job.city, job.telecommuting ? "remote" : ""),
        url: job.url ?? job.shortlink,
        remoteFlag: job.telecommuting,
      }),
    ),
  );
}

async function fetchRecruitee(
  ats: AtsInfo,
  company: Company,
  fetchImpl: FetchLike,
): Promise<Job[]> {
  const data = expectObject(
    recruiteeResponseSchema,
    await getJson(`https://${ats.id}.recruitee.com/api/offers/`, fetchImpl),
    "de Recruitee",
  );

  return compact(
    parseEach(recruiteeJobSchema, data.offers).map((job) =>
      toJob("recruitee", {
        atsId: ats.id,
        jobId: job.id === undefined ? undefined : String(job.id),
        company: company.name,
        title: job.title,
        location: joinLocation(text(job.location), job.remote ? "remote" : ""),
        url: job.careers_url,
        remoteFlag: job.remote,
      }),
    ),
  );
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1] ? decodeXml(match[1].trim()) : "";
}

async function fetchPersonio(
  ats: AtsInfo,
  company: Company,
  fetchImpl: FetchLike,
): Promise<Job[]> {
  const tld = ats.tld ?? "de";
  const xml = await getText(`https://${ats.id}.jobs.personio.${tld}/xml`, fetchImpl);

  const jobs: (Job | null)[] = [];
  for (const match of xml.matchAll(/<position>([\s\S]*?)<\/position>/g)) {
    const block = match[1] ?? "";
    const positionId = xmlTag(block, "id");
    if (!positionId) continue;
    jobs.push(
      toJob("personio", {
        atsId: ats.id,
        jobId: positionId,
        company: company.name,
        title: xmlTag(block, "name"),
        location: xmlTag(block, "office"),
        url: `https://${ats.id}.jobs.personio.${tld}/job/${positionId}`,
        description: xmlTag(block, "jobDescription") || undefined,
      }),
    );
  }

  return compact(jobs);
}

export async function fetchCompanyJobs(
  company: Company,
  fetchImpl: FetchLike = fetch,
): Promise<Job[]> {
  const ats = detectAts(company.url);
  if (!ats) throw new Error(`ATS no soportado para ${company.name}: ${company.url}`);

  switch (ats.kind) {
    case "ashby":
      return fetchAshby(ats, company, fetchImpl);
    case "greenhouse":
      return fetchGreenhouse(ats, company, fetchImpl);
    case "lever":
      return fetchLever(ats, company, fetchImpl);
    case "workable":
      return fetchWorkable(ats, company, fetchImpl);
    case "personio":
      return fetchPersonio(ats, company, fetchImpl);
    case "recruitee":
      return fetchRecruitee(ats, company, fetchImpl);
  }
}

function emptyCoverage(): Record<AtsKind | "unsupported", number> {
  const coverage = { unsupported: 0 } as Record<AtsKind | "unsupported", number>;
  for (const kind of ATS_KINDS) coverage[kind] = 0;
  return coverage;
}

export async function fetchAllAts(
  companies: Company[],
  { concurrency = 5, fetchImpl = fetch }: FetchAllAtsOptions = {},
): Promise<FetchAllAtsResult> {
  const jobs: Job[] = [];
  const errors: SourceError[] = [];
  const coverage = emptyCoverage();

  let next = 0;
  const workers = Math.max(1, Math.min(concurrency, companies.length));

  async function work(): Promise<void> {
    while (next < companies.length) {
      const company = companies[next];
      next += 1;
      if (!company) continue;

      const ats = detectAts(company.url);
      if (!ats) {
        coverage.unsupported += 1;
        continue;
      }

      coverage[ats.kind] += 1;
      try {
        jobs.push(...(await fetchCompanyJobs(company, fetchImpl)));
      } catch (error) {
        errors.push({
          company: company.name,
          url: company.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => work()));

  return { jobs, errors, coverage };
}

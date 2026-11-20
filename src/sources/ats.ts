import { z } from "zod";
import type { Job } from "../types.js";

const ATS_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_DESCRIPTION_LENGTH = 8_000;

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

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function firstPathSegment(parsed: URL): string | undefined {
  const segment = parsed.pathname.split("/").filter((part) => part !== "")[0];
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function detectAts(url: string): AtsInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostMatches(hostname, "ashbyhq.com")) {
    const id = firstPathSegment(parsed);
    return id ? { kind: "ashby", id } : null;
  }

  if (hostMatches(hostname, "greenhouse.io")) {
    const id = firstPathSegment(parsed);
    if (!id || id === "embed") return null;
    return { kind: "greenhouse", id };
  }

  if (hostMatches(hostname, "lever.co")) {
    const id = firstPathSegment(parsed);
    return id ? { kind: "lever", id } : null;
  }

  if (hostname === "apply.workable.com") {
    const id = firstPathSegment(parsed);
    return id ? { kind: "workable", id } : null;
  }

  const personio = hostname.match(/^([a-z0-9-]+)\.jobs\.personio\.(de|com)$/);
  if (personio?.[1] && (personio[2] === "de" || personio[2] === "com")) {
    return { kind: "personio", id: personio[1], tld: personio[2] };
  }

  const recruitee = hostname.match(/^([a-z0-9-]+)\.recruitee\.com$/);
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

function codePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : "";
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => codePoint(Number(decimal)))
    .replace(/&amp;/gi, "&");
}

function plainDescription(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const decoded = decodeHtmlEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
  const stripped = decoded
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, " ");

  const text = decodeHtmlEntities(stripped)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DESCRIPTION_LENGTH);
  return text === "" ? undefined : text;
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
    remote: input.remoteFlag !== undefined ? input.remoteFlag : looksRemote(location),
    url,
    ...(input.postedAt ? { postedAt: input.postedAt } : {}),
    ...(input.description ? { description: input.description } : {}),
  };
}

function compact(jobs: (Job | null)[]): Job[] {
  return jobs.filter((job): job is Job => job !== null);
}

async function readBody(response: Response, url: string): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new Error(`Respuesta demasiado grande (${declared} bytes) en ${url}`);
    }
  }

  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(`Respuesta demasiado grande (más de ${MAX_RESPONSE_BYTES} bytes) en ${url}`);
  }
  return body;
}

async function getJson(url: string, fetchImpl: FetchLike): Promise<unknown> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(ATS_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status} en ${url}`);

  const body = await readBody(response, url);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`JSON inválido en ${url}`);
  }
}

async function getText(url: string, fetchImpl: FetchLike): Promise<string> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(ATS_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status} en ${url}`);
  return readBody(response, url);
}

function expectObject<S extends z.ZodType>(schema: S, data: unknown, label: string): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(`Respuesta ${label} inválida`);
  return result.data;
}

function parseEach<S extends z.ZodType>(
  schema: S,
  items: unknown[],
  company: string,
): z.output<S>[] {
  const parsed: z.output<S>[] = [];
  for (const item of items) {
    const result = schema.safeParse(item);
    if (result.success) parsed.push(result.data);
  }

  const discarded = items.length - parsed.length;
  if (discarded > 0) {
    console.warn(`ats: ${company} descartó ${discarded} ofertas inválidas`);
  }

  return parsed;
}

const ashbyResponseSchema = z.object({ jobs: z.array(z.unknown()) });
const ashbyJobSchema = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  location: z.string().optional(),
  isRemote: z.boolean().optional(),
  workplaceType: z.string().optional(),
  isListed: z.boolean().optional(),
  secondaryLocations: z.array(z.object({ location: z.string().optional() })).optional(),
  jobUrl: z.string().optional(),
  publishedAt: z.string().optional(),
  descriptionPlain: z.string().optional(),
});

const greenhouseResponseSchema = z.object({ jobs: z.array(z.unknown()) });
const greenhouseJobSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
  location: z.object({ name: z.string().optional() }).optional(),
  absolute_url: z.string().optional(),
  updated_at: z.string().optional(),
  content: z.string().optional(),
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
  descriptionPlain: z.string().optional(),
});

const workableResponseSchema = z.object({ jobs: z.array(z.unknown()) });
const workableJobSchema = z.object({
  shortcode: z.string().optional(),
  title: z.string().optional(),
  country: z.string().optional(),
  city: z.string().optional(),
  telecommuting: z.boolean().optional(),
  url: z.string().optional(),
  shortlink: z.string().optional(),
  description: z.string().optional(),
});

const recruiteeResponseSchema = z.object({ offers: z.array(z.unknown()) });
const recruiteeJobSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
  location: z.unknown().optional(),
  locations: z.array(z.unknown()).optional(),
  remote: z.boolean().optional(),
  careers_url: z.string().optional(),
  description: z.string().optional(),
});

async function fetchAshby(ats: AtsInfo, company: Company, fetchImpl: FetchLike): Promise<Job[]> {
  const data = expectObject(
    ashbyResponseSchema,
    await getJson(`https://api.ashbyhq.com/posting-api/job-board/${ats.id}`, fetchImpl),
    "de Ashby",
  );

  return compact(
    parseEach(ashbyJobSchema, data.jobs, company.name)
      .filter((job) => job.isListed !== false)
      .map((job) => {
        const secondary = (job.secondaryLocations ?? [])
          .map((entry) => entry.location ?? "")
          .join(" ");
        const workplace = job.workplaceType?.trim().toLowerCase();
        const remote = workplace ? workplace === "remote" : job.isRemote === true;

        return toJob("ashby", {
          atsId: ats.id,
          jobId: job.id,
          company: company.name,
          title: job.title,
          location: joinLocation(job.location, secondary),
          url: job.jobUrl,
          remoteFlag: remote,
          postedAt: job.publishedAt,
          description: plainDescription(job.descriptionPlain),
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
    await getJson(
      `https://boards-api.greenhouse.io/v1/boards/${ats.id}/jobs?content=true`,
      fetchImpl,
    ),
    "de Greenhouse",
  );

  return compact(
    parseEach(greenhouseJobSchema, data.jobs, company.name).map((job) =>
      toJob("greenhouse", {
        atsId: ats.id,
        jobId: job.id === undefined ? undefined : String(job.id),
        company: company.name,
        title: job.title,
        location: job.location?.name,
        url: job.absolute_url,
        postedAt: job.updated_at,
        description: plainDescription(job.content),
      }),
    ),
  );
}

async function fetchLever(ats: AtsInfo, company: Company, fetchImpl: FetchLike): Promise<Job[]> {
  const raw = await getJson(`https://api.lever.co/v0/postings/${ats.id}?mode=json`, fetchImpl);
  if (!Array.isArray(raw)) throw new Error("Respuesta de Lever inválida");

  return compact(
    parseEach(leverJobSchema, raw, company.name).map((job) => {
      const allLocations = (job.categories?.allLocations ?? []).join(" ");
      return toJob("lever", {
        atsId: ats.id,
        jobId: job.id,
        company: company.name,
        title: job.text,
        location: joinLocation(job.categories?.location, allLocations, job.workplaceType),
        url: job.hostedUrl,
        remoteFlag: job.workplaceType?.toLowerCase() === "remote",
        description: plainDescription(job.descriptionPlain),
      });
    }),
  );
}

async function fetchWorkable(ats: AtsInfo, company: Company, fetchImpl: FetchLike): Promise<Job[]> {
  const data = expectObject(
    workableResponseSchema,
    await getJson(
      `https://apply.workable.com/api/v1/widget/accounts/${ats.id}?details=true`,
      fetchImpl,
    ),
    "de Workable",
  );

  return compact(
    parseEach(workableJobSchema, data.jobs, company.name).map((job) =>
      toJob("workable", {
        atsId: ats.id,
        jobId: job.shortcode,
        company: company.name,
        title: job.title,
        location: joinLocation(job.country, job.city, job.telecommuting ? "remote" : ""),
        url: job.url ?? job.shortlink,
        remoteFlag: job.telecommuting,
        description: plainDescription(job.description),
      }),
    ),
  );
}

function recruiteeLocation(job: z.output<typeof recruiteeJobSchema>): string {
  const parts: string[] = [];

  for (const entry of job.locations ?? []) {
    if (typeof entry === "object" && entry !== null) {
      const record = entry as Record<string, unknown>;
      const city = typeof record.city === "string" ? record.city : "";
      const country = typeof record.country === "string" ? record.country : "";
      const name = typeof record.name === "string" ? record.name : "";
      parts.push(joinLocation(city, country) || name);
    } else {
      parts.push(text(entry));
    }
  }

  const fallback = text(job.location);
  if (fallback) parts.push(fallback);

  return joinLocation(...parts);
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
    parseEach(recruiteeJobSchema, data.offers, company.name).map((job) =>
      toJob("recruitee", {
        atsId: ats.id,
        jobId: job.id === undefined ? undefined : String(job.id),
        company: company.name,
        title: job.title,
        location: joinLocation(recruiteeLocation(job), job.remote ? "remote" : ""),
        url: job.careers_url,
        remoteFlag: job.remote,
        description: plainDescription(job.description),
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

function personioDescription(block: string): string | undefined {
  const values: string[] = [];
  for (const match of block.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/g)) {
    const value = xmlTag(match[1] ?? "", "value");
    if (value) values.push(value);
  }
  return plainDescription(values.join("\n\n"));
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
        description: personioDescription(block),
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

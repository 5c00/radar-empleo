import { describe, expect, it } from "vitest";
import {
  dedupeKey,
  filterJobs,
  normalizeUrl,
  preScore,
  titleKey,
} from "./filter.js";
import type { Profile } from "./profile.js";
import type { Job } from "./types.js";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    includeTitle: ["full stack", "react"],
    excludeTitle: ["senior"],
    locationOk: ["spain", "barcelona"],
    remoteOk: ["remote", "anywhere", "worldwide", "europe", "emea", "eu", "spain", "españa"],
    excludeText: ["degree required"],
    applied: [],
    maxPerDay: 5,
    maxScoredPerRun: 30,
    cvSummary: "Full stack developer with TypeScript and React.",
    jobspy: {
      searches: ["full stack developer"],
      resultsWanted: 20,
      hoursOld: 72,
      sites: ["indeed", "glassdoor"],
      country: "spain",
    },
    extraCompanies: [],
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "ats:example:1",
    source: "ats",
    company: "Example",
    title: "Full Stack Developer",
    location: "Barcelona, Spain",
    remote: false,
    url: "https://example.com/jobs/1",
    ...overrides,
  };
}

describe("normalizeUrl", () => {
  it("normaliza host, query, hash y barra final", () => {
    expect(normalizeUrl("HTTPS://Example.COM/Jobs/Search/?q=react#top")).toBe(
      "https://example.com/Jobs/Search?q=react",
    );
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeUrl("https://example.com/jobs/1/")).toBe("https://example.com/jobs/1");
  });

  it("conserva y ordena la query quitando solo parámetros de seguimiento", () => {
    expect(normalizeUrl("https://es.indeed.com/viewjob?jk=abc123")).toBe(
      "https://es.indeed.com/viewjob?jk=abc123",
    );
    expect(
      normalizeUrl(
        "https://example.com/jobs?b=2&utm_source=feed&a=1&gclid=x&ref=home&fbclid=y&gh_src=z",
      ),
    ).toBe("https://example.com/jobs?a=1&b=2");
    expect(normalizeUrl("https://example.com/jobs?lever-source=feed&src=mail&source=x")).toBe(
      "https://example.com/jobs",
    );
  });

  it("mantiene una cadena que no es una URL utilizable", () => {
    expect(normalizeUrl(" no-es-una-url/ ")).toBe("no-es-una-url");
  });
});

describe("dedupeKey y titleKey", () => {
  it("usa la URL normalizada como clave de deduplicado", () => {
    expect(dedupeKey(makeJob({ url: "https://example.com/jobs/1/?utm=x" }))).toBe(
      "https://example.com/jobs/1",
    );
  });

  it("normaliza empresa y título sin acentos ni espacios repetidos", () => {
    expect(titleKey(makeJob({ company: "Ejemplo  S.A.", title: "Desarrollador  Sénior" }))).toBe(
      "ejemplo s.a. desarrollador senior",
    );
  });
});

describe("filterJobs", () => {
  it("deja pasar las ofertas que cumplen las reglas", () => {
    const jobs = filterJobs([makeJob()], makeProfile());

    expect(jobs).toHaveLength(1);
  });

  it("excluye títulos que no casan con includeTitle o que casan con excludeTitle", () => {
    const jobs = filterJobs(
      [
        makeJob({ title: "Java Developer", url: "https://example.com/jobs/2" }),
        makeJob({ title: "Senior React Developer", url: "https://example.com/jobs/3" }),
      ],
      makeProfile(),
    );

    expect(jobs).toEqual([]);
  });

  it("aplica locationOk a las ofertas presenciales", () => {
    const jobs = filterJobs(
      [
        makeJob({ company: "Berlin Co", location: "Berlin, Germany", url: "https://example.com/jobs/2" }),
        makeJob({ company: "Spain Co", location: "Madrid, Spain", url: "https://example.com/jobs/3" }),
      ],
      makeProfile(),
    );

    expect(jobs.map((job) => job.company)).toEqual(["Spain Co"]);
  });

  it("deja pasar las remotas vacías, aceptadas por locationOk o remoteOk", () => {
    const jobs = filterJobs(
      [
        makeJob({ company: "Berlin Co", location: "Berlin, Germany", remote: true, url: "https://example.com/jobs/2" }),
        makeJob({ company: "US Co", location: "Remote - US", remote: true, url: "https://example.com/jobs/3" }),
        makeJob({ company: "Spain Co", location: "Remote - Spain", remote: true, url: "https://example.com/jobs/4" }),
        makeJob({ company: "Europe Co", location: "Remote Europe", remote: true, url: "https://example.com/jobs/5" }),
        makeJob({ company: "Empty Co", location: "", remote: true, url: "https://example.com/jobs/6" }),
      ],
      makeProfile(),
    );

    expect(jobs.map((job) => job.company)).toEqual(["Spain Co", "Europe Co", "Empty Co"]);
  });

  it("excluye títulos por palabra completa sin confundir java con javascript", () => {
    const jobs = filterJobs(
      [
        makeJob({
          title: "Senior JavaScript Developer",
          url: "https://example.com/jobs/2",
        }),
        makeJob({ title: "Java Developer", url: "https://example.com/jobs/3" }),
        makeJob({ title: "Node.js Engineer", url: "https://example.com/jobs/4" }),
        makeJob({ title: "C# Developer", url: "https://example.com/jobs/5" }),
      ],
      makeProfile({ includeTitle: ["javascript", "java", "node.js", "c#"], excludeTitle: ["java"] }),
    );

    expect(jobs.map((job) => job.title)).toEqual([
      "Senior JavaScript Developer",
      "Node.js Engineer",
      "C# Developer",
    ]);
  });

  it("excluye ofertas cuya descripción contiene textos vetados", () => {
    const jobs = filterJobs(
      [
        makeJob({
          description: "This role has a Degree Required policy.",
          url: "https://example.com/jobs/2",
        }),
      ],
      makeProfile(),
    );

    expect(jobs).toEqual([]);
  });

  it("excluye empresas y URLs ya solicitadas", () => {
    const jobs = filterJobs(
      [
        makeJob({ company: "example corp", url: "https://example.com/jobs/2" }),
        makeJob({ url: "https://example.com/jobs/3?ref=feed" }),
      ],
      makeProfile({
        applied: ["Example Corp", "https://example.com/jobs/3/"],
      }),
    );

    expect(jobs).toEqual([]);
  });

  it("excluye ofertas cuya descripción menciona una empresa ya solicitada", () => {
    const jobs = filterJobs(
      [
        makeJob({
          company: "New",
          title: "Full Stack Developer A",
          description: "Somos Example Corp, buscamos developers.",
          url: "https://example.com/jobs/a",
        }),
        makeJob({
          company: "New",
          title: "Full Stack Developer B",
          description: "Example Corporation está contratando.",
          url: "https://example.com/jobs/b",
        }),
        makeJob({
          company: "New",
          title: "Full Stack Developer C",
          description: "Trabaja con ACME en remoto.",
          url: "https://example.com/jobs/c",
        }),
      ],
      makeProfile({
        applied: ["Example Corp", "https://example.com/jobs/applied", "Acme"],
      }),
    );

    expect(jobs.map((job) => job.title)).toEqual(["Full Stack Developer B"]);
  });

  it("descarta ofertas que piden más años que maxYearsRequired", () => {
    const jobs = filterJobs(
      [
        makeJob({
          company: "A",
          title: "Full Stack Developer A",
          description: "At least 3 years of experience.",
          url: "https://example.com/jobs/a",
        }),
        makeJob({
          company: "B",
          title: "Full Stack Developer B",
          description: "At least 4 years of experience.",
          url: "https://example.com/jobs/b",
        }),
        makeJob({
          company: "C",
          title: "Full Stack Developer C",
          description: "2 years of experience.",
          url: "https://example.com/jobs/c",
        }),
        makeJob({
          company: "D",
          title: "Full Stack Developer D",
          description: "5-7 years of experience.",
          url: "https://example.com/jobs/d",
        }),
      ],
      makeProfile({ maxYearsRequired: 3 }),
    );

    expect(jobs.map((job) => job.company)).toEqual(["A", "C"]);
  });

  it("detecta los formatos de experiencia en inglés y español", () => {
    const requirements = [
      "5+ years",
      "5 + years",
      "at least 5 years",
      "minimum of 5 years",
      "5 or more years",
      "over 5 years",
      "5 years of experience",
      "5 years' experience",
      "5-7 years",
      "5 años de experiencia",
      "al menos 5 años",
      "mínimo de 5 años",
      "más de 5 años",
      "+5 años",
    ];

    for (const requirement of requirements) {
      const jobs = filterJobs(
        [makeJob({ description: `Requisito: ${requirement}.` })],
        makeProfile({ maxYearsRequired: 4 }),
      );
      expect(jobs, requirement).toEqual([]);
    }
  });

  it("no cuenta años que no describen experiencia", () => {
    const texts = [
      "Founded 20 years ago.",
      "Más de 10 años en el mercado.",
      "More than 10 years in the market.",
    ];

    for (const text of texts) {
      const jobs = filterJobs(
        [makeJob({ description: text })],
        makeProfile({ maxYearsRequired: 3 }),
      );
      expect(jobs, text).toHaveLength(1);
    }
  });

  it("aplica maxYearsRequired también al título", () => {
    const jobs = filterJobs(
      [makeJob({ title: "Full Stack Developer (5+ years)" })],
      makeProfile({ maxYearsRequired: 3 }),
    );

    expect(jobs).toEqual([]);
  });

  it("no filtra por años si el perfil no define maxYearsRequired", () => {
    const jobs = filterJobs(
      [makeJob({ description: "At least 10 years of experience." })],
      makeProfile(),
    );

    expect(jobs).toHaveLength(1);
  });

  it("elimina duplicados por URL normalizada y por empresa más título", () => {
    const jobs = filterJobs(
      [
        makeJob({ url: "https://example.com/jobs/1" }),
        makeJob({ url: "https://example.com/jobs/1/?utm_source=feed" }),
        makeJob({ url: "https://example.com/other/1" }),
        makeJob({
          company: "Another",
          title: "React Developer",
          url: "https://another.example/jobs/1",
        }),
      ],
      makeProfile(),
    );

    expect(jobs.map((job) => job.url)).toEqual([
      "https://example.com/jobs/1",
      "https://another.example/jobs/1",
    ]);
  });
});

describe("preScore", () => {
  it("suma 2 por cada includeTitle que casa y 1 si es remoto", () => {
    const job = makeJob({ title: "Full Stack React Developer", remote: true });

    expect(preScore(job, makeProfile())).toBe(5);
  });

  it("no puntúa títulos que no casan", () => {
    expect(preScore(makeJob({ title: "Backend Engineer", remote: false }), makeProfile())).toBe(0);
  });
});

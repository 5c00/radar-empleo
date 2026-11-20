import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectAts,
  fetchAllAts,
  fetchCompanyJobs,
  type FetchLike,
} from "./ats.js";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url)), "utf8");
}

function staticFetch(body: string, status = 200): FetchLike {
  return async () => new Response(body, { status });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("detectAts", () => {
  it("detecta cada ATS soportado", () => {
    expect(detectAts("https://jobs.ashbyhq.com/acme")).toEqual({ kind: "ashby", id: "acme" });
    expect(detectAts("https://boards.greenhouse.io/acme")).toEqual({
      kind: "greenhouse",
      id: "acme",
    });
    expect(detectAts("https://jobs.lever.co/acme")).toEqual({ kind: "lever", id: "acme" });
    expect(detectAts("https://apply.workable.com/acme/")).toEqual({
      kind: "workable",
      id: "acme",
    });
    expect(detectAts("https://acme.jobs.personio.de")).toEqual({
      kind: "personio",
      id: "acme",
      tld: "de",
    });
    expect(detectAts("https://acme.jobs.personio.com")).toEqual({
      kind: "personio",
      id: "acme",
      tld: "com",
    });
    expect(detectAts("https://acme.recruitee.com")).toEqual({ kind: "recruitee", id: "acme" });
  });

  it("ignora el id embed de Greenhouse y URLs desconocidas", () => {
    expect(detectAts("https://boards.greenhouse.io/embed/job_board?for=acme")).toBeNull();
    expect(detectAts("https://example.com/careers")).toBeNull();
  });

  it("decide por hostname y no por subcadena en la URL", () => {
    expect(detectAts("https://otro.example/boards.greenhouse.io/acme")).toBeNull();
    expect(detectAts("https://evilgreenhouse.io/acme")).toBeNull();
    expect(detectAts("https://greenhouse.io.evil.example/acme")).toBeNull();
  });
});

describe("fetchCompanyJobs", () => {
  it("normaliza Ashby y marca remoto solo con workplaceType Remote", async () => {
    const jobs = await fetchCompanyJobs(
      { name: "Example", url: "https://jobs.ashbyhq.com/example-inc" },
      staticFetch(fixture("ashby.json")),
    );

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      id: "ashby:example-inc:ashby-1",
      source: "ats",
      company: "Example",
      title: "Full Stack Engineer",
      location: "Barcelona, Spain Remote Europe",
      remote: false,
      url: "https://jobs.ashbyhq.com/example-inc/ashby-1",
      postedAt: "2026-11-10T09:00:00Z",
      description: "Build web apps with TypeScript and React.",
    });
    expect(jobs[1]).toMatchObject({
      id: "ashby:example-inc:ashby-2",
      remote: true,
      description: "Design and operate Node.js services.",
    });
  });

  it("normaliza Greenhouse con descripción HTML escapada", async () => {
    const jobs = await fetchCompanyJobs(
      { name: "Example", url: "https://boards.greenhouse.io/exampleinc" },
      staticFetch(fixture("greenhouse.json")),
    );

    expect(jobs).toEqual([
      expect.objectContaining({
        id: "greenhouse:exampleinc:101",
        title: "Frontend Engineer",
        location: "Remote - Spain",
        remote: true,
        url: "https://boards.greenhouse.io/exampleinc/jobs/101",
        description: "Build web apps & APIs.",
      }),
    ]);
  });

  it("normaliza Lever usando workplaceType y descriptionPlain", async () => {
    const jobs = await fetchCompanyJobs(
      { name: "Example", url: "https://jobs.lever.co/example" },
      staticFetch(fixture("lever.json")),
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: "lever:example:lever-1",
      title: "Software Engineer",
      remote: true,
      url: "https://jobs.lever.co/example/lever-1",
      description: "Work on our product with TypeScript.",
    });
  });

  it("normaliza Workable con descripción", async () => {
    const jobs = await fetchCompanyJobs(
      { name: "Example", url: "https://apply.workable.com/example/" },
      staticFetch(fixture("workable.json")),
    );

    expect(jobs).toEqual([
      expect.objectContaining({
        id: "workable:example:abc123",
        title: "Junior Full Stack Developer",
        location: "Spain Barcelona remote",
        remote: true,
        url: "https://apply.workable.com/example/j/abc123/",
        description: "Join our & team.",
      }),
    ]);
  });

  it("normaliza Recruitee usando locations[] y location como respaldo", async () => {
    const jobs = await fetchCompanyJobs(
      { name: "Example", url: "https://example.recruitee.com" },
      staticFetch(fixture("recruitee.json")),
    );

    expect(jobs).toEqual([
      expect.objectContaining({
        id: "recruitee:example:9001",
        title: "TypeScript Developer",
        location: "Barcelona Spain remote",
        remote: true,
        description: "Build web apps.",
      }),
      expect.objectContaining({
        id: "recruitee:example:9002",
        title: "Backend Developer",
        location: "Madrid, Spain",
        remote: false,
      }),
    ]);
  });

  it("normaliza el XML de Personio y concatena sus descripciones", async () => {
    const jobs = await fetchCompanyJobs(
      { name: "Example", url: "https://example.jobs.personio.de" },
      staticFetch(fixture("personio.xml")),
    );

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      id: "personio:example:12345",
      title: "Full Stack Developer",
      url: "https://example.jobs.personio.de/job/12345",
      remote: false,
      description: "Build web apps & APIs. TypeScript React",
    });
    expect(jobs[1]).toMatchObject({ id: "personio:example:67890", remote: true });
  });

  it("pide el contenido de Greenhouse y Workable con los parámetros correctos", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      urls.push(String(input));
      return new Response('{"jobs":[]}', { status: 200 });
    };

    await fetchCompanyJobs({ name: "Example", url: "https://boards.greenhouse.io/example" }, fetchImpl);
    await fetchCompanyJobs({ name: "Example", url: "https://apply.workable.com/example/" }, fetchImpl);

    expect(urls[0]).toContain("content=true");
    expect(urls[1]).toContain("details=true");
  });

  it("rechaza respuestas sin la lista esperada", async () => {
    await expect(
      fetchCompanyJobs(
        { name: "Example", url: "https://jobs.ashbyhq.com/example" },
        staticFetch("{}"),
      ),
    ).rejects.toThrow(/Respuesta de Ashby inválida/);
    await expect(
      fetchCompanyJobs(
        { name: "Example", url: "https://boards.greenhouse.io/example" },
        staticFetch("{}"),
      ),
    ).rejects.toThrow(/Respuesta de Greenhouse inválida/);
    await expect(
      fetchCompanyJobs(
        { name: "Example", url: "https://apply.workable.com/example/" },
        staticFetch("{}"),
      ),
    ).rejects.toThrow(/Respuesta de Workable inválida/);
    await expect(
      fetchCompanyJobs(
        { name: "Example", url: "https://example.recruitee.com" },
        staticFetch("{}"),
      ),
    ).rejects.toThrow(/Respuesta de Recruitee inválida/);
  });

  it("avisa cuando descarta ofertas inválidas", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = JSON.stringify({
      jobs: [
        { id: "ok", title: "Engineer", jobUrl: "https://jobs.ashbyhq.com/example/ok" },
        { id: 123, title: "Sin URL válida" },
        "basura",
      ],
    });

    const jobs = await fetchCompanyJobs(
      { name: "Example", url: "https://jobs.ashbyhq.com/example" },
      staticFetch(body),
    );

    expect(jobs).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("ats: Example descartó 2 ofertas inválidas");
  });

  it("rechaza respuestas con content-length mayor de 10 MB", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
      });

    await expect(
      fetchCompanyJobs({ name: "Example", url: "https://jobs.ashbyhq.com/example" }, fetchImpl),
    ).rejects.toThrow(/demasiado grande/);
  });

  it("rechaza cuerpos de texto mayores de 10 MB", async () => {
    const fetchImpl: FetchLike = async () => new Response("x".repeat(MAX_RESPONSE_BYTES + 1));

    await expect(
      fetchCompanyJobs({ name: "Example", url: "https://jobs.ashbyhq.com/example" }, fetchImpl),
    ).rejects.toThrow(/demasiado grande/);
  });

  it("limita la descripción a 3000 caracteres", async () => {
    const body = JSON.stringify({
      jobs: [
        {
          id: "long",
          title: "Engineer",
          jobUrl: "https://jobs.ashbyhq.com/example/long",
          descriptionPlain: "a".repeat(3500),
        },
      ],
    });

    const jobs = await fetchCompanyJobs(
      { name: "Example", url: "https://jobs.ashbyhq.com/example" },
      staticFetch(body),
    );

    expect(jobs[0]?.description).toHaveLength(3000);
  });

  it("lanza un error si el ATS no está soportado", async () => {
    await expect(
      fetchCompanyJobs({ name: "Example", url: "https://example.com/careers" }),
    ).rejects.toThrow(/ATS no soportado/);
  });
});

describe("fetchAllAts", () => {
  it("aísla los fallos por empresa y cuenta la cobertura", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes("ashbyhq")) return new Response(fixture("ashby.json"), { status: 200 });
      throw new Error("red caída");
    };

    const result = await fetchAllAts(
      [
        { name: "Ashby Co", url: "https://jobs.ashbyhq.com/example-inc" },
        { name: "Lever Co", url: "https://jobs.lever.co/example" },
        { name: "Unknown Co", url: "https://example.com/careers" },
      ],
      { fetchImpl },
    );

    expect(result.jobs).toHaveLength(2);
    expect(result.errors).toEqual([
      { company: "Lever Co", url: "https://jobs.lever.co/example", error: "red caída" },
    ]);
    expect(result.coverage).toEqual({
      ashby: 1,
      greenhouse: 0,
      lever: 1,
      workable: 0,
      personio: 0,
      recruitee: 0,
      unsupported: 1,
    });
  });

  it("limita la concurrencia", async () => {
    let active = 0;
    let maxActive = 0;

    const fetchImpl: FetchLike = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response('{"jobs":[]}', { status: 200 });
    };

    const companies = Array.from({ length: 6 }, (_, index) => ({
      name: `Company ${index}`,
      url: `https://jobs.ashbyhq.com/company-${index}`,
    }));

    await fetchAllAts(companies, { concurrency: 2, fetchImpl });

    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

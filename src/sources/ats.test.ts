import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  detectAts,
  fetchAllAts,
  fetchCompanyJobs,
  type FetchLike,
} from "./ats.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url)), "utf8");
}

function staticFetch(body: string, status = 200): FetchLike {
  return async () => new Response(body, { status });
}

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
});

describe("fetchCompanyJobs", () => {
  it("normaliza Ashby y marca el remoto por ubicación secundaria", async () => {
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
      remote: true,
      url: "https://jobs.ashbyhq.com/example-inc/ashby-1",
      postedAt: "2026-11-10T09:00:00Z",
    });
    expect(jobs[1]).toMatchObject({ id: "ashby:example-inc:ashby-2", remote: true });
  });

  it("normaliza Greenhouse", async () => {
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
      }),
    ]);
  });

  it("normaliza Lever usando workplaceType", async () => {
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
    });
  });

  it("normaliza Workable", async () => {
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
      }),
    ]);
  });

  it("normaliza Recruitee", async () => {
    const jobs = await fetchCompanyJobs(
      { name: "Example", url: "https://example.recruitee.com" },
      staticFetch(fixture("recruitee.json")),
    );

    expect(jobs).toEqual([
      expect.objectContaining({
        id: "recruitee:example:9001",
        title: "TypeScript Developer",
        location: "Spain remote",
        remote: true,
      }),
    ]);
  });

  it("normaliza el XML de Personio", async () => {
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
    });
    expect(jobs[1]).toMatchObject({ id: "personio:example:67890", remote: true });
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

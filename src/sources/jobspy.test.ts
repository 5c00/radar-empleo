import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseJobspyOutput } from "./jobspy.js";

const VALID_OUTPUT = readFileSync(
  fileURLToPath(new URL("../../test/fixtures/jobspy.json", import.meta.url)),
  "utf8",
);

describe("parseJobspyOutput", () => {
  it("normaliza una salida válida", () => {
    const jobs = parseJobspyOutput(VALID_OUTPUT);

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toEqual({
      id: "jobspy:https://es.indeed.com/viewjob?jk=abc123",
      source: "jobspy",
      company: "Example Corp",
      title: "Full Stack Developer",
      location: "Barcelona, Spain",
      remote: false,
      url: "https://es.indeed.com/viewjob?jk=abc123",
      postedAt: "2026-11-18",
      description: "Build web apps with TypeScript and React.",
    });
    expect(jobs[1]).toMatchObject({
      id: "jobspy:https://www.glassdoor.es/job/xyz",
      remote: true,
      location: "Remote (Spain)",
    });
    expect(jobs[1]?.postedAt).toBeUndefined();
  });

  it("devuelve una lista vacía si el JSON no es válido", () => {
    expect(parseJobspyOutput("esto no es json")).toEqual([]);
    expect(parseJobspyOutput('{"title":"no es un array"}')).toEqual([]);
    expect(parseJobspyOutput("")).toEqual([]);
  });

  it("descarta los elementos parciales y conserva los válidos", () => {
    const output = JSON.stringify([
      {
        title: "Valid Job",
        company: "Example",
        location: "Spain",
        job_url: "https://example.com/jobs/1",
      },
      { title: "Missing url", company: "Example" },
      { company: "Missing title", job_url: "https://example.com/jobs/2" },
      "garbage",
    ]);

    const jobs = parseJobspyOutput(output);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: "Valid Job", url: "https://example.com/jobs/1" });
  });

  it("devuelve una lista vacía si el JSON está truncado", () => {
    expect(parseJobspyOutput('[{"title":"Truncated","company":"Exa')).toEqual([]);
  });
});

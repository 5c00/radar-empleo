import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadProfile } from "./profile.js";

const VALID_PROFILE = fileURLToPath(new URL("../test/fixtures/profile-valid.yml", import.meta.url));

const tempDirs: string[] = [];

function writeTempProfile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "radar-empleo-profile-"));
  tempDirs.push(dir);
  const path = join(dir, "profile.yml");
  writeFileSync(path, content, "utf8");
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadProfile", () => {
  it("carga un perfil válido y aplica los valores por defecto", () => {
    const profile = loadProfile(VALID_PROFILE);

    expect(profile.includeTitle).toEqual(["full stack", "react"]);
    expect(profile.excludeTitle).toEqual(["senior", "java"]);
    expect(profile.locationOk).toEqual(["spain", "barcelona"]);
    expect(profile.remoteOk).toEqual([
      "remote",
      "anywhere",
      "worldwide",
      "europe",
      "emea",
      "eu",
      "spain",
      "españa",
    ]);
    expect(profile.excludeText).toEqual(["degree required"]);
    expect(profile.applied).toEqual(["Example Corp"]);
    expect(profile.maxYearsRequired).toBeUndefined();
    expect(profile.maxPerDay).toBe(5);
    expect(profile.maxScoredPerRun).toBe(30);
    expect(profile.jobspy.searches).toEqual(["full stack developer"]);
    expect(profile.jobspy.resultsWanted).toBe(20);
    expect(profile.jobspy.hoursOld).toBe(72);
    expect(profile.jobspy.sites).toEqual(["indeed", "glassdoor"]);
    expect(profile.jobspy.country).toBe("spain");
    expect(profile.extraCompanies).toEqual([]);
  });

  it("respeta remoteOk cuando el perfil lo define", () => {
    const path = writeTempProfile(`
includeTitle: [react]
excludeTitle: []
locationOk: [spain]
remoteOk: [remote, emea]
excludeText: []
applied: []
cvSummary: "Developer"
jobspy:
  searches: [react]
`);

    expect(loadProfile(path).remoteOk).toEqual(["remote", "emea"]);
  });

  it("carga maxYearsRequired cuando está definido", () => {
    const path = writeTempProfile(`
includeTitle: [react]
excludeTitle: []
locationOk: [spain]
excludeText: []
applied: []
maxYearsRequired: 3
cvSummary: "Developer"
jobspy:
  searches: [react]
`);

    expect(loadProfile(path).maxYearsRequired).toBe(3);
  });

  it("rechaza un maxYearsRequired negativo o no entero", () => {
    const invalidValues = ["-1", "1.5"];

    for (const value of invalidValues) {
      const path = writeTempProfile(`
includeTitle: [react]
excludeTitle: []
locationOk: [spain]
excludeText: []
applied: []
maxYearsRequired: ${value}
cvSummary: "Developer"
jobspy:
  searches: [react]
`);

      expect(() => loadProfile(path), value).toThrow(/no es válido/);
    }
  });

  it("lanza un error claro si el fichero no existe", () => {
    expect(() => loadProfile(join(tmpdir(), "no-existe-radar-empleo.yml"))).toThrow(
      /No se pudo leer el perfil/,
    );
  });

  it("lanza un error claro si el perfil no valida", () => {
    const path = writeTempProfile(`
includeTitle: [react]
excludeTitle: []
locationOk: [spain]
excludeText: []
applied: []
cvSummary: ""
jobspy:
  searches: []
`);

    expect(() => loadProfile(path)).toThrow(/no es válido/);
  });
});

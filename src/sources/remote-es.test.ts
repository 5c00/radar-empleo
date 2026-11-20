import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "./ats.js";
import { fetchRemoteEsCompanies, parseRemoteEsReadme } from "./remote-es.js";

const README = readFileSync(
  fileURLToPath(new URL("../../test/fixtures/remote-es-readme.md", import.meta.url)),
  "utf8",
);

describe("parseRemoteEsReadme", () => {
  it("extrae las empresas con enlace a ofertas de la sección Companies", () => {
    expect(parseRemoteEsReadme(README)).toEqual([
      { name: "Example One", url: "https://jobs.lever.co/exampleone" },
      { name: "Example Two", url: "https://apply.workable.com/exampletwo/" },
      { name: "Example Three", url: "https://example.recruitee.com" },
      { name: "Example Four", url: "https://jobs.lever.co/examplefour" },
    ]);
  });

  it("devuelve una lista vacía si no hay sección Companies", () => {
    expect(parseRemoteEsReadme("# Other\n\n* Example [Open positions](https://example.com)")).toEqual(
      [],
    );
  });
});

describe("fetchRemoteEsCompanies", () => {
  it("usa la rama master cuando responde correctamente", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response(README, { status: 200 });
    };

    const companies = await fetchRemoteEsCompanies(fetchImpl);

    expect(calls).toBe(1);
    expect(companies).toHaveLength(4);
  });

  it("prueba la rama main si master devuelve 404", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      urls.push(String(input));
      if (String(input).includes("/master/")) return new Response("not found", { status: 404 });
      return new Response(README, { status: 200 });
    };

    const companies = await fetchRemoteEsCompanies(fetchImpl);

    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("/main/");
    expect(companies).toHaveLength(4);
  });

  it("lanza un error si ninguna rama responde", async () => {
    const fetchImpl: FetchLike = async () => new Response("error", { status: 500 });

    await expect(fetchRemoteEsCompanies(fetchImpl)).rejects.toThrow(
      /No se pudo descargar el README/,
    );
  });

  it("rechaza respuestas con content-length mayor de 10 MB", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("# Companies\n", {
        status: 200,
        headers: { "content-length": String(10 * 1024 * 1024 + 1) },
      });

    await expect(fetchRemoteEsCompanies(fetchImpl)).rejects.toThrow(/demasiado grande/);
  });

  it("rechaza cuerpos de texto mayores de 10 MB", async () => {
    const fetchImpl: FetchLike = async () => new Response("x".repeat(10 * 1024 * 1024 + 1));

    await expect(fetchRemoteEsCompanies(fetchImpl)).rejects.toThrow(/demasiado grande/);
  });
});

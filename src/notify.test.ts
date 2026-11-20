import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDigest, sendTelegram } from "./notify.js";
import type { ScoredJob } from "./score.js";

type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const TOKEN = "123456:AAH-secret-token";
const CHAT_ID = "987654321";

function makeJob(overrides: Partial<ScoredJob> = {}): ScoredJob {
  return {
    id: "ats:example:1",
    source: "ats",
    company: "Example",
    title: "React Developer",
    location: "Barcelona, España",
    remote: false,
    url: "https://example.com/jobs/1",
    score: 8,
    reason: "Buen encaje con el CV",
    scoredBy: "llm",
    ...overrides,
  };
}

function asFetch(mock: ReturnType<typeof vi.fn<FetchHandler>>): typeof fetch {
  return mock as unknown as typeof fetch;
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("se esperaba un error y no se lanzó");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatDigest", () => {
  it("genera la cabecera y escapa el HTML de la oferta y de la URL", () => {
    const [message] = formatDigest(
      [
        makeJob({
          company: 'Acme <Co> & "Friends"',
          title: "<script>alert('x')</script>",
          location: "Barcelona <Spain>",
          reason: "Buen encaje & <b>react</b>",
          url: "https://example.com/oferta?a=1&b=2",
          remote: true,
        }),
      ],
      "2026-11-20",
    );

    expect(message).toContain("🎯 Radar de empleo — 2026-11-20 — 1 ofertas");
    expect(message).toContain("Acme &lt;Co&gt; &amp; &quot;Friends&quot;");
    expect(message).toContain("&lt;script&gt;alert('x')&lt;/script&gt;");
    expect(message).toContain("Barcelona &lt;Spain&gt; (remoto)");
    expect(message).toContain("Nota: 8/10 — Buen encaje &amp; &lt;b&gt;react&lt;/b&gt;");
    expect(message).toContain('<a href="https://example.com/oferta?a=1&amp;b=2">Ver oferta</a>');
    expect(message).not.toContain("<script>");
  });

  it("omite el enlace cuando la URL no es http(s)", () => {
    const [message] = formatDigest(
      [
        makeJob({ company: "Ftp Co", url: "ftp://example.com/job" }),
        makeJob({ company: "Js Co", url: "javascript:alert(1)" }),
        makeJob({ company: "Bad Co", url: "no es una url" }),
      ],
      "2026-11-20",
    );

    expect(message).toContain("3 ofertas");
    expect(message).not.toContain("<a href");
    expect(message).not.toContain("Ver oferta");
  });

  it("divide por ofertas completas cuando un mensaje pasaría de 4.000 caracteres", () => {
    const jobs = Array.from({ length: 30 }, (_, index) =>
      makeJob({
        id: `ats:example:${index}`,
        company: `Empresa ${index}`,
        title: `Puesto ${index}`,
        url: `https://example.com/jobs/${index}`,
        reason: `Motivo ${index} ${"x".repeat(110)}`,
      }),
    );

    const messages = formatDigest(jobs, "2026-11-20");

    expect(messages.length).toBeGreaterThan(1);
    expect(messages[0]?.startsWith("🎯 Radar de empleo — 2026-11-20 — 30 ofertas")).toBe(true);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(4_000);
    }

    const notified = messages
      .map((message) => (message.match(/<b>Empresa \d+<\/b>/g) ?? []).length)
      .reduce((total, count) => total + count, 0);
    expect(notified).toBe(30);

    const links = messages
      .map((message) => (message.match(/Ver oferta/g) ?? []).length)
      .reduce((total, count) => total + count, 0);
    expect(links).toBe(30);
  });
});

describe("sendTelegram", () => {
  it("envía cada mensaje a la API con chat_id, HTML y sin preview", async () => {
    const fetchMock = vi.fn<FetchHandler>(async () => Response.json({ ok: true }));

    await sendTelegram(["uno", "dos"], {
      env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT_ID },
      fetchImpl: asFetch(fetchMock),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch no fue llamado");
    const [url, init] = call;

    expect(String(url)).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = typeof init?.body === "string" ? init.body : "";
    expect(body).toContain(`"chat_id":"${CHAT_ID}"`);
    expect(body).toContain('"text":"uno"');
    expect(body).toContain('"parse_mode":"HTML"');
    expect(body).toContain('"disable_web_page_preview":true');
  });

  it("lanza un error claro sin mostrar valores cuando falta el entorno", async () => {
    const fetchMock = vi.fn<FetchHandler>(async () => Response.json({ ok: true }));

    const withoutToken = await captureError(
      sendTelegram(["hola"], {
        env: { TELEGRAM_CHAT_ID: CHAT_ID },
        fetchImpl: asFetch(fetchMock),
      }),
    );
    expect(withoutToken.message).toContain("TELEGRAM_BOT_TOKEN");
    expect(withoutToken.message).not.toContain(CHAT_ID);

    const withoutChat = await captureError(
      sendTelegram(["hola"], {
        env: { TELEGRAM_BOT_TOKEN: TOKEN },
        fetchImpl: asFetch(fetchMock),
      }),
    );
    expect(withoutChat.message).toContain("TELEGRAM_CHAT_ID");
    expect(withoutChat.message).not.toContain(TOKEN);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("incluye status y description en el error HTTP sin filtrar el token", async () => {
    const fetchMock = vi.fn<FetchHandler>(async () =>
      new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const error = await captureError(
      sendTelegram(["hola"], {
        env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT_ID },
        fetchImpl: asFetch(fetchMock),
      }),
    );

    expect(error.message).toContain("400");
    expect(error.message).toContain("Bad Request: chat not found");
    expect(error.message).not.toContain(TOKEN);
  });

  it("envuelve los errores de red y sanea el token", async () => {
    const fetchMock = vi.fn<FetchHandler>(async (input) => {
      throw new Error(`fallo al conectar con ${String(input)}`);
    });

    const error = await captureError(
      sendTelegram(["hola"], {
        env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT_ID },
        fetchImpl: asFetch(fetchMock),
      }),
    );

    expect(error.message).toContain("fallo de red");
    expect(error.message).toContain("***");
    expect(error.message).not.toContain(TOKEN);
  });
});

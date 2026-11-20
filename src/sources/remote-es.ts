import type { Company, FetchLike } from "./ats.js";

const README_URLS = [
  "https://raw.githubusercontent.com/remote-es/remotes/master/README.md",
  "https://raw.githubusercontent.com/remote-es/remotes/main/README.md",
];

const README_TIMEOUT_MS = 15_000;

export function parseRemoteEsReadme(md: string): Company[] {
  const companies: Company[] = [];
  let inCompanies = false;

  for (const line of md.split(/\r?\n/)) {
    if (/^#\s+Companies\b/i.test(line)) {
      inCompanies = true;
      continue;
    }
    if (!inCompanies) continue;
    if (/^#{1,6}\s/.test(line)) break;

    const trimmed = line.trim();
    if (!trimmed.startsWith("*")) continue;

    const content = trimmed.replace(/^\*\s*/, "");
    const openPositions = content.match(/\[Open positions\]\(([^)\s]+)\)/i);
    const url = openPositions?.[1];
    if (!url) continue;

    let namePart = content.slice(0, openPositions?.index ?? 0).trim();

    const markdownName = namePart.match(/^\[([^\]]+)\]\([^)]*\)/);
    if (markdownName?.[1]) {
      namePart = markdownName[1];
    } else {
      namePart = namePart.replace(/\([^)]*\)/g, " ");
    }

    const name = namePart
      .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/[()]/g, " ")
      .replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!name) continue;
    companies.push({ name, url });
  }

  return companies;
}

export async function fetchRemoteEsCompanies(fetchImpl: FetchLike): Promise<Company[]> {
  let lastStatus = 0;

  for (const url of README_URLS) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(README_TIMEOUT_MS) });
    if (response.ok) return parseRemoteEsReadme(await response.text());

    lastStatus = response.status;
    if (response.status !== 404) break;
  }

  throw new Error(`No se pudo descargar el README de remote-es (último estado: ${lastStatus})`);
}

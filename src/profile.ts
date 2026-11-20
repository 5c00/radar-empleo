import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const jobspySchema = z.object({
  searches: z.array(z.string().min(1)).min(1),
  resultsWanted: z.number().int().positive().default(20),
  hoursOld: z.number().int().positive().default(72),
  sites: z
    .array(z.enum(["indeed", "glassdoor", "linkedin"]))
    .min(1)
    .default(["indeed", "glassdoor"]),
  country: z.string().min(1).default("spain"),
});

const profileSchema = z.object({
  includeTitle: z.array(z.string().min(1)),
  excludeTitle: z.array(z.string().min(1)),
  locationOk: z.array(z.string().min(1)),
  excludeText: z.array(z.string().min(1)),
  applied: z.array(z.string().min(1)),
  maxPerDay: z.number().int().positive().default(5),
  maxScoredPerRun: z.number().int().positive().default(30),
  cvSummary: z.string().min(1).max(1500),
  jobspy: jobspySchema,
  extraCompanies: z
    .array(z.object({ name: z.string().min(1), url: z.string().url() }))
    .default([]),
});

export type Profile = z.infer<typeof profileSchema>;

export function loadProfile(path: string): Profile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `No se pudo leer el perfil "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let data: unknown;
  try {
    data = parse(raw);
  } catch (error) {
    throw new Error(
      `El perfil "${path}" no es YAML válido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = profileSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`El perfil "${path}" no es válido:\n${z.prettifyError(result.error)}`);
  }

  return result.data;
}

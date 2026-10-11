import "server-only";
import path from "node:path";
import { z } from "zod";
import { JOB_ENV_SUFFIX, JOB_LIMITS, LLM_JOBS, type JobConfigs } from "./llm/jobs";

export type LiveVendor = "anthropic" | "openai";

const optionalString = z.string().optional().transform((v) => (v ? v : undefined));

/** Effort levels each API accepts; validated only when a per-job effort is configured. */
const EFFORTS: Record<LiveVendor, readonly string[]> = {
  openai: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  anthropic: ["low", "medium", "high", "xhigh", "max"],
};

const PREFIX: Record<LiveVendor, "OPENAI" | "ANTHROPIC"> = { openai: "OPENAI", anthropic: "ANTHROPIC" };

const baseSchema = z.object({
  /** mock = offline fixtures; anthropic | openai = live provider. `live` is kept as an alias for anthropic. */
  LLM_MODE: z
    .enum(["mock", "live", "anthropic", "openai"])
    .default("mock")
    .transform((m) => (m === "live" ? "anthropic" : m)),
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: optionalString,
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString,
  PROXIMAL_DATA_DIR: z.string().default("./data"),
  PROXIMAL_TIMEZONE: z.string().default("Europe/London"),
});

export type AppEnv = z.infer<typeof baseSchema> & {
  dataDir: string;
  /** Resolved per-job model settings for the selected live vendor; null in mock mode. */
  jobs: JobConfigs | null;
};

export class EnvConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(" "));
    this.name = "EnvConfigError";
  }
}

/**
 * Resolve each job's model: `<VENDOR>_MODEL_<JOB>` if set, otherwise `<VENDOR>_MODEL`. Every job must resolve to a
 * model; nothing is chosen silently. `<VENDOR>_EFFORT_<JOB>` is optional and validated per vendor.
 */
function resolveJobs(vendor: LiveVendor, source: NodeJS.ProcessEnv, problems: string[]): JobConfigs | null {
  const p = PREFIX[vendor];
  if (!source[`${p}_API_KEY`]) problems.push(`LLM_MODE=${vendor} requires ${p}_API_KEY.`);
  const fallback = source[`${p}_MODEL`] || undefined;
  const jobs: Partial<JobConfigs> = {};
  const missing: string[] = [];
  for (const job of LLM_JOBS) {
    const suffix = JOB_ENV_SUFFIX[job];
    const model = source[`${p}_MODEL_${suffix}`] || fallback;
    if (!model) {
      missing.push(`${p}_MODEL_${suffix}`);
      continue;
    }
    const effort = source[`${p}_EFFORT_${suffix}`] || undefined;
    if (effort && !EFFORTS[vendor].includes(effort)) {
      problems.push(`${p}_EFFORT_${suffix} must be one of ${EFFORTS[vendor].join(", ")}.`);
    }
    jobs[job] = { model, ...(effort ? { effort } : {}), ...JOB_LIMITS[job] };
  }
  if (missing.length === LLM_JOBS.length) {
    problems.push(`LLM_MODE=${vendor} requires ${p}_MODEL (or a model for each job). No model is chosen silently.`);
  } else if (missing.length > 0) {
    problems.push(`Set ${p}_MODEL as the default, or set ${missing.join(" and ")}. No model is chosen silently.`);
  }
  return problems.length === 0 ? (jobs as JobConfigs) : null;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = baseSchema.parse({
    LLM_MODE: source.LLM_MODE || undefined,
    ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: source.ANTHROPIC_MODEL,
    OPENAI_API_KEY: source.OPENAI_API_KEY,
    OPENAI_MODEL: source.OPENAI_MODEL,
    PROXIMAL_DATA_DIR: source.PROXIMAL_DATA_DIR || undefined,
    PROXIMAL_TIMEZONE: source.PROXIMAL_TIMEZONE || undefined,
  });
  let jobs: JobConfigs | null = null;
  if (parsed.LLM_MODE !== "mock") {
    const problems: string[] = [];
    jobs = resolveJobs(parsed.LLM_MODE, source, problems);
    if (problems.length > 0) throw new EnvConfigError(problems);
  }
  return { ...parsed, jobs, dataDir: path.resolve(/*turbopackIgnore: true*/ process.cwd(), parsed.PROXIMAL_DATA_DIR) };
}

/** Which live vendor the raw environment asks for (even when misconfigured), for honest status labels. */
export function requestedVendor(source: NodeJS.ProcessEnv = process.env): LiveVendor | null {
  const m = source.LLM_MODE;
  if (m === "openai") return "openai";
  if (m === "anthropic" || m === "live") return "anthropic";
  return null;
}

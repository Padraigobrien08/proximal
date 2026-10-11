import "server-only";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
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

export interface KeyInfo {
  /** Where the selected vendor's API key came from (never the key itself). */
  source: ".env" | "environment" | null;
  /** A different key for the same vendor exists in the shell environment and is being ignored. */
  shellKeyIgnored: boolean;
}

export type AppEnv = z.infer<typeof baseSchema> & {
  dataDir: string;
  /** Resolved per-job model settings for the selected live vendor; null in mock mode. */
  jobs: JobConfigs | null;
  keyInfo: KeyInfo;
  limits: UsageLimits;
};

export interface UsageLimits {
  /** Max live provider calls in a rolling 24 hours; null = unlimited. */
  dailyCalls: number | null;
  /** Max input+output tokens in a rolling 24 hours; null = unlimited. */
  dailyTokens: number | null;
  /** Max provider calls in flight at once (queued beyond this). */
  maxConcurrent: number;
}

/**
 * Provider settings in `.env` take precedence over the shell environment. Next.js (and Node's loadEnvFile) let an
 * already-exported variable win, which silently picks up a stale shell key; this makes `.env` authoritative for
 * these prefixes only.
 */
const FILE_WINS = /^(LLM_MODE$|OPENAI_|ANTHROPIC_|PROXIMAL_DAILY_|PROXIMAL_MAX_CONCURRENT)/;

let fileCache: { path: string; mtimeMs: number; vars: Record<string, string> } | null = null;

/**
 * `PROXIMAL_ENV_FILE` selects a different file, or `none` to ignore `.env` entirely (key-free test servers must not
 * pick up a developer's live provider settings).
 */
export function readDotEnvFile(file?: string): Record<string, string> {
  const choice = process.env.PROXIMAL_ENV_FILE;
  if (!file && choice === "none") return {};
  file ??= path.resolve(/*turbopackIgnore: true*/ process.cwd(), choice || ".env");
  if (!existsSync(file)) return {};
  const mtimeMs = statSync(file).mtimeMs;
  if (fileCache && fileCache.path === file && fileCache.mtimeMs === mtimeMs) return fileCache.vars;
  const vars = parseEnv(readFileSync(file, "utf8")) as Record<string, string>;
  fileCache = { path: file, mtimeMs, vars };
  return vars;
}

/** Merge: `.env` values (non-empty) win for provider/limit settings; everything else comes from the environment. */
export function mergedEnv(source: NodeJS.ProcessEnv, fileVars: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...source };
  for (const [k, v] of Object.entries(fileVars)) {
    if (FILE_WINS.test(k) && v !== "") merged[k] = v;
  }
  return merged;
}

function positiveInt(raw: string | undefined, name: string, problems: string[]): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    problems.push(`${name} must be a positive whole number.`);
    return null;
  }
  return n;
}

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

/**
 * Read and validate configuration. With no argument it merges `.env` over the process environment for provider
 * settings; tests pass an explicit source (and optional file vars) instead.
 */
export function readEnv(source?: NodeJS.ProcessEnv, fileVars?: Record<string, string>): AppEnv {
  const raw = source ?? process.env;
  const file = source ? (fileVars ?? {}) : readDotEnvFile();
  const env = mergedEnv(raw, file);
  const parsed = baseSchema.parse({
    LLM_MODE: env.LLM_MODE || undefined,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    OPENAI_MODEL: env.OPENAI_MODEL,
    PROXIMAL_DATA_DIR: env.PROXIMAL_DATA_DIR || undefined,
    PROXIMAL_TIMEZONE: env.PROXIMAL_TIMEZONE || undefined,
  });
  const problems: string[] = [];
  let jobs: JobConfigs | null = null;
  const keyInfo: KeyInfo = { source: null, shellKeyIgnored: false };
  if (parsed.LLM_MODE !== "mock") {
    jobs = resolveJobs(parsed.LLM_MODE, env, problems);
    const keyName = `${PREFIX[parsed.LLM_MODE]}_API_KEY`;
    const fromFile = file[keyName] || "";
    const fromShell = raw[keyName] || "";
    keyInfo.source = fromFile ? ".env" : fromShell ? "environment" : null;
    keyInfo.shellKeyIgnored = !!fromFile && !!fromShell && fromFile !== fromShell;
  }
  const limits: UsageLimits = {
    dailyCalls: positiveInt(env.PROXIMAL_DAILY_CALL_LIMIT, "PROXIMAL_DAILY_CALL_LIMIT", problems),
    dailyTokens: positiveInt(env.PROXIMAL_DAILY_TOKEN_LIMIT, "PROXIMAL_DAILY_TOKEN_LIMIT", problems),
    maxConcurrent: positiveInt(env.PROXIMAL_MAX_CONCURRENT_CALLS, "PROXIMAL_MAX_CONCURRENT_CALLS", problems) ?? 2,
  };
  if (problems.length > 0) throw new EnvConfigError(problems);
  return {
    ...parsed,
    jobs,
    keyInfo,
    limits,
    dataDir: path.resolve(/*turbopackIgnore: true*/ process.cwd(), parsed.PROXIMAL_DATA_DIR),
  };
}

/** Which live vendor the raw environment asks for (even when misconfigured), for honest status labels. */
export function requestedVendor(source?: NodeJS.ProcessEnv): LiveVendor | null {
  const m = (source ?? mergedEnv(process.env, readDotEnvFile())).LLM_MODE;
  if (m === "openai") return "openai";
  if (m === "anthropic" || m === "live") return "anthropic";
  return null;
}

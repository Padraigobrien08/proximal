import "server-only";
import path from "node:path";
import { z } from "zod";

export type LiveVendor = "anthropic" | "openai";

const optionalString = z.string().optional().transform((v) => (v ? v : undefined));

const envSchema = z
  .object({
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
  })
  .superRefine((env, ctx) => {
    if (env.LLM_MODE === "anthropic" && (!env.ANTHROPIC_API_KEY || !env.ANTHROPIC_MODEL)) {
      ctx.addIssue({
        code: "custom",
        message: "LLM_MODE=anthropic requires both ANTHROPIC_API_KEY and ANTHROPIC_MODEL. No model is chosen silently.",
      });
    }
    if (env.LLM_MODE === "openai" && (!env.OPENAI_API_KEY || !env.OPENAI_MODEL)) {
      ctx.addIssue({
        code: "custom",
        message: "LLM_MODE=openai requires both OPENAI_API_KEY and OPENAI_MODEL. No model is chosen silently.",
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema> & { dataDir: string };

export function readEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.parse({
    LLM_MODE: source.LLM_MODE || undefined,
    ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: source.ANTHROPIC_MODEL,
    OPENAI_API_KEY: source.OPENAI_API_KEY,
    OPENAI_MODEL: source.OPENAI_MODEL,
    PROXIMAL_DATA_DIR: source.PROXIMAL_DATA_DIR || undefined,
    PROXIMAL_TIMEZONE: source.PROXIMAL_TIMEZONE || undefined,
  });
  return { ...parsed, dataDir: path.resolve(/*turbopackIgnore: true*/ process.cwd(), parsed.PROXIMAL_DATA_DIR) };
}

/** Which live vendor the raw environment asks for (even when misconfigured), for honest status labels. */
export function requestedVendor(source: NodeJS.ProcessEnv = process.env): LiveVendor | null {
  const m = source.LLM_MODE;
  if (m === "openai") return "openai";
  if (m === "anthropic" || m === "live") return "anthropic";
  return null;
}

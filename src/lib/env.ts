import "server-only";
import path from "node:path";
import { z } from "zod";

const envSchema = z
  .object({
    LLM_MODE: z.enum(["mock", "live"]).default("mock"),
    ANTHROPIC_API_KEY: z.string().optional().transform((v) => (v ? v : undefined)),
    ANTHROPIC_MODEL: z.string().optional().transform((v) => (v ? v : undefined)),
    PROXIMAL_DATA_DIR: z.string().default("./data"),
    PROXIMAL_TIMEZONE: z.string().default("Europe/London"),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_MODE === "live" && (!env.ANTHROPIC_API_KEY || !env.ANTHROPIC_MODEL)) {
      ctx.addIssue({
        code: "custom",
        message: "LLM_MODE=live requires both ANTHROPIC_API_KEY and ANTHROPIC_MODEL. No model is chosen silently.",
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema> & { dataDir: string };

export function readEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.parse({
    LLM_MODE: source.LLM_MODE || undefined,
    ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: source.ANTHROPIC_MODEL,
    PROXIMAL_DATA_DIR: source.PROXIMAL_DATA_DIR || undefined,
    PROXIMAL_TIMEZONE: source.PROXIMAL_TIMEZONE || undefined,
  });
  return { ...parsed, dataDir: path.resolve(/*turbopackIgnore: true*/ process.cwd(), parsed.PROXIMAL_DATA_DIR) };
}

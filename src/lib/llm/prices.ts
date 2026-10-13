// Cost estimates from recorded token counts and a price list the owner maintains. Pure. No price is built in:
// provider prices change, so an unknown price is reported as unknown, never guessed.
import { z } from "zod";

const price = z.number().nonnegative().nullable();

export const priceListSchema = z.strictObject({
  currency: z.string().min(1).max(8),
  note: z.string().optional(),
  /** Keyed by vendor:model exactly as recorded in provider_calls (e.g. "openai:gpt-5.5-2026-04-23"). */
  models: z.record(
    z.string(),
    z.strictObject({
      inputPerMillion: price,
      outputPerMillion: price,
      /** When the owner last checked these prices against the provider's price list. */
      checkedOn: z.string().nullable(),
    }),
  ),
});
export type PriceList = z.infer<typeof priceListSchema>;

/** Estimated cost of a token count, or null when the model or either price is unknown. */
export function estimateCost(prices: PriceList | null, model: string, inputTokens: number, outputTokens: number): number | null {
  const p = prices?.models[model];
  if (!p || p.inputPerMillion === null || p.outputPerMillion === null) return null;
  return (inputTokens * p.inputPerMillion + outputTokens * p.outputPerMillion) / 1_000_000;
}

/** A template listing every model seen, with prices left for the owner to fill in. */
export function priceTemplate(models: string[], existing: PriceList | null): PriceList {
  const out: PriceList = {
    currency: existing?.currency ?? "USD",
    note: "Per million tokens. Copy each price from the provider's current price list and set checkedOn; null means unknown.",
    models: { ...(existing?.models ?? {}) },
  };
  for (const m of models) out.models[m] ??= { inputPerMillion: null, outputPerMillion: null, checkedOn: null };
  return out;
}

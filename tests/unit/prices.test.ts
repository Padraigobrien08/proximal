import { describe, expect, it } from "vitest";
import { estimateCost, priceListSchema, priceTemplate } from "../../src/lib/llm/prices";

const list = priceListSchema.parse({
  currency: "USD",
  models: {
    "openai:a": { inputPerMillion: 2, outputPerMillion: 8, checkedOn: "2026-10-13" },
    "openai:b": { inputPerMillion: null, outputPerMillion: 8, checkedOn: null },
  },
});

describe("cost estimates", () => {
  it("prices tokens per million and never guesses an unknown price", () => {
    expect(estimateCost(list, "openai:a", 500_000, 100_000)).toBeCloseTo(1.8);
    expect(estimateCost(list, "openai:b", 1, 1)).toBeNull();
    expect(estimateCost(list, "openai:missing", 1, 1)).toBeNull();
    expect(estimateCost(null, "openai:a", 1, 1)).toBeNull();
  });
  it("templates every model seen and keeps prices already entered", () => {
    const t = priceTemplate(["openai:a", "openai:c"], list);
    expect(t.models["openai:a"].inputPerMillion).toBe(2);
    expect(t.models["openai:c"]).toEqual({ inputPerMillion: null, outputPerMillion: null, checkedOn: null });
    expect(priceListSchema.safeParse(t).success).toBe(true);
  });
});

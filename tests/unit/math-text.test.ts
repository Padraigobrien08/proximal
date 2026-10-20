import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { plainMath, plainText } from "../../src/components/MathText";

/** Every distinct inline $...$ expression in the authored content. */
function fixtureExpressions(): string[] {
  const seen = new Set<string>();
  for (const f of ["curriculum", "questions", "lecture", "pacer/contexts", "historical-replay"]) {
    const strings: string[] = [];
    JSON.parse(readFileSync(path.join(import.meta.dirname, "../../fixtures", `${f}.json`), "utf8"), (_k, v) => {
      if (typeof v === "string") strings.push(v);
      return v;
    });
    for (const s of strings) for (const m of s.matchAll(/\$([^$]+)\$/g)) seen.add(m[1]);
  }
  return [...seen];
}

describe("AC14: plain-text maths", () => {
  it("every authored expression converts with no TeX left over", () => {
    const exprs = fixtureExpressions();
    expect(exprs.length).toBeGreaterThan(50);
    for (const tex of exprs) {
      const out = plainMath(tex);
      expect(out, tex).not.toMatch(/[\\{}$]/);
      // A TeX command glued to a preceding letter ("ylog") or an ungrouped exponent ("^1-y") reads wrongly.
      expect(out, tex).not.toMatch(/[A-Za-z0-9](log|ln)\b/);
      expect(out, tex).not.toMatch(/\^[^\s(]{2,}/);
    }
  });

  it("keeps exponent grouping and word spacing", () => {
    expect(plainMath("p^y(1-p)^{1-y}")).toBe("p^y(1-p)^(1-y)");
    expect(plainMath("\\log a^b = b\\log a")).toBe("log a^b = b log a");
    expect(plainMath("t_0\\log p_0 = (1-y)\\log(1-p)")).toBe("t_0 log p_0 = (1-y) log(1-p)");
    expect(plainMath("-\\log p")).toBe("-log p");
    expect(plainMath("-\\sum_k t_k \\log p_k")).toBe("-Σ_k t_k log p_k");
    expect(plainMath("L(\\theta) = \\prod_i p(y_i \\mid x_i, \\theta)")).toBe("L(θ) = Π_i p(y_i | x_i, θ)");
    expect(plainMath("\\frac{1}{n}")).toBe("(1)/(n)");
  });

  it("plainText replaces inline maths and keeps the surrounding prose", () => {
    expect(plainText("For $y = 1$ and $p(y=1) = 0.8$, calculate BCE.")).toBe("For y = 1 and p(y=1) = 0.8, calculate BCE.");
    expect(plainText("No maths here.")).toBe("No maths here.");
  });
});

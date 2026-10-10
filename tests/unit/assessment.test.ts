import { describe, expect, it } from "vitest";
import { aggregateOutcome, extractNumbers, validateAssessorOutput } from "../../src/lib/domain/assessment";
import { questionBankSchema } from "../../src/lib/content/schemas";
import { loadFixtures } from "../../src/lib/content/fixtures";
import type { Rubric } from "../../src/lib/domain/types";

const rubric: Rubric = {
  version: 1,
  criteria: [
    { id: "a", essential: true, description: "A", acceptableEquivalents: [], fatalIfNotMet: false },
    { id: "b", essential: true, description: "B", acceptableEquivalents: [], fatalIfNotMet: true },
    { id: "opt", essential: false, description: "optional", acceptableEquivalents: [], fatalIfNotMet: false },
  ],
};
const answer = "The answer mentions alpha and beta.";
const j = (id: string, status: "met" | "partial" | "not_met" | "uncertain", quote: string | null = null) => ({
  criterionId: id,
  status,
  answerQuote: quote,
  briefReason: "r",
});

describe("aggregation", () => {
  it("all essential met -> pass; unsupported optional does not count against", () => {
    const r = aggregateOutcome({ criteria: [j("a", "met", "alpha"), j("b", "met", "beta"), j("opt", "not_met")], possibleMisconception: null }, rubric, answer);
    expect(r.outcome).toBe("pass");
  });
  it("some essential met, no fatal -> partial", () => {
    const r = aggregateOutcome({ criteria: [j("a", "not_met"), j("b", "met", "beta"), j("opt", "met", "alpha")], possibleMisconception: null }, rubric, answer);
    expect(r.outcome).toBe("partial");
  });
  it("fatal criterion not_met -> fail even with others met", () => {
    const r = aggregateOutcome({ criteria: [j("a", "met", "alpha"), j("b", "not_met"), j("opt", "met", "alpha")], possibleMisconception: null }, rubric, answer);
    expect(r.outcome).toBe("fail");
  });
  it("unresolved essential criterion -> uncertain", () => {
    const r = aggregateOutcome({ criteria: [j("a", "uncertain"), j("b", "met", "beta"), j("opt", "met", "alpha")], possibleMisconception: null }, rubric, answer);
    expect(r.outcome).toBe("uncertain");
  });
  it("T19: invalid quote, missing quote, unknown or missing criterion ids cannot create a pass", () => {
    const bad = [
      { criteria: [j("a", "met", "gamma"), j("b", "met", "beta"), j("opt", "met", "alpha")], possibleMisconception: null },
      { criteria: [j("a", "met"), j("b", "met", "beta"), j("opt", "met", "alpha")], possibleMisconception: null },
      { criteria: [j("a", "met", "alpha"), j("b", "met", "beta"), j("zzz", "met", "alpha")], possibleMisconception: null },
      { criteria: [j("a", "met", "alpha"), j("b", "met", "beta")], possibleMisconception: null },
      { criteria: [j("a", "met", "alpha"), j("a", "met", "alpha"), j("b", "met", "beta"), j("opt", "met", "alpha")], possibleMisconception: null },
    ];
    for (const out of bad) {
      const r = aggregateOutcome(out, rubric, answer);
      expect(r.outcome).toBe("uncertain");
      expect(r.validity).toBe("invalid");
    }
  });
  it("numeric conflict with a 'met' claim -> uncertain", () => {
    const calc: Rubric = { version: 1, criteria: [{ id: "v", essential: true, description: "value", acceptableEquivalents: [], fatalIfNotMet: false }] };
    const ans = "The loss is 0.51";
    const r = aggregateOutcome({ criteria: [j("v", "met", "0.51")], possibleMisconception: null }, calc, ans, [
      { criterionId: "v", value: 0.223, tolerance: 0.005 },
    ]);
    expect(r.outcome).toBe("uncertain");
    const ok = aggregateOutcome({ criteria: [j("v", "met", "0.223")], possibleMisconception: null }, calc, "≈ 0.223", [
      { criterionId: "v", value: 0.22314355, tolerance: 0.005 },
    ]);
    expect(ok.outcome).toBe("pass");
  });
  it("extracts signed numbers, including unicode minus", () => {
    expect(extractNumbers("BCE = ln(0.8) = -0.223")).toContain(-0.223);
    expect(extractNumbers("= −0.5")).toContain(-0.5);
  });
});

describe("authored fixtures", () => {
  const { bank } = loadFixtures();
  it("validate against the schema and include correct, partial and wrong examples", () => {
    expect(() => questionBankSchema.parse(bank)).not.toThrow();
    expect(bank.questions).toHaveLength(12);
    for (const q of bank.questions) {
      const labels = q.examples.map((e) => e.label);
      expect(labels).toEqual(expect.arrayContaining(["correct", "partial"]));
      expect(labels.some((l) => l === "wrong" || l === "ambiguous")).toBe(true);
    }
  });
  it("example labels match what the rubric aggregation actually produces", () => {
    for (const q of bank.questions) {
      for (const e of q.examples) {
        const r = aggregateOutcome({ criteria: e.judgements, possibleMisconception: e.possibleMisconception }, q.rubric, e.answer, q.reference.numericChecks);
        expect({ q: q.id, label: e.label, outcome: r.outcome, problems: r.problems }).toEqual({
          q: q.id,
          label: e.label,
          outcome: e.expectedOutcome,
          problems: [],
        });
        expect(validateAssessorOutput({ criteria: e.judgements, possibleMisconception: null }, q.rubric, e.answer).validity).toBe("valid");
      }
    }
  });
  it("B questions are the transfer family; A questions are initial families", () => {
    for (const q of bank.questions) expect(q.isTransfer).toBe(q.id.endsWith("-B"));
    const families = new Set(bank.questions.map((q) => q.familyId));
    expect(families.size).toBe(12);
  });
});

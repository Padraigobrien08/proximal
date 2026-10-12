// PACER classification contract: schema, grounding, limits, offline fixtures (P01-P06, P08, P09).
import { describe, expect, it } from "vitest";
import { loadPacerDevCases } from "../../src/lib/content/fixtures";
import { createMockProvider } from "../../src/lib/llm/factory";
import { OFFLINE_PACER_MESSAGE } from "../../src/lib/llm/types";
import { routeClassification, type RoutingFacts } from "../../src/lib/pacer/registry";
import {
  checkLimits,
  contextHash,
  fromWire,
  MAX_CHARS_PER_OBJECTIVE,
  validateBatch,
  validateProposal,
  validateSelection,
  wireBatchSchema,
  type PacerObjectiveInput,
} from "../../src/lib/pacer/validation";
import { openDatabase } from "../../src/lib/db/connection";

const dev = loadPacerDevCases();
const input = (id: string) => dev.cases.find((c) => c.id === id)!.input as PacerObjectiveInput;
const mock = createMockProvider(openDatabase(":memory:"));

async function offline(ids: string[]) {
  const objectives = ids.map(input);
  const res = await mock.classifyPacer({ objectives });
  return validateBatch(objectives, res.results);
}

describe("authored development set (offline fixture path; software check, not classifier accuracy)", () => {
  it("every case's offline result validates and falls inside its acceptable set", async () => {
    const { results, batchProblems } = await offline(dev.cases.map((c) => c.id));
    expect(batchProblems).toEqual([]);
    for (const c of dev.cases) {
      const r = results.find((x) => x.objectiveId === c.id)!;
      expect(r.ok, `${c.id}: ${!r.ok ? r.problems.join("; ") : ""}`).toBe(true);
      if (!r.ok) continue;
      if (c.acceptable.kind === "abstain") {
        expect(r.proposal.kind).toBe("abstain");
        if (r.proposal.kind === "abstain") expect(c.acceptable.reasons).toContain(r.proposal.reason);
      } else {
        expect(r.proposal.kind).toBe("suggestion");
        if (r.proposal.kind !== "suggestion") continue;
        expect(c.acceptable.primary).toContain(r.proposal.primary);
        for (const s of r.proposal.secondary) expect(c.acceptable.secondary).toContain(s);
      }
    }
  });

  it("P01: the same formula with calculate / explain / reference goals receives different supported proposals", async () => {
    const { results } = await offline(["F01", "F02", "F03"]);
    const primaries = results.map((r) => (r.ok && r.proposal.kind === "suggestion" ? r.proposal.primary : null));
    expect(primaries).toEqual(["procedural", "conceptual", "reference"]);
    expect(new Set(["F01", "F02", "F03"].map((id) => contextHash(input(id)))).size).toBe(3);
  });

  it("F09 / F06 arithmetic used in the fixtures is correct", () => {
    expect(-Math.log(0.8)).toBeCloseTo(0.22314355, 7);
    expect(-Math.log(0.6)).toBeCloseTo(0.51082562, 7);
    expect(0.7 * 0.8).toBeCloseTo(0.56, 10);
  });

  it("routes each accepted case to its expected authored activity when the material exists", async () => {
    const { results } = await offline(dev.cases.map((c) => c.id));
    const facts: RoutingFacts = {
      material: {
        connect: { concepts: ["a", "b"], prompt: "p", hints: [] },
        reconstruct: { prompt: "r" },
        analogy: { chunkId: "x", prompt: "p" },
        evidence: { chunkId: "x", excerpt: "e", claim: "c", prompt: "p" },
        reference: { chunkId: "x", excerpt: "e", page: 1, prompt: "p", recallPrompt: null },
      },
      hasCheckedExplanation: true,
      hasPracticeQuestion: true,
      hasApprovedAnalogyChunk: true,
      memoryRequirement: "unspecified",
    };
    for (const c of dev.cases) {
      const r = results.find((x) => x.objectiveId === c.id)!;
      if (!r.ok || r.proposal.kind !== "suggestion") continue;
      expect(routeClassification(r.proposal.primary, r.proposal.secondary, facts).primary.templateId, c.id).toBe(c.expectedActivity);
    }
  });
});

describe("P02 labels", () => {
  const base = (over: Record<string, unknown>) => ({
    kind: "suggestion",
    objectiveId: "F05",
    primary: "conceptual",
    secondary: ["procedural"],
    rationale: "Conceptual reasons and procedural steps.",
    support: [{ from: "source", chunkId: "F05-src", quote: "Log is strictly increasing for positive inputs" }],
    ambiguityNote: null,
    ...over,
  });
  it("accepts a mixed primary/secondary result", () => {
    expect(validateProposal(input("F05"), base({})).ok).toBe(true);
  });
  it("rejects duplicate, unknown, primary-repeating and excessive labels", () => {
    expect(validateProposal(input("F05"), base({ secondary: ["procedural", "procedural"] })).ok).toBe(false);
    expect(validateProposal(input("F05"), base({ secondary: ["mnemonic"] })).ok).toBe(false);
    expect(validateProposal(input("F05"), base({ primary: "visual" })).ok).toBe(false);
    expect(validateProposal(input("F05"), base({ secondary: ["conceptual"] })).ok).toBe(false);
    expect(validateProposal(input("F05"), base({ secondary: ["procedural", "reference", "supporting_evidence"] })).ok).toBe(false);
  });
  it("rejects a rationale that does not explain every proposed type", () => {
    const r = validateProposal(input("F05"), base({ rationale: "Conceptual: it is about reasons." }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(" ")).toMatch(/procedural/);
  });
  it("manual selections follow the same label rules", () => {
    expect(validateSelection("conceptual", ["procedural"])).toEqual({ primary: "conceptual", secondary: ["procedural"] });
    expect(() => validateSelection("conceptual", ["conceptual"])).toThrow();
    expect(() => validateSelection("conceptual", ["reference", "reference"])).toThrow();
    expect(() => validateSelection("conceptual", ["reference", "procedural", "analogous"])).toThrow();
    expect(() => validateSelection("learning_style", [])).toThrow();
  });
});

describe("P03 abstention", () => {
  it("unreliable extraction abstains instead of forcing a category", async () => {
    const { results } = await offline(["F11"]);
    expect(results[0].ok && results[0].proposal.kind === "abstain" && results[0].proposal.reason).toBe("unreliable_extraction");
  });
  it("an abstention needs a reason and no labels", () => {
    expect(validateProposal(input("F11"), { kind: "abstain", objectiveId: "F11", reason: "unclear_goal", message: "Goal unclear." }).ok).toBe(true);
    expect(validateProposal(input("F11"), { kind: "abstain", objectiveId: "F11", reason: "too_hard", message: "x" }).ok).toBe(false);
    expect(validateProposal(input("F11"), { kind: "abstain", objectiveId: "F11", reason: "unclear_goal", message: "x", primary: "conceptual" }).ok).toBe(false);
  });
});

describe("P04 ids and grounding", () => {
  it("unknown objective/chunk ids and invented quotes never become suggestions", () => {
    for (const v of dev.invalidResponses) {
      const { results, batchProblems } = validateBatch([input(v.caseId)], v.results);
      expect(results[0].ok, v.id).toBe(false);
      if (v.id === "V01") {
        expect(batchProblems.join(" ")).toMatch(/unknown objective id "F99"/);
        expect(!results[0].ok && results[0].problems.join(" ")).toMatch(/unknown chunk id F02-missing/);
      }
      if (v.id === "V02") expect(!results[0].ok && results[0].problems.join(" ")).toMatch(/quote not found/);
    }
  });
  it("missing and duplicate results for a requested objective are errors", () => {
    const ann = dev.cases.find((c) => c.id === "F04")!.annotation;
    expect(validateBatch([input("F04")], []).results[0].ok).toBe(false);
    expect(validateBatch([input("F04")], [{ ...ann, objectiveId: "F04" }, { ...ann, objectiveId: "F04" }]).results[0].ok).toBe(false);
  });
  it("support requires at least one item and bounded text", () => {
    const ok = { ...dev.cases.find((c) => c.id === "F04")!.annotation, objectiveId: "F04" };
    expect(validateProposal(input("F04"), { ...ok, support: [] }).ok).toBe(false);
    expect(validateProposal(input("F04"), { ...ok, rationale: "conceptual ".repeat(50) }).ok).toBe(false);
    expect(validateProposal(input("F04"), { ...ok, support: [{ from: "source", chunkId: "F04-src", quote: "x".repeat(241) }] }).ok).toBe(false);
  });
  it("learner-context quotes must come from an actually supplied connection", () => {
    const p = {
      kind: "suggestion",
      objectiveId: "F08",
      primary: "analogous",
      secondary: ["conceptual"],
      rationale: "Analogous: the learner's own comparison. Conceptual: the principle.",
      support: [{ from: "learner_context", quote: "like a referee penalising a confident foul" }],
      ambiguityNote: null,
    };
    expect(validateProposal(input("F08"), p).ok).toBe(false);
    const withConnection = { ...input("F08"), learnerConnection: "It is like a referee penalising a confident foul more heavily." };
    expect(validateProposal(withConnection, p).ok).toBe(true);
  });
});

describe("P05 prompt injection", () => {
  it("the injected text is classified as data (no blanket procedural label)", async () => {
    const { results } = await offline(["F12"]);
    expect(results[0].ok && results[0].proposal.kind === "suggestion" && results[0].proposal.primary).toBe("conceptual");
  });
  it("model output cannot add fields, commands or extra state through the wire schema", () => {
    const wire = {
      results: [
        {
          kind: "suggestion",
          objectiveId: "F12",
          primary: "procedural",
          secondary: [],
          rationale: "procedural",
          support: [],
          ambiguityNote: null,
          abstainReason: null,
          message: null,
          markMastered: ["S1", "S2"],
        },
      ],
    };
    expect(wireBatchSchema.safeParse(wire).success).toBe(false);
    expect(wireBatchSchema.safeParse({ results: [], tool_call: { name: "write_state" } }).success).toBe(false);
  });
  it("a wire result converts into the discriminated union before validation", () => {
    const w = wireBatchSchema.parse({
      results: [
        {
          kind: "abstain",
          objectiveId: "F11",
          primary: null,
          secondary: [],
          rationale: null,
          support: [],
          ambiguityNote: null,
          abstainReason: "insufficient_context",
          message: "Not enough context.",
        },
      ],
    });
    expect(validateProposal(input("F11"), fromWire(w.results[0])).ok).toBe(true);
  });
});

describe("P06 analogous needs an explicit comparison", () => {
  it("F07's authored analogy supports A; F08 without one rejects A", () => {
    const a = {
      kind: "suggestion",
      primary: "analogous",
      secondary: [],
      rationale: "Analogous: an explicit comparison.",
      ambiguityNote: null,
    };
    expect(
      validateProposal(input("F07"), { ...a, objectiveId: "F07", support: [{ from: "source", chunkId: "F07-analogy", quote: "Think of BCE as a penalty" }] }).ok,
    ).toBe(true);
    const r = validateProposal(input("F08"), {
      ...a,
      objectiveId: "F08",
      support: [{ from: "source", chunkId: "F08-src", quote: "BCE penalises assigning low probability to the true label." }],
    });
    expect(r.ok).toBe(false);
  });
  it("a conceptual objective may offer analogy creation without relabelling it analogous", () => {
    const route = routeClassification("conceptual", [], {
      material: { connect: { concepts: ["a", "b"], prompt: "p", hints: [] }, reconstruct: { prompt: "r" }, createAnalogy: { prompt: "Make your own" } },
      hasCheckedExplanation: true,
      hasPracticeQuestion: true,
      hasApprovedAnalogyChunk: false,
      memoryRequirement: "unspecified",
    });
    expect(route.primary.type).toBe("conceptual");
    expect(route.secondary?.templateId).toBe("create_analogy");
    expect(route.secondary?.type).toBe("conceptual");
  });
});

describe("P08 offline provider", () => {
  it("unfamiliar material abstains with an honest offline message", async () => {
    const unfamiliar: PacerObjectiveInput = { ...input("F04"), objective: "Explain the role of the independence assumption" };
    const res = await mock.classifyPacer({ objectives: [unfamiliar] });
    expect(res.results[0]).toEqual({ kind: "abstain", objectiveId: "F04", reason: "insufficient_context", message: OFFLINE_PACER_MESSAGE });
    expect(res.meta.mode).toBe("mock");
    expect(res.meta.model).toBeNull();
  });
});

describe("P09 bounded input", () => {
  it("over-limit inputs are reported per objective and in total, never truncated", () => {
    const big: PacerObjectiveInput = { ...input("F04"), chunks: [{ ...input("F04").chunks[0], text: "x".repeat(MAX_CHARS_PER_OBJECTIVE + 1) }] };
    const problems = checkLimits([big]);
    expect(problems.some((p) => p.objectiveId === "F04")).toBe(true);
    expect(big.chunks[0].text.length).toBe(MAX_CHARS_PER_OBJECTIVE + 1);
    const many = Array.from({ length: 11 }, (_, i) => ({ ...input("F04"), objectiveId: `X${i}` }));
    expect(checkLimits(many).some((p) => p.objectiveId === null && /at most 10/.test(p.message))).toBe(true);
    const wide = Array.from({ length: 7 }, (_, i) => ({ ...input("F04"), objectiveId: `W${i}`, chunks: [{ ...input("F04").chunks[0], text: "y".repeat(1900) }] }));
    expect(checkLimits(wide).some((p) => p.objectiveId === null && /in total/.test(p.message))).toBe(true);
  });
});

describe("bounded batching", () => {
  it("splits by count and total characters without dropping objectives", async () => {
    const { planBatches, MAX_SOURCE_CHARS_TOTAL } = await import("../../src/lib/pacer/validation");
    const mk = (i: number, n: number): PacerObjectiveInput => ({ ...input("F04"), objectiveId: `B${i}`, chunks: [{ ...input("F04").chunks[0], text: "w".repeat(n) }] });
    const many = Array.from({ length: 23 }, (_, i) => mk(i, 100));
    const p1 = planBatches(many);
    expect(p1.batches.map((b) => b.length)).toEqual([10, 10, 3]);
    const wide = Array.from({ length: 6 }, (_, i) => mk(i, 3500));
    const p2 = planBatches(wide);
    expect(p2.batches.flat()).toHaveLength(6);
    for (const b of p2.batches) expect(b.reduce((n, o) => n + o.objective.length + o.chunks[0].text.length, 0)).toBeLessThanOrEqual(MAX_SOURCE_CHARS_TOTAL);
    expect(planBatches([mk(0, 5000)]).tooLarge.map((o) => o.objectiveId)).toEqual(["B0"]);
  });
});

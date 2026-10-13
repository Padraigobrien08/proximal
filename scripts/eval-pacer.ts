// PACER classification report on the authored development cases (fixtures/pacer/dev-cases.json).
// `--mode mock` (default) is a software check: the offline provider returns the authored annotation for an exactly
// matching context, so agreement is trivially high and measures nothing about a model. `--mode live --yes` sends the
// cases to the configured live provider (curriculum job model) and spends API credits.
// Usage: npm run eval:pacer [-- --mode live --yes] [--repeat N]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPacerDevCases } from "../src/lib/content/fixtures";
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrate";
import { readEnv } from "../src/lib/env";
import { createLiveProvider, createMockProvider } from "../src/lib/llm/factory";
import { MeteredProvider } from "../src/lib/llm/metered";
import type { LearningProvider } from "../src/lib/llm/types";
import { DEFAULT_TEMPLATE } from "../src/lib/pacer/registry";
import type { PacerType } from "../src/lib/pacer/taxonomy";
import { planBatches, validateBatch, validateProposal, type PacerObjectiveInput } from "../src/lib/pacer/validation";
import { arg, dataDir, flag, loadDotEnv } from "./_lib";

loadDotEnv();
const mode = (arg("mode") ?? "mock") as "mock" | "live";
if (mode !== "mock" && mode !== "live") throw new Error("--mode must be mock or live");
const repeat = Math.max(1, Math.min(10, Number(arg("repeat") ?? 1)));
const dev = loadPacerDevCases();
const inputs = dev.cases.map((c) => c.input as PacerObjectiveInput);
const { batches, tooLarge } = planBatches(inputs);

let provider: LearningProvider;
if (mode === "live") {
  let env;
  try {
    env = readEnv();
  } catch (err) {
    console.error(`Live evaluation needs a configured live provider: ${(err as Error).message} Nothing was run.`);
    process.exit(1);
  }
  if (env.LLM_MODE === "mock") {
    console.error("Live evaluation requires LLM_MODE=anthropic or LLM_MODE=openai with that provider's key and model. Nothing was run.");
    process.exit(1);
  }
  const live = createLiveProvider(env);
  if (!flag("yes")) {
    console.error(`Live PACER evaluation will make ${batches.length * repeat} paid API calls to ${live.vendor}:${live.models.curriculum}. Re-run with --yes to proceed.`);
    process.exit(1);
  }
  const appDb = openDatabase(databasePath(dataDir()));
  runMigrations(appDb);
  provider = new MeteredProvider(live, { db: appDb, limits: env.limits });
} else {
  const db = openDatabase(":memory:");
  runMigrations(db);
  provider = createMockProvider(db);
}

type Outcome = { valid: boolean; kind: string | null; primary: PacerType | null; secondary: PacerType[]; problems: string[] };

async function classifyAll(): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  for (const batch of batches) {
    try {
      const res = await provider.classifyPacer!({ objectives: batch });
      const checked = validateBatch(batch, res.results);
      batch.forEach((o, i) => {
        const r = checked.results[i];
        if (!r.ok) out.set(o.objectiveId, { valid: false, kind: null, primary: null, secondary: [], problems: [...r.problems, ...checked.batchProblems] });
        else {
          const p = r.proposal as { kind: string; primary?: PacerType; secondary?: PacerType[] };
          out.set(o.objectiveId, { valid: true, kind: p.kind, primary: p.primary ?? null, secondary: p.secondary ?? [], problems: [] });
        }
      });
    } catch (err) {
      for (const o of batch) out.set(o.objectiveId, { valid: false, kind: null, primary: null, secondary: [], problems: [`provider error: ${(err as Error).message}`] });
    }
  }
  return out;
}

const runs: Map<string, Outcome>[] = [];
for (let k = 0; k < repeat; k++) runs.push(await classifyAll());

const rows = dev.cases.map((c) => {
  const acceptable = c.acceptable as { kind: "suggestion" | "abstain"; primary?: PacerType[]; secondary?: PacerType[] };
  const first = runs[0].get(c.id) ?? { valid: false, kind: null, primary: null, secondary: [], problems: ["not classified (too large)"] };
  const kindMatch = first.kind === acceptable.kind;
  const primaryOk = acceptable.kind === "abstain" ? kindMatch : kindMatch && !!first.primary && (acceptable.primary ?? []).includes(first.primary);
  const activity = first.primary ? DEFAULT_TEMPLATE[first.primary] : null;
  const runPrimaries = runs.map((r) => r.get(c.id)?.primary ?? r.get(c.id)?.kind ?? "invalid");
  return {
    id: c.id,
    acceptable,
    expectedActivity: c.expectedActivity ?? null,
    predicted: { kind: first.kind, primary: first.primary, secondary: first.secondary },
    valid: first.valid,
    acceptablePrimary: primaryOk,
    activityMatches: c.expectedActivity ? activity === c.expectedActivity : null,
    problems: first.problems,
    ...(repeat > 1
      ? { runPrimaries, stable: new Set(runPrimaries).size === 1, runProblems: runs.map((r) => r.get(c.id)?.problems ?? []).filter((p) => p.length > 0) }
      : {}),
  };
});

// The invalid-response fixtures must be rejected by validation (software check of the validator, any mode).
const validatorChecks = dev.invalidResponses.map((v) => {
  const input = inputs.find((i) => i.objectiveId === v.caseId)!;
  const results = (v.results as unknown[]).map((r) => validateProposal(input, r));
  return { id: v.id, description: v.description, allRejected: results.every((r) => !r.ok) };
});

const ok = (b: boolean) => (b ? 1 : 0);
const report = {
  label:
    mode === "mock"
      ? "Software check of the offline path: authored annotations are returned for exactly matching contexts. Not an evaluation of a classifier."
      : "Live classifier run on authored development cases. Not a held-out benchmark; acceptable label sets are provisional and not owner-reviewed.",
  provider: { mode, vendor: provider.vendor ?? null, model: provider.models?.curriculum ?? null },
  casesFile: "fixtures/pacer/dev-cases.json",
  casesStatus: dev.status,
  generatedAt: new Date().toISOString(),
  counts: {
    total: rows.length,
    valid: rows.reduce((n, r) => n + ok(r.valid), 0),
    acceptablePrimary: rows.reduce((n, r) => n + ok(r.acceptablePrimary), 0),
    activityMatches: rows.filter((r) => r.activityMatches !== null).reduce((n, r) => n + ok(!!r.activityMatches), 0),
    activityCases: rows.filter((r) => r.activityMatches !== null).length,
    tooLarge: tooLarge.length,
  },
  stability: repeat > 1 ? { repeat, unstableCases: rows.filter((r) => r.stable === false).length } : null,
  validatorChecks,
  rows,
};

mkdirSync("reports", { recursive: true });
const out = path.join("reports", `eval-pacer-${mode}-${report.generatedAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(report.label);
console.log(`Provider: ${mode}${report.provider.model ? ` (${report.provider.vendor}:${report.provider.model})` : ""}`);
console.log(`Cases: ${report.counts.total} · valid: ${report.counts.valid} · acceptable primary type: ${report.counts.acceptablePrimary} · expected activity: ${report.counts.activityMatches}/${report.counts.activityCases}`);
if (report.stability) console.log(`Stability over ${repeat} runs: ${report.stability.unstableCases} case(s) changed primary type`);
console.log(`Validator: ${validatorChecks.filter((v) => v.allRejected).length}/${validatorChecks.length} invalid-response fixtures rejected`);
for (const r of rows.filter((x) => !x.acceptablePrimary)) {
  console.log(`  ${r.id}: expected ${r.acceptable.kind === "abstain" ? "abstain" : r.acceptable.primary?.join(" or ")}, got ${r.predicted.primary ?? r.predicted.kind ?? "invalid"}${r.problems.length ? ` (${r.problems.slice(0, 2).join("; ")})` : ""}`);
}
console.log(`Report: ${out}`);

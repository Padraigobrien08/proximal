// Fixture evaluation harness. `--mode mock` (default) is a software check of the offline path, not a model evaluation.
// `--mode live` uses the configured live provider (LLM_MODE=anthropic|openai with its key and model) and spends API credits.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadFixtures, SAMPLE_PDF_PATH } from "../src/lib/content/fixtures";
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { MeteredProvider } from "../src/lib/llm/metered";
import { runMigrations } from "../src/lib/db/migrate";
import { aggregateOutcome } from "../src/lib/domain/assessment";
import type { AttemptOutcome } from "../src/lib/domain/types";
import { readEnv } from "../src/lib/env";
import { createLiveProvider, createMockProvider } from "../src/lib/llm/factory";
import type { LearningProvider } from "../src/lib/llm/types";
import { seedDemo } from "../src/lib/services/seed";
import { arg, dataDir, flag, loadDotEnv } from "./_lib";

loadDotEnv();
const mode = (arg("mode") ?? "mock") as "mock" | "live";
if (mode !== "mock" && mode !== "live") throw new Error("--mode must be mock or live");
const casesFile = path.resolve(arg("cases") ?? "fixtures/eval/cases.jsonl");
const limit = arg("limit") ? Number(arg("limit")) : undefined;
// Grade every case this many times to measure run-to-run stability (live grading is not deterministic).
const repeat = Math.max(1, Math.min(10, Number(arg("repeat") ?? 1)));

const caseSchema = z.strictObject({
  questionId: z.string(),
  answer: z.string(),
  expectedOutcome: z.enum(["pass", "partial", "fail", "uncertain"]),
  caseType: z.enum(["correct", "partial", "incorrect", "ambiguous", "equivalent", "injection"]),
});
const cases = readFileSync(casesFile, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => caseSchema.parse(JSON.parse(l)))
  .slice(0, limit);

// Isolated in-memory DB so the harness never touches learner data.
const db = openDatabase(":memory:");
runMigrations(db);
const tmp = path.resolve(".test-data/eval");
mkdirSync(tmp, { recursive: true });
await seedDemo({ db, now: Date.now(), dataDir: tmp, samplePdfPath: SAMPLE_PDF_PATH, fixtures: loadFixtures() });
const bank = loadFixtures().bank;

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
    console.error(
      `Live evaluation will make ${cases.length * repeat} paid API calls to ${live.vendor}:${live.model}. Re-run with --yes to proceed (use --limit N to run fewer).`,
    );
    process.exit(1);
  }
  // Live eval calls are metered into the app database (npm run usage) and respect the daily caps.
  const appDb = openDatabase(databasePath(dataDir()));
  runMigrations(appDb);
  provider = Object.assign(new MeteredProvider(live, { db: appDb, limits: env.limits }), {
    vendor: live.vendor,
    model: live.model,
    models: live.models,
  });
} else {
  provider = createMockProvider(db);
}

const outcomes: AttemptOutcome[] = ["pass", "partial", "fail", "uncertain"];
const confusion: Record<string, Record<string, number>> = Object.fromEntries(
  outcomes.map((e) => [e, Object.fromEntries(outcomes.map((p) => [p, 0]))]),
);
const rows: unknown[] = [];
let providerErrors = 0;

type Judgement = { criterionId: string; status: string; briefReason: string };
async function gradeOnce(c: (typeof cases)[number]): Promise<{ predicted: AttemptOutcome; problems: string[]; criteria: Judgement[]; misconception: string | null }> {
  const q = bank.questions.find((x) => x.id === c.questionId);
  if (!q) throw new Error(`Unknown question ${c.questionId}`);
  try {
    const { output } = await provider.assessAnswer({
      questionId: q.id,
      taskType: q.taskType,
      prompt: q.prompt,
      rubric: q.rubric,
      reference: q.reference,
      sourceText: "",
      answer: c.answer,
    });
    const agg = aggregateOutcome(output, q.rubric, c.answer, q.reference.numericChecks);
    return {
      predicted: agg.outcome,
      problems: agg.problems,
      criteria: output.criteria.map((j) => ({ criterionId: j.criterionId, status: j.status, briefReason: j.briefReason })),
      misconception: output.possibleMisconception,
    };
  } catch (err) {
    providerErrors += 1;
    return { predicted: "uncertain", problems: [`provider error: ${(err as Error).message}`], criteria: [], misconception: null };
  }
}

for (const c of cases) {
  const runs = [];
  for (let k = 0; k < repeat; k++) runs.push(await gradeOnce(c));
  // The first run is scored; the others measure whether the same answer gets the same outcome.
  const { predicted, problems, criteria, misconception } = runs[0];
  confusion[c.expectedOutcome][predicted] += 1;
  const outcomes = runs.map((r) => r.predicted);
  rows.push({ ...c, predicted, problems, criteria, misconception, ...(repeat > 1 ? { runOutcomes: outcomes, stable: new Set(outcomes).size === 1 } : {}) });
}

const definiteNonPass = cases.filter((c) => c.expectedOutcome === "partial" || c.expectedOutcome === "fail");
const falsePromotions = (rows as { expectedOutcome: string; predicted: string }[]).filter(
  (r) => (r.expectedOutcome === "partial" || r.expectedOutcome === "fail") && r.predicted === "pass",
).length;
const definiteExpected = cases.filter((c) => c.expectedOutcome !== "uncertain");
const predictedUncertain = (rows as { predicted: string }[]).filter((r) => r.predicted === "uncertain").length;
const definiteDecided = (rows as { expectedOutcome: string; predicted: string }[]).filter(
  (r) => r.expectedOutcome !== "uncertain" && r.predicted !== "uncertain",
).length;
const exactMatches = (rows as { expectedOutcome: string; predicted: string }[]).filter((r) => r.expectedOutcome === r.predicted).length;

const report = {
  label:
    mode === "mock"
      ? "Software check of the offline fixture path (exact-match demo answers only). Not an evaluation of AI grading."
      : "Live provider run on authored development cases. Not a held-out benchmark; labels are provisional until reviewed by a person.",
  // The eval exercises the assessment job; all job models are recorded for context.
  provider: { mode, vendor: provider.vendor ?? null, assessModel: provider.model, models: provider.models ?? null },
  casesFile: path.relative(process.cwd(), casesFile),
  generatedAt: new Date().toISOString(),
  counts: {
    total: cases.length,
    byExpected: Object.fromEntries(outcomes.map((o) => [o, cases.filter((c) => c.expectedOutcome === o).length])),
    byCaseType: Object.fromEntries(
      [...new Set(cases.map((c) => c.caseType))].map((t) => [t, cases.filter((c) => c.caseType === t).length]),
    ),
    exactMatches,
    providerErrors,
  },
  confusionMatrix: { rows: "expected", columns: "predicted", matrix: confusion },
  abstention: { predictedUncertain, rate: cases.length ? predictedUncertain / cases.length : 0 },
  decisionCoverage: {
    definiteExpected: definiteExpected.length,
    decided: definiteDecided,
    rate: definiteExpected.length ? definiteDecided / definiteExpected.length : 0,
  },
  falsePromotions: { count: falsePromotions, denominatorDefiniteNonPass: definiteNonPass.length },
  /** With --repeat: cases whose outcome changed between runs, and any run that promoted a definite partial/fail. */
  stability:
    repeat > 1
      ? (() => {
          const r = rows as { stable: boolean; expectedOutcome: string; runOutcomes: string[] }[];
          return {
            repeat,
            unstableCases: r.filter((x) => !x.stable).length,
            anyRunFalsePromotions: r.filter((x) => (x.expectedOutcome === "partial" || x.expectedOutcome === "fail") && x.runOutcomes.includes("pass")).length,
          };
        })()
      : null,
  mismatches: (rows as { questionId: string; caseType: string; expectedOutcome: string; predicted: string }[])
    .filter((r) => r.expectedOutcome !== r.predicted)
    .map((r) => ({ questionId: r.questionId, caseType: r.caseType, expected: r.expectedOutcome, predicted: r.predicted })),
  expectedUncertainCases: (rows as { expectedOutcome: string }[]).filter((r) => r.expectedOutcome === "uncertain"),
  rows,
};

mkdirSync("reports", { recursive: true });
const out = path.join("reports", `eval-${mode}-${report.generatedAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(report.label);
console.log(`Provider: ${mode}${provider.model ? ` (${provider.vendor}:${provider.model})` : ""}`);
console.log(`Cases: ${cases.length} · exact matches: ${exactMatches} · abstentions: ${predictedUncertain} · provider errors: ${providerErrors}`);
console.log(`Decision coverage on definite cases: ${definiteDecided}/${definiteExpected.length}`);
console.log(`False promotions: ${falsePromotions} of ${definiteNonPass.length} definite partial/fail cases`);
if (report.stability) {
  console.log(
    `Stability over ${repeat} runs: ${report.stability.unstableCases} case(s) changed outcome; ${report.stability.anyRunFalsePromotions} case(s) promoted in at least one run`,
  );
}
for (const m of report.mismatches) console.log(`  mismatch ${m.questionId} (${m.caseType}): expected ${m.expected}, got ${m.predicted}`);
console.log(`Report: ${out}`);
db.close();

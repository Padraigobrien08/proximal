// Live smoke test: one real call per provider job (assessment, tutor, chat, curriculum, PACER, question drafts), run
// through the same services and validators the app uses. Learner data is never touched: the demo is seeded into a
// temporary database. Calls are metered into the app database (npm run usage) and respect the daily caps.
// Usage: npm run smoke:live -- --yes [--only assess,tutor,chat,curriculum,parts,ocr,pacer,questions]
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { systemClock } from "../src/lib/clock";
import { loadFixtures, SAMPLE_PDF_PATH } from "../src/lib/content/fixtures";
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrate";
import { aggregateOutcome } from "../src/lib/domain/assessment";
import { readEnv } from "../src/lib/env";
import { createLiveProvider } from "../src/lib/llm/factory";
import { MeteredProvider } from "../src/lib/llm/metered";
import { askChat } from "../src/lib/services/chat";
import type { AppContext } from "../src/lib/services/context";
import { draftCurriculumInParts, importPdf } from "../src/lib/services/imports";
import { planCurriculumParts } from "../src/lib/content/chunking";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { renderPagesAsJpeg } from "../src/lib/pdf/render";
import { classifyTopic } from "../src/lib/services/pacer";
import { checkDraftBatch } from "../src/lib/questions/drafts";
import { selfCheckDraft } from "../src/lib/services/questionDrafts";
import { seedDemo } from "../src/lib/services/seed";
import { arg, dataDir, flag, loadDotEnv } from "./_lib";

const JOBS = ["assess", "tutor", "chat", "curriculum", "parts", "ocr", "pacer", "questions"] as const;
type Job = (typeof JOBS)[number];
// Paid calls per job, so the confirmation message is exact.
const CALLS: Record<Job, number> = { assess: 2, tutor: 1, chat: 1, curriculum: 1, parts: 3, ocr: 1, pacer: 1, questions: 7 };

loadDotEnv();
const only = arg("only")?.split(",").map((s) => s.trim()) as Job[] | undefined;
for (const j of only ?? []) if (!JOBS.includes(j)) throw new Error(`--only accepts ${JOBS.join(", ")}`);
const jobs = only ?? [...JOBS];

let env;
try {
  env = readEnv();
} catch (err) {
  console.error(`The live smoke test needs a configured live provider: ${(err as Error).message} Nothing was run.`);
  process.exit(1);
}
if (env.LLM_MODE === "mock") {
  console.error("The live smoke test requires LLM_MODE=anthropic or LLM_MODE=openai with that provider's key and model. Nothing was run.");
  process.exit(1);
}
const live = createLiveProvider(env);
const total = jobs.reduce((n, j) => n + CALLS[j], 0);
if (!flag("yes")) {
  console.error(`The live smoke test will make ${total} paid API calls to ${live.vendor} (${jobs.join(", ")}). Re-run with --yes to proceed.`);
  process.exit(1);
}

const appDb = openDatabase(databasePath(dataDir()));
runMigrations(appDb);
const provider = Object.assign(new MeteredProvider(live, { db: appDb, limits: env.limits }), {
  vendor: live.vendor,
  model: live.model,
  models: live.models,
});

const dir = mkdtempSync(path.join(os.tmpdir(), "proximal-smoke-"));
const db = openDatabase(databasePath(dir));
runMigrations(db);
const fixtures = loadFixtures();
await seedDemo({ db, now: Date.now(), dataDir: dir, samplePdfPath: SAMPLE_PDF_PATH, fixtures });
const ctx: AppContext = {
  db,
  clock: systemClock,
  provider,
  providerStatus: { mode: "live", vendor: live.vendor, model: live.model, models: live.models, ready: true, message: "smoke test" },
  timezone: env.PROXIMAL_TIMEZONE,
};
const demoCourse = db.prepare("SELECT id FROM courses WHERE is_demo = 1 LIMIT 1").get() as { id: string };
const bceTopic = db
  .prepare("SELECT id FROM topics WHERE course_id = ? AND title LIKE '%cross-entropy%' LIMIT 1")
  .get(demoCourse.id) as { id: string } | undefined;
const pageText = (p: (typeof fixtures.lecture.pages)[number]) => `${p.heading}\n${p.paragraphs.join("\n")}`;

type Result = { job: string; ok: boolean; detail: string; ms: number };
const results: Result[] = [];

async function check(job: string, fn: () => Promise<{ ok: boolean; detail: string }>) {
  const start = Date.now();
  try {
    const r = await fn();
    results.push({ job, ...r, ms: Date.now() - start });
  } catch (err) {
    results.push({ job, ok: false, detail: `${(err as Error).name}: ${(err as Error).message}`, ms: Date.now() - start });
  }
  const r = results.at(-1)!;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.job.padEnd(18)} ${(r.ms / 1000).toFixed(1).padStart(5)}s  ${r.detail}`);
}

// Assessment: S5-A graded twice against its frozen rubric. The correct example must pass and the sign error must not.
if (jobs.includes("assess")) {
  const q = fixtures.bank.questions.find((x) => x.id === "S5-A")!;
  for (const [label, expectPass] of [["correct", true], ["wrong", false]] as const) {
    const answer = q.examples.find((e) => e.label === label)!.answer;
    await check(`assess S5-A ${label}`, async () => {
      const { output, meta } = await provider.assessAnswer({
        questionId: q.id,
        taskType: q.taskType,
        prompt: q.prompt,
        rubric: q.rubric,
        reference: q.reference,
        sourceText: "",
        answer,
      });
      const agg = aggregateOutcome(output, q.rubric, answer, q.reference.numericChecks);
      const ok = expectPass ? agg.outcome === "pass" : agg.outcome !== "pass";
      return { ok, detail: `outcome ${agg.outcome} (${meta.vendor}:${meta.model}, ${meta.usage?.outputTokens ?? "?"} out tokens)` };
    });
  }
}

if (jobs.includes("tutor")) {
  await check("tutor", async () => {
    const { explanation, meta } = await provider.tutor({
      objective: "Calculate BCE and use aggregate losses to compare predictions",
      sourcePages: fixtures.lecture.pages.filter((p) => p.page === 5).map((p) => ({ page: p.page, text: pageText(p) })),
      gap: "Sign error: reported ln(0.8) instead of −ln(0.8).",
      request: "explanation",
    });
    return { ok: explanation.trim().length > 40, detail: `${explanation.trim().length} chars (${meta.model})` };
  });
}

if (jobs.includes("chat")) {
  await check("chat", async () => {
    const { messages } = await askChat(ctx, demoCourse.id, { question: "Why is binary cross-entropy not the same as accuracy?" });
    const reply = messages.at(-1)!;
    const errored = (reply as { origin?: string }).origin === "error";
    return { ok: !errored && reply.citations.length > 0, detail: `${reply.citations.length} citations, covered=${reply.covered}` };
  });
}

if (jobs.includes("curriculum")) {
  await check("curriculum import", async () => {
    const res = await importPdf(ctx, dir, { name: "smoke-sample.pdf", bytes: readFileSync(SAMPLE_PDF_PATH) });
    const units = db
      .prepare("SELECT COUNT(*) AS n FROM units u JOIN topics t ON t.id = u.topic_id WHERE t.course_id = ?")
      .get(res.courseId) as { n: number };
    return { ok: res.curriculum === "generated" && units.n >= 3, detail: `${res.curriculum}, ${units.n} draft units: ${res.message}` };
  });
}

// Part-by-part drafting, as a long PDF gets: the sample lecture forced into 3 parts of 2 pages each.
if (jobs.includes("parts")) {
  await check("curriculum in parts", async () => {
    const pages = fixtures.lecture.pages.map((p) => ({ page: p.page, text: pageText(p) }));
    const target = Math.ceil(pages.reduce((n, p) => n + p.text.length, 0) / 3);
    const plan = planCurriculumParts(pages, target, target * 2);
    if (!plan.ok) return { ok: false, detail: plan.reason };
    const draft = await draftCurriculumInParts(ctx, { sha256: "smoke-parts", fileName: "smoke-parts.pdf", pageCount: pages.length }, plan.parts);
    const units = draft.topics.flatMap((t) => t.units);
    const cited = new Set(units.flatMap((u) => u.sourcePages));
    return {
      ok: plan.parts.length === 3 && units.length >= 3,
      detail: `${plan.parts.length} parts -> ${draft.topics.length} topics, ${units.length} units, pages cited ${[...cited].sort((a, b) => a - b).join(",")}`,
    };
  });
}

// A scanned page (an image only, no text layer) with a formula, rendered the way import renders it and transcribed.
if (jobs.includes("ocr")) {
  await check("scanned page", async () => {
    const c = createCanvas(1240, 1754);
    const g = c.getContext("2d");
    g.fillStyle = "white";
    g.fillRect(0, 0, 1240, 1754);
    g.fillStyle = "black";
    g.font = "bold 44px serif";
    g.fillText("Binary cross-entropy", 100, 160);
    g.font = "34px serif";
    g.fillText("For a label y and predicted probability p:", 100, 260);
    g.fillText("BCE(y, p) = -[ y log p + (1 - y) log(1 - p) ]", 140, 340);
    g.fillText("For y = 1 and p = 0.8 the loss is about 0.223.", 100, 440);
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]).drawImage(await doc.embedPng(c.toBuffer("image/png")), { x: 0, y: 0, width: 595, height: 842 });
    const [page] = await renderPagesAsJpeg(await doc.save(), [1]);
    const { transcription, meta } = await provider.transcribePage({ page: 1, image: { mediaType: "image/jpeg", base64: page.jpeg.toString("base64") } });
    const t = transcription.text.toLowerCase();
    const ok = transcription.legible && t.includes("cross-entropy") && t.includes("0.223") && t.includes("log");
    return { ok, detail: `${transcription.text.length} chars, legible=${transcription.legible} (${meta.model}): ${JSON.stringify(transcription.text.slice(0, 160))}` };
  });
}

if (jobs.includes("pacer")) {
  await check("pacer classify", async () => {
    if (!bceTopic) return { ok: false, detail: "demo cross-entropy topic not found" };
    const res = await classifyTopic(ctx, bceTopic.id, { regenerate: true });
    if (res.providerError) return { ok: false, detail: `${res.providerError.code}: ${res.providerError.message}` };
    const statuses = res.skills.map((s) => s.status);
    const ok = res.classified > 0 && !statuses.includes("invalid") && !statuses.includes("error");
    const problems = res.batchProblems.length ? `; problems: ${res.batchProblems.join("; ")}` : "";
    return { ok, detail: `${res.classified} classified, statuses ${statuses.join("/")}${problems}` };
  });
}

// Question drafts for the calculation objective, checked by the same validator the app stores drafts with.
if (jobs.includes("questions")) {
  await check("question drafts", async () => {
    const pages = fixtures.lecture.pages.filter((p) => p.page === 5).map((p) => ({ page: p.page, text: pageText(p) }));
    const { batch, meta } = await provider.draftQuestions({
      courseTitle: "Smoke test",
      unitTitle: "Calculation and application",
      objective: "Calculate BCE and use aggregate losses to compare predictions",
      sourcePages: pages,
    });
    const { drafts, batchProblems } = checkDraftBatch(batch, [5]);
    const problems = [...batchProblems, ...drafts.flatMap((d) => (d.ok ? [] : d.problems))];
    const valid = drafts.flatMap((d) => (d.ok ? [d.question] : []));
    // Each valid draft's examples are graded against its own scheme, as the drafting job does.
    const checks = await Promise.all(valid.map((q) => selfCheckDraft(ctx, q, pages.map((p) => `[page ${p.page}]\n${p.text}`).join("\n\n"))));
    const checkText = checks.map((c) => `${c.status} (${c.results.map((r) => `${r.label}->${r.got}`).join(", ")})`).join("; ");
    return {
      ok: valid.length === 2 && problems.length === 0 && checks.every((c) => c.status === "passed"),
      detail: `${valid.length}/2 valid (${meta.model}); marking checks: ${checkText}${problems.length ? `; problems: ${problems.join("; ")}` : ""}`,
    };
  });
}

db.close();
appDb.close();
rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Usage is recorded in the app database (npm run usage).`);
process.exit(failed ? 1 : 0);

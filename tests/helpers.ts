import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixedClock } from "../src/lib/clock";
import { loadFixtures, SAMPLE_PDF_PATH } from "../src/lib/content/fixtures";
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrate";
import { createMockProvider } from "../src/lib/llm/factory";
import type { LearningProvider } from "../src/lib/llm/types";
import type { AppContext } from "../src/lib/services/context";
import { seedDemo } from "../src/lib/services/seed";
import type { EvidenceAttempt } from "../src/lib/domain/types";

export const T0 = Date.parse("2026-10-12T09:00:00Z");

export async function createTestContext(opts: { provider?: (db: AppContext["db"]) => LearningProvider; mode?: "mock" | "live" } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "proximal-test-"));
  const db = openDatabase(databasePath(dir));
  runMigrations(db);
  const clock = fixedClock(T0);
  await seedDemo({ db, now: T0, dataDir: dir, samplePdfPath: SAMPLE_PDF_PATH, fixtures: loadFixtures() });
  const provider = opts.provider ? opts.provider(db) : createMockProvider(db);
  const mode = opts.mode ?? (provider.mode === "live" ? "live" : "mock");
  const ctx: AppContext = {
    db,
    clock,
    provider,
    providerStatus: { mode, model: provider.model, ready: true, message: mode },
    timezone: "Europe/London",
    inlineJobs: true,
  };
  return {
    ctx,
    clock,
    dir,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function exampleAnswer(questionId: string, label: "correct" | "partial" | "wrong"): string {
  const q = loadFixtures().bank.questions.find((x) => x.id === questionId)!;
  return q.examples.find((e) => e.label === label)!.answer;
}

let order = 0;
export function ea(partial: Partial<EvidenceAttempt> & { submittedAt: number; sessionId: string }): EvidenceAttempt {
  order += 1;
  return {
    attemptId: `a${order}`,
    recordOrder: order,
    mode: "review",
    phase: "original",
    exposedBeforeSubmission: false,
    declaredAssistance: false,
    outcome: "pass",
    validity: "valid",
    excluded: false,
    familyId: "F-A",
    isTransfer: false,
    ...partial,
  };
}

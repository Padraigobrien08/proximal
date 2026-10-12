import "server-only";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { z } from "zod";
import { SAMPLE_PDF_PATH, loadFixtures, loadPacerDevCases } from "../content/fixtures";
import { contextHash, type PacerObjectiveInput } from "../pacer/validation";
import type { ExampleFixture } from "../content/schemas";
import { readEnv, requestedVendor, type AppEnv } from "../env";
import { ClaudeProvider } from "./claude";
import { JOB_LABEL, LLM_JOBS, type JobModels } from "./jobs";
import { MeteredProvider } from "./metered";
import { OpenAIProvider } from "./openai";
import { MockProvider } from "./mock";
import { ProviderError, type CurriculumDraft, type LearningProvider, type LiveVendor } from "./types";

export interface ProviderStatus {
  mode: "mock" | "live";
  /** Live API in use (or requested, when misconfigured). */
  vendor: LiveVendor | null;
  /** Assessment model. */
  model: string | null;
  /** Model per job (live and configured only). */
  models: JobModels | null;
  /** Where the live key came from; never the key itself. */
  keySource?: ".env" | "environment" | null;
  shellKeyIgnored?: boolean;
  ready: boolean;
  message: string;
}

/** Live misconfiguration yields a provider that always fails: never a silent mock fallback. */
class UnavailableProvider implements LearningProvider {
  readonly mode = "live" as const;
  readonly model = null;
  constructor(
    private reason: string,
    readonly vendor: LiveVendor | null,
  ) {}
  private fail(): never {
    throw new ProviderError(this.reason, "provider_unavailable", false);
  }
  async assessAnswer(): Promise<never> {
    this.fail();
  }
  async generateCurriculum(): Promise<never> {
    this.fail();
  }
  async tutor(): Promise<never> {
    this.fail();
  }
  async classifyPacer(): Promise<never> {
    this.fail();
  }
  async draftQuestions(): Promise<never> {
    this.fail();
  }
  async transcribePage(): Promise<never> {
    this.fail();
  }
}

export function fixtureCurriculumDraft(): CurriculumDraft {
  const { curriculum } = loadFixtures();
  return {
    topics: curriculum.topics.map((t) => ({
      title: t.title,
      units: t.units.map((u) => ({
        title: u.title,
        objective: u.objective,
        sourcePages: u.sourcePages,
        skills: u.skills.map((s) => ({ objective: s.objective })),
      })),
    })),
    suggestions: ["Optional extension: numerical care at p = 0 or p = 1 (clipping, working with logits)."],
  };
}

let annotationCache: Map<string, Record<string, unknown>> | null = null;

/** Offline PACER annotations keyed by exact context hash: demo skills (authored hashes) and the development set. */
export function pacerAnnotations(): Map<string, Record<string, unknown>> {
  if (annotationCache) return annotationCache;
  const m = new Map<string, Record<string, unknown>>();
  for (const s of loadFixtures().pacer.skills) if (s.offline?.contextHash) m.set(s.offline.contextHash, s.offline.result);
  for (const c of loadPacerDevCases().cases) m.set(contextHash(c.input as PacerObjectiveInput), c.annotation);
  annotationCache = m;
  return m;
}

let authoredDraftCache: Map<string, unknown> | null = null;

/**
 * The sample-lecture question bank in draft form, keyed by the exact skill objective of the fixture curriculum. Used
 * offline only, so an imported copy of the sample lecture can go through draft review without a model.
 */
export function authoredDrafts(): Map<string, unknown> {
  if (authoredDraftCache) return authoredDraftCache;
  const { curriculum, bank } = loadFixtures();
  const m = new Map<string, unknown>();
  for (const skill of curriculum.topics.flatMap((t) => t.units.flatMap((u) => u.skills))) {
    const questions = bank.questions
      .filter((q) => q.skillId === skill.id)
      .map((q) => ({
        familyRole: q.isTransfer ? "new_context" : "initial",
        transferChange: q.isTransfer ? "Authored new-context question from the sample bank (structurally different task)." : "",
        taskType: q.taskType,
        prompt: q.prompt,
        referenceSummary: q.reference.summary,
        criteria: q.rubric.criteria,
        numericChecks: q.reference.numericChecks,
        hints: q.hints,
        sourcePages: q.sourceRefs.map((r) => r.page),
        examples: q.examples
          .filter((e) => e.label !== "ambiguous" && e.expectedOutcome !== "uncertain")
          .map((e) => ({ label: e.label, answer: e.answer, expectedOutcome: e.expectedOutcome })),
      }));
    if (questions.length) m.set(skill.objective.trim(), { questions });
  }
  authoredDraftCache = m;
  return m;
}

export function sampleLectureSha(): string | null {
  if (!existsSync(SAMPLE_PDF_PATH)) return null;
  return createHash("sha256").update(readFileSync(SAMPLE_PDF_PATH)).digest("hex");
}

/**
 * Test-only fault injection for the offline provider: PROXIMAL_FAULT_MOCK_ASSESS_FAILURES=N makes the first N mock
 * assessment calls in this process fail as an unavailable provider, so the pending/retry path can be exercised in a
 * browser without credentials. Never applies in live mode.
 */
const faultState = globalThis as unknown as { __proximalMockFailures?: number };

export function createMockProvider(db: Database.Database): MockProvider {
  const sha = sampleLectureSha();
  const injected = Number(process.env.PROXIMAL_FAULT_MOCK_ASSESS_FAILURES ?? 0);
  if (faultState.__proximalMockFailures === undefined) faultState.__proximalMockFailures = Number.isFinite(injected) ? injected : 0;
  const provider = new MockProvider({
    examplesFor: (questionId) => {
      const row = db.prepare("SELECT examples_json FROM questions WHERE id = ?").get(questionId) as
        | { examples_json: string }
        | undefined;
      return row ? (JSON.parse(row.examples_json) as ExampleFixture[]) : [];
    },
    sampleLecture: sha ? { sha256: sha, draft: fixtureCurriculumDraft() } : null,
    pacerAnnotation: (hash) => pacerAnnotations().get(hash) ?? null,
    authoredDrafts: (objective) => authoredDrafts().get(objective) ?? null,
  });
  if (faultState.__proximalMockFailures && faultState.__proximalMockFailures > 0) {
    const real = provider.assessAnswer.bind(provider);
    provider.assessAnswer = async (input) => {
      if ((faultState.__proximalMockFailures ?? 0) > 0) {
        faultState.__proximalMockFailures! -= 1;
        throw new ProviderError("Simulated provider outage (test fault injection).", "provider_unavailable", true);
      }
      return real(input);
    };
  }
  return provider;
}

export const VENDOR_LABEL: Record<LiveVendor, string> = { anthropic: "Claude", openai: "OpenAI" };

/** The configured live provider. Callers must already have checked LLM_MODE is a live vendor. */
export function createLiveProvider(env: AppEnv): LearningProvider & { vendor: LiveVendor; model: string; models: JobModels } {
  if (!env.jobs) throw new Error("No live jobs configured.");
  if (env.LLM_MODE === "openai") return new OpenAIProvider({ apiKey: env.OPENAI_API_KEY!, jobs: env.jobs });
  return new ClaudeProvider({ apiKey: env.ANTHROPIC_API_KEY!, jobs: env.jobs });
}

export function createProvider(db: Database.Database): { provider: LearningProvider; status: ProviderStatus } {
  let env;
  try {
    env = readEnv();
  } catch (err) {
    const message =
      err instanceof z.ZodError
        ? err.issues.map((i) => i.message).join(" ")
        : err instanceof Error
          ? err.message
          : "Invalid environment.";
    const vendor = requestedVendor();
    return {
      provider: new UnavailableProvider(message, vendor),
      status: { mode: "live", vendor, model: null, models: null, ready: false, message: `Live mode is not configured: ${message}` },
    };
  }
  if (env.LLM_MODE !== "mock") {
    const live = createLiveProvider(env);
    // Every live call is metered (usage rows + structured log), capped and concurrency-limited.
    const provider = Object.assign(new MeteredProvider(live, { db, limits: env.limits }), {
      vendor: live.vendor,
      model: live.model,
      models: live.models,
    });
    return {
      provider,
      status: {
        mode: "live",
        vendor: provider.vendor,
        model: provider.model,
        models: provider.models,
        keySource: env.keyInfo.source,
        shellKeyIgnored: env.keyInfo.shellKeyIgnored,
        ready: true,
        message: `Live ${VENDOR_LABEL[provider.vendor]}: ${LLM_JOBS.map((j) => `${JOB_LABEL[j].toLowerCase()} ${provider.models[j]}`).join(", ")}`,
      },
    };
  }
  return {
    provider: createMockProvider(db),
    status: {
      mode: "mock",
      vendor: null,
      model: null,
      models: null,
      ready: true,
      message: "Offline demo: fixture answers only, no AI grading",
    },
  };
}

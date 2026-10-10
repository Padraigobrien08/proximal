import "server-only";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { SAMPLE_PDF_PATH, loadFixtures } from "../content/fixtures";
import type { ExampleFixture } from "../content/schemas";
import { readEnv } from "../env";
import { ClaudeProvider } from "./claude";
import { MockProvider } from "./mock";
import { ProviderError, type CurriculumDraft, type LearningProvider } from "./types";

export interface ProviderStatus {
  mode: "mock" | "live";
  model: string | null;
  ready: boolean;
  message: string;
}

/** Live misconfiguration yields a provider that always fails: never a silent mock fallback. */
class UnavailableProvider implements LearningProvider {
  readonly mode = "live" as const;
  readonly model = null;
  constructor(private reason: string) {}
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

export function sampleLectureSha(): string | null {
  if (!existsSync(SAMPLE_PDF_PATH)) return null;
  return createHash("sha256").update(readFileSync(SAMPLE_PDF_PATH)).digest("hex");
}

export function createMockProvider(db: Database.Database): MockProvider {
  const sha = sampleLectureSha();
  return new MockProvider({
    examplesFor: (questionId) => {
      const row = db.prepare("SELECT examples_json FROM questions WHERE id = ?").get(questionId) as
        | { examples_json: string }
        | undefined;
      return row ? (JSON.parse(row.examples_json) as ExampleFixture[]) : [];
    },
    sampleLecture: sha ? { sha256: sha, draft: fixtureCurriculumDraft() } : null,
  });
}

export function createProvider(db: Database.Database): { provider: LearningProvider; status: ProviderStatus } {
  let env;
  try {
    env = readEnv();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid environment.";
    return {
      provider: new UnavailableProvider(message),
      status: { mode: "live", model: null, ready: false, message: `Live mode is not configured: ${message}` },
    };
  }
  if (env.LLM_MODE === "live") {
    return {
      provider: new ClaudeProvider({ apiKey: env.ANTHROPIC_API_KEY!, model: env.ANTHROPIC_MODEL! }),
      status: { mode: "live", model: env.ANTHROPIC_MODEL!, ready: true, message: `Live Claude (${env.ANTHROPIC_MODEL})` },
    };
  }
  return {
    provider: createMockProvider(db),
    status: {
      mode: "mock",
      model: null,
      ready: true,
      message: "Offline demo: fixture answers only, no AI grading",
    },
  };
}

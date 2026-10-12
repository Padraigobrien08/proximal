import type Database from "better-sqlite3";
import type { Clock } from "../clock";
import type { LearningProvider } from "../llm/types";

export interface ProviderStatusLike {
  mode: "mock" | "live";
  vendor?: "anthropic" | "openai" | null;
  model: string | null;
  models?: { assess: string; curriculum: string; tutor: string } | null;
  keySource?: ".env" | "environment" | null;
  shellKeyIgnored?: boolean;
  ready: boolean;
  message: string;
}

export interface AppContext {
  db: Database.Database;
  clock: Clock;
  provider: LearningProvider;
  providerStatus: ProviderStatusLike;
  timezone: string;
  /**
   * Run queued jobs before returning instead of handing them to the background worker. Tests use this so a submitted
   * check answer is graded by the time submitAnswer resolves; the queue path itself is tested separately.
   */
  inlineJobs?: boolean;
}

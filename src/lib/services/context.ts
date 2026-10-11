import type Database from "better-sqlite3";
import type { Clock } from "../clock";
import type { LearningProvider } from "../llm/types";

export interface ProviderStatusLike {
  mode: "mock" | "live";
  vendor?: "anthropic" | "openai" | null;
  model: string | null;
  models?: { assess: string; curriculum: string; tutor: string } | null;
  ready: boolean;
  message: string;
}

export interface AppContext {
  db: Database.Database;
  clock: Clock;
  provider: LearningProvider;
  providerStatus: ProviderStatusLike;
  timezone: string;
}

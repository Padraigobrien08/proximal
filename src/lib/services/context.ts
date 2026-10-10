import type Database from "better-sqlite3";
import type { Clock } from "../clock";
import type { LearningProvider } from "../llm/types";

export interface ProviderStatusLike {
  mode: "mock" | "live";
  model: string | null;
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

import "server-only";
import { systemClock } from "./clock";
import { getDb } from "./db/connection";
import { readEnvSafe } from "./env-safe";
import { createProvider } from "./llm/factory";
import { startWorker } from "./jobs/worker";
import type { AppContext } from "./services/context";

function buildContext(): AppContext {
  const db = getDb();
  const { provider, status } = createProvider(db);
  return { db, clock: systemClock, provider, providerStatus: status, timezone: readEnvSafe().timezone };
}

/**
 * Per-request application context for route handlers. The first request also starts the background worker, which
 * resumes any job left queued or interrupted by a previous run.
 */
export function getAppContext(): AppContext {
  startWorker(buildContext);
  return buildContext();
}

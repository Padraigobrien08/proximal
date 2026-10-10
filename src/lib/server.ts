import "server-only";
import { systemClock } from "./clock";
import { getDb } from "./db/connection";
import { readEnvSafe } from "./env-safe";
import { createProvider } from "./llm/factory";
import type { AppContext } from "./services/context";

/** Per-request application context for route handlers. */
export function getAppContext(): AppContext {
  const db = getDb();
  const { provider, status } = createProvider(db);
  return { db, clock: systemClock, provider, providerStatus: status, timezone: readEnvSafe().timezone };
}

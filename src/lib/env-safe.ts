import "server-only";
import path from "node:path";

/** Non-throwing reads for values needed even when live configuration is invalid. */
export function readEnvSafe() {
  return {
    timezone: process.env.PROXIMAL_TIMEZONE || "Europe/London",
    dataDir: path.resolve(process.cwd(), process.env.PROXIMAL_DATA_DIR || "./data"),
  };
}

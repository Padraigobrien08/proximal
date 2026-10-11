// Usage summary from recorded live provider calls. No prompts, answers or keys are stored or printed.
// Usage: npm run usage [-- --days 7]
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrate";
import { readEnv } from "../src/lib/env";
import { usageSince } from "../src/lib/llm/metered";
import { arg, dataDir, loadDotEnv } from "./_lib";

loadDotEnv();
const days = Number(arg("days") ?? 7);
const db = openDatabase(databasePath(dataDir()));
runMigrations(db);
const since = Date.now() - days * 24 * 60 * 60 * 1000;

type Row = { day: string; job: string; model: string; calls: number; ok: number; errors: number; blocked: number; input: number; output: number; avg_ms: number };
const rows = db
  .prepare(
    `SELECT date(started_at / 1000, 'unixepoch') AS day, job, vendor || ':' || model AS model,
            COUNT(*) AS calls,
            SUM(status = 'ok') AS ok, SUM(status = 'error') AS errors, SUM(status = 'blocked') AS blocked,
            COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
            CAST(AVG(CASE WHEN status != 'blocked' THEN latency_ms END) AS INTEGER) AS avg_ms
     FROM provider_calls WHERE started_at > ? GROUP BY day, job, model ORDER BY day DESC, job`,
  )
  .all(since) as Row[];

if (rows.length === 0) {
  console.log(`No live provider calls recorded in the last ${days} day(s).`);
} else {
  console.log(`Live provider calls, last ${days} day(s) (UTC days):`);
  console.table(
    rows.map((r) => ({
      day: r.day,
      job: r.job,
      model: r.model,
      calls: r.calls,
      ok: r.ok,
      errors: r.errors,
      blocked: r.blocked,
      "input tok": r.input,
      "output tok": r.output,
      "avg ms": r.avg_ms,
    })),
  );
  const errs = db
    .prepare("SELECT error_code, COUNT(*) AS n FROM provider_calls WHERE started_at > ? AND status != 'ok' GROUP BY error_code ORDER BY n DESC")
    .all(since) as { error_code: string; n: number }[];
  if (errs.length) console.log("Failures by reason:", Object.fromEntries(errs.map((e) => [e.error_code, e.n])));
}

const window = usageSince(db, Date.now());
let limitsText = "limits unavailable (configuration invalid)";
try {
  const { limits } = readEnv();
  limitsText = `calls ${window.calls}/${limits.dailyCalls ?? "unlimited"}, tokens ${window.tokens}/${limits.dailyTokens ?? "unlimited"}, max concurrent ${limits.maxConcurrent}`;
} catch {
  /* keep fallback text */
}
console.log(`Rolling 24 h: ${limitsText}`);
console.log("Token counts come from the provider responses; convert to cost with your provider's current price list.");
db.close();

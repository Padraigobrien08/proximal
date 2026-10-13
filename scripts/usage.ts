// Usage summary from recorded live provider calls. No prompts, answers or keys are stored or printed.
// Estimated costs use a price list you maintain at $PROXIMAL_DATA_DIR/prices.json (or --prices <file>); no prices are
// built in. `--write-prices` creates or extends that file with every model seen, prices left null for you to fill.
// Usage: npm run usage [-- --days 7] [--prices file.json] [--write-prices]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrate";
import { readEnv } from "../src/lib/env";
import { usageSince } from "../src/lib/llm/metered";
import { estimateCost, priceListSchema, priceTemplate, type PriceList } from "../src/lib/llm/prices";
import { arg, dataDir, flag, loadDotEnv } from "./_lib";

loadDotEnv();
const days = Number(arg("days") ?? 7);
const db = openDatabase(databasePath(dataDir()));
runMigrations(db);
const since = Date.now() - days * 24 * 60 * 60 * 1000;

const pricesFile = path.resolve(arg("prices") ?? path.join(dataDir(), "prices.json"));
let prices: PriceList | null = null;
if (existsSync(pricesFile)) {
  const parsed = priceListSchema.safeParse(JSON.parse(readFileSync(pricesFile, "utf8")));
  if (parsed.success) prices = parsed.data;
  else console.error(`Ignoring ${pricesFile}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
}
const money = (n: number | null) => (n === null ? "price not set" : `${prices!.currency} ${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`);

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
      "est. cost": money(estimateCost(prices, r.model, r.input, r.output)),
    })),
  );
  // Totals per model across the period, so the bill-shaped number is easy to find.
  const byModel = new Map<string, { input: number; output: number }>();
  for (const r of rows) {
    const t = byModel.get(r.model) ?? { input: 0, output: 0 };
    t.input += r.input;
    t.output += r.output;
    byModel.set(r.model, t);
  }
  const costs = [...byModel].map(([model, t]) => ({ model, cost: estimateCost(prices, model, t.input, t.output) }));
  const known = costs.filter((c) => c.cost !== null);
  const unpriced = costs.filter((c) => c.cost === null).map((c) => c.model);
  if (known.length > 0) {
    const total = known.reduce((n, c) => n + (c.cost ?? 0), 0);
    const checked = [...new Set(known.map((c) => prices!.models[c.model].checkedOn ?? "date not recorded"))].join(", ");
    console.log(`Estimated cost, last ${days} day(s): ${money(total)}${unpriced.length ? " (priced models only)" : ""}. Prices checked: ${checked}.`);
  }
  if (unpriced.length > 0) {
    console.log(`No price set for: ${unpriced.join(", ")}. Add them to ${pricesFile} (npm run usage -- --write-prices creates the entries).`);
  }
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
console.log("Token counts come from the provider responses. Costs are estimates from your price list, not a bill.");

if (flag("write-prices")) {
  const models = (db.prepare("SELECT DISTINCT vendor || ':' || model AS m FROM provider_calls ORDER BY m").all() as { m: string }[]).map((r) => r.m);
  writeFileSync(pricesFile, JSON.stringify(priceTemplate(models, prices), null, 2) + "\n");
  console.log(`Wrote ${pricesFile} with ${models.length} model(s). Fill in each price from the provider's current price list.`);
}
db.close();

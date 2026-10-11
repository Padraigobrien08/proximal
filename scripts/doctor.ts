// Local health check: configuration, model access, database, data folders and the running server.
// Never prints API keys. Model access uses free metadata lookups. Usage: npm run doctor [-- --offline]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { pendingMigrations } from "../src/lib/db/backup";
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { MIGRATIONS_DIR } from "../src/lib/db/migrate";
import { EnvConfigError, readEnv, type AppEnv } from "../src/lib/env";
import { LLM_JOBS, JOB_LABEL } from "../src/lib/llm/jobs";
import { usageSince } from "../src/lib/llm/metered";
import { dataDir, flag } from "./_lib";

let failures = 0;
let warnings = 0;
const ok = (msg: string) => console.log(`  ok    ${msg}`);
const warn = (msg: string) => {
  warnings += 1;
  console.log(`  warn  ${msg}`);
};
const fail = (msg: string) => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};

console.log("Runtime");
const wanted = readFileSync(".nvmrc", "utf8").trim();
const major = process.versions.node.split(".")[0];
if (major === wanted) ok(`Node ${process.versions.node} (.nvmrc ${wanted})`);
else warn(`Node ${process.versions.node}; .nvmrc expects ${wanted}`);

console.log("Configuration");
let env: AppEnv | null = null;
try {
  env = readEnv();
  if (env.LLM_MODE === "mock") ok("LLM_MODE=mock (offline demo, no provider calls)");
  else {
    ok(`LLM_MODE=${env.LLM_MODE}`);
    for (const job of LLM_JOBS) {
      const j = env.jobs![job];
      ok(`${JOB_LABEL[job].padEnd(10)} ${j.model}${j.effort ? ` (effort ${j.effort})` : ""} · ${Math.round(j.timeoutMs / 1000)} s · ${j.maxOutputTokens} output tokens`);
    }
    ok(`API key set (from ${env.keyInfo.source})`);
    if (env.keyInfo.shellKeyIgnored) {
      warn("A different API key is exported in your shell; the .env key is used. Remove the shell export to avoid confusion.");
    }
  }
  const { dailyCalls, dailyTokens, maxConcurrent } = env.limits;
  ok(`Limits: ${dailyCalls ?? "unlimited"} calls/day, ${dailyTokens ?? "unlimited"} tokens/day, ${maxConcurrent} concurrent`);
  if (env.LLM_MODE !== "mock" && dailyCalls === null && dailyTokens === null) {
    warn("No daily cap set. Consider PROXIMAL_DAILY_TOKEN_LIMIT or PROXIMAL_DAILY_CALL_LIMIT in .env.");
  }
} catch (err) {
  fail(err instanceof EnvConfigError ? err.problems.join(" ") : (err as Error).message);
}

if (env && env.LLM_MODE !== "mock" && !flag("offline")) {
  console.log("Model access (metadata lookups, no tokens used)");
  const models = [...new Set(LLM_JOBS.map((j) => env!.jobs![j].model))];
  for (const id of models) {
    try {
      if (env.LLM_MODE === "openai") {
        const c = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 15_000, maxRetries: 1 });
        await c.models.retrieve(id);
      } else {
        const c = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 15_000, maxRetries: 1 });
        await c.models.retrieve(id);
      }
      ok(`${id} is available to this key`);
    } catch (err) {
      const status = (err as { status?: number }).status;
      fail(`${id}: ${status === 401 ? "key rejected" : status === 404 ? "model not found for this key" : (err as Error).constructor.name}`);
    }
  }
}

console.log("Data");
const dir = dataDir();
const file = databasePath(dir);
if (!existsSync(file)) fail(`No database at ${file}. Run npm run db:seed.`);
else {
  const db = openDatabase(file);
  const check = db.pragma("quick_check", { simple: true });
  if (check === "ok") ok(`Database ${file} (${(statSync(file).size / 1024).toFixed(0)} KB), integrity ok`);
  else fail(`Database integrity check: ${String(check)}`);
  const pending = pendingMigrations(db, MIGRATIONS_DIR);
  if (pending.length) warn(`Pending migrations (applied on next start, after a backup): ${pending.join(", ")}`);
  else ok("Schema up to date");
  const hasCalls = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'provider_calls'").get();
  if (hasCalls) {
    const u = usageSince(db, Date.now());
    ok(`Last 24 h: ${u.calls} live call(s), ${u.tokens} token(s)`);
  }
  db.close();
}
const backups = path.join(dir, "backups");
const list = existsSync(backups) ? readdirSync(backups).sort() : [];
if (list.length === 0) warn("No backups yet. Run npm run db:backup.");
else ok(`${list.length} backup(s); latest ${list[list.length - 1]}`);

console.log("Running server (http://127.0.0.1:3000)");
try {
  const res = await fetch("http://127.0.0.1:3000/api/courses", { signal: AbortSignal.timeout(3000) });
  const body = (await res.json()) as { data?: { provider: { mode: string; vendor?: string; ready: boolean; models?: Record<string, string> | null; keySource?: string } } };
  const p = body.data?.provider;
  if (!p) warn("Server responded without provider status.");
  else if (!p.ready) fail("Server reports its live provider is not configured. Restart it after editing .env.");
  else if (env && env.LLM_MODE !== "mock" && (p.vendor !== env.LLM_MODE || JSON.stringify(p.models) !== JSON.stringify(Object.fromEntries(LLM_JOBS.map((j) => [j, env!.jobs![j].model]))))) {
    warn("The running server's provider settings differ from .env. Restart the server.");
  } else ok(`Server is using ${p.mode === "mock" ? "offline demo mode" : `${p.vendor}${p.keySource ? ` (key from ${p.keySource})` : ""}`}`);
} catch {
  warn("No server responding on 127.0.0.1:3000 (start it with npm run dev).");
}

console.log(failures ? `\n${failures} problem(s), ${warnings} warning(s).` : `\nAll checks passed${warnings ? ` with ${warnings} warning(s)` : ""}.`);
process.exit(failures ? 1 : 0);

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { readEnv } from "../../src/lib/env";
import { backupData, pendingMigrations } from "../../src/lib/db/backup";
import { databasePath, openDatabase } from "../../src/lib/db/connection";
import { MIGRATIONS_DIR, runMigrations } from "../../src/lib/db/migrate";
import { MeteredProvider, usageSince } from "../../src/lib/llm/metered";
import { ProviderError, type AssessmentInput, type LearningProvider } from "../../src/lib/llm/types";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe(".env precedence for provider settings", () => {
  const shell = env({ LLM_MODE: "mock", OPENAI_API_KEY: "shell-key", OPENAI_MODEL: "shell-model", PROXIMAL_TIMEZONE: "UTC" });

  it("uses .env provider values over the shell and reports where the key came from", () => {
    const e = readEnv(shell, { LLM_MODE: "openai", OPENAI_API_KEY: "file-key", OPENAI_MODEL: "file-model", PROXIMAL_TIMEZONE: "Europe/Paris" });
    expect(e.LLM_MODE).toBe("openai");
    expect(e.OPENAI_API_KEY).toBe("file-key");
    expect(e.jobs!.assess.model).toBe("file-model");
    expect(e.keyInfo).toEqual({ source: ".env", shellKeyIgnored: true });
    // Non-provider settings keep normal precedence (the environment wins).
    expect(e.PROXIMAL_TIMEZONE).toBe("UTC");
  });

  it("falls back to the shell key when .env leaves it empty", () => {
    const e = readEnv(shell, { LLM_MODE: "openai", OPENAI_API_KEY: "", OPENAI_MODEL: "file-model" });
    expect(e.keyInfo).toEqual({ source: "environment", shellKeyIgnored: false });
    expect(e.OPENAI_API_KEY).toBe("shell-key");
  });

  it("parses and validates usage limits", () => {
    const e = readEnv(env({ PROXIMAL_DAILY_TOKEN_LIMIT: "200000", PROXIMAL_MAX_CONCURRENT_CALLS: "3" }));
    expect(e.limits).toEqual({ dailyCalls: null, dailyTokens: 200000, maxConcurrent: 3 });
    expect(readEnv(env({})).limits.maxConcurrent).toBe(2);
    expect(() => readEnv(env({ PROXIMAL_DAILY_CALL_LIMIT: "-1" }))).toThrow(/PROXIMAL_DAILY_CALL_LIMIT must be a positive whole number/);
  });
});

// ---------------------------------------------------------------- metering

const input: AssessmentInput = {
  questionId: "q",
  taskType: "explain",
  prompt: "p",
  rubric: { version: 1, criteria: [] },
  reference: { summary: "r", numericChecks: [] },
  sourceText: "",
  answer: "SECRET-LEARNER-ANSWER",
};

function fakeLive(behaviour: () => Promise<void> = async () => undefined): LearningProvider & { calls: number } {
  const p = {
    mode: "live" as const,
    vendor: "openai" as const,
    model: "grader",
    models: { assess: "grader", curriculum: "planner", tutor: "explainer" },
    calls: 0,
    async assessAnswer() {
      p.calls += 1;
      await behaviour();
      return {
        output: { criteria: [], possibleMisconception: null },
        meta: { mode: "live" as const, vendor: "openai" as const, model: "grader", promptVersion: "assessor-v1", usage: { inputTokens: 700, outputTokens: 300 } },
      };
    },
    async generateCurriculum(): Promise<never> {
      throw new ProviderError("timed out", "provider_timeout", true);
    },
    async tutor() {
      return { explanation: "e", meta: { mode: "live" as const, vendor: "openai" as const, model: "explainer", promptVersion: "tutor-v1", usage: null } };
    },
  };
  return p;
}

function memDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

describe("metered provider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("records every call with job, model, status, tokens and latency, and logs no answer text", async () => {
    const db = memDb();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void logs.push(l));
    vi.spyOn(console, "warn").mockImplementation((l: string) => void logs.push(l));
    const m = new MeteredProvider(fakeLive(), { db, limits: { dailyCalls: null, dailyTokens: null, maxConcurrent: 2 } });
    await m.assessAnswer(input);
    await m.tutor({ objective: "o", sourcePages: [], gap: null, request: "explanation" });
    await expect(m.generateCurriculum({ sha256: "s", fileName: "f", pages: [] })).rejects.toMatchObject({ code: "provider_timeout" });

    const rows = db.prepare("SELECT job, model, status, error_code, input_tokens, output_tokens FROM provider_calls ORDER BY rowid").all();
    expect(rows).toEqual([
      { job: "assess", model: "grader", status: "ok", error_code: null, input_tokens: 700, output_tokens: 300 },
      { job: "tutor", model: "explainer", status: "ok", error_code: null, input_tokens: null, output_tokens: null },
      { job: "curriculum", model: "planner", status: "error", error_code: "provider_timeout", input_tokens: null, output_tokens: null },
    ]);
    expect(usageSince(db, Date.now())).toEqual({ calls: 3, tokens: 1000 });
    expect(logs.map((l) => JSON.parse(l).event)).toEqual(["provider_call", "provider_call", "provider_call"]);
    expect(logs.join("\n")).not.toContain("SECRET-LEARNER-ANSWER");
  });

  it("blocks before calling the provider once a daily cap is reached, and records the block", async () => {
    const db = memDb();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const inner = fakeLive();
    const tokenCapped = new MeteredProvider(inner, { db, limits: { dailyCalls: null, dailyTokens: 1000, maxConcurrent: 2 } });
    await tokenCapped.assessAnswer(input); // uses 1000 tokens
    await expect(tokenCapped.assessAnswer(input)).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(inner.calls).toBe(1);

    const callCapped = new MeteredProvider(inner, { db, limits: { dailyCalls: 1, dailyTokens: null, maxConcurrent: 2 } });
    await expect(callCapped.assessAnswer(input)).rejects.toThrow(/daily call limit reached/);
    expect(inner.calls).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM provider_calls WHERE status = 'blocked'").get()).toEqual({ n: 2 });
    // Blocked attempts do not count towards usage.
    expect(usageSince(db, Date.now()).calls).toBe(1);
  });

  it("limits how many paid calls run at once (extra calls queue)", async () => {
    const db = memDb();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    let running = 0;
    let peak = 0;
    const inner = fakeLive(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
    });
    const m = new MeteredProvider(inner, { db, limits: { dailyCalls: null, dailyTokens: null, maxConcurrent: 1 } });
    await Promise.all([m.assessAnswer(input), m.assessAnswer(input), m.assessAnswer(input)]);
    expect(peak).toBe(1);
    expect(inner.calls).toBe(3);
  });
});

// ---------------------------------------------------------------- backups

describe("backups", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("takes a consistent online copy of the database and uploads, and prunes old backups", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "proximal-backup-"));
    const db = openDatabase(databasePath(dir));
    runMigrations(db);
    db.prepare("INSERT INTO courses (id, title, is_demo, status, created_at) VALUES ('c1', 'Kept course', 0, 'approved', 1)").run();
    mkdirSync(path.join(dir, "uploads"));
    writeFileSync(path.join(dir, "uploads", "a.pdf"), "%PDF-1.7 test");

    const first = await backupData(db, dir, { label: "manual", keep: 2 });
    const copy = new Database(first.database, { readonly: true });
    expect(copy.prepare("SELECT title FROM courses WHERE id = 'c1'").get()).toEqual({ title: "Kept course" });
    copy.close();
    expect(first.uploadsCopied).toBe(1);
    expect(existsSync(path.join(first.dir, "uploads", "a.pdf"))).toBe(true);

    await backupData(db, dir, { keep: 2 });
    const third = await backupData(db, dir, { keep: 2 });
    expect(readdirSync(path.join(dir, "backups"))).toHaveLength(2);
    expect(third.pruned).toHaveLength(1);
    db.close();
  });

  it("reports pending migrations without applying them", () => {
    const db = new Database(":memory:");
    expect(pendingMigrations(db, MIGRATIONS_DIR).length).toBeGreaterThan(0);
    runMigrations(db);
    expect(pendingMigrations(db, MIGRATIONS_DIR)).toEqual([]);
  });
});

describe("test isolation from the developer's .env", () => {
  it("PROXIMAL_ENV_FILE=none ignores .env entirely, so test servers stay in mock mode", async () => {
    const { readDotEnvFile } = await import("../../src/lib/env");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "proximal-envfile-"));
    const file = path.join(tmp, ".env");
    writeFileSync(file, "LLM_MODE=openai\nOPENAI_API_KEY=k\nOPENAI_MODEL=m\n");
    const prev = process.env.PROXIMAL_ENV_FILE;
    try {
      process.env.PROXIMAL_ENV_FILE = file;
      expect(readDotEnvFile()).toMatchObject({ LLM_MODE: "openai" });
      process.env.PROXIMAL_ENV_FILE = "none";
      expect(readDotEnvFile()).toEqual({});
    } finally {
      if (prev === undefined) delete process.env.PROXIMAL_ENV_FILE;
      else process.env.PROXIMAL_ENV_FILE = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

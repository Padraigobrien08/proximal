// Shared helpers for local developer scripts (not browser endpoints).
import { existsSync } from "node:fs";
import path from "node:path";

export function loadDotEnv() {
  const file = path.resolve(process.cwd(), ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

export function dataDir(): string {
  return path.resolve(process.cwd(), process.env.PROXIMAL_DATA_DIR || "./data");
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

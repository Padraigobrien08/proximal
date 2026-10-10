// Starts a second production server for the fault-injection browser test once the main e2e server
// (which runs `next build`) is up. Uses its own data directory. Test infrastructure only.
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const main = "http://127.0.0.1:3100/api/courses";
for (let i = 0; i < 480; i++) {
  try {
    const r = await fetch(main);
    if (r.ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}
const env = { ...process.env, PROXIMAL_DATA_DIR: ".e2e-data-fault", LLM_MODE: "mock", PROXIMAL_FAULT_MOCK_ASSESS_FAILURES: "1" };
rmSync(".e2e-data-fault", { recursive: true, force: true });
const seed = spawnSync("npx", ["tsx", "--conditions=react-server", "scripts/seed.ts"], { env, stdio: "inherit" });
if (seed.status !== 0) process.exit(seed.status ?? 1);
const server = spawn("npx", ["next", "start", "--hostname", "127.0.0.1", "--port", "3101"], { env, stdio: "inherit" });
const stop = () => server.kill("SIGTERM");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.on("exit", (code) => process.exit(code ?? 0));

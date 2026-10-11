import { defineConfig, devices } from "@playwright/test";

// Key-free and deterministic: offline mock mode, isolated data directories, production build.
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "rm -rf .e2e-data && npm run db:seed && npm run build && npx next start --hostname 127.0.0.1 --port 3100",
      url: "http://127.0.0.1:3100/api/courses",
      timeout: 240_000,
      reuseExistingServer: false,
      // PROXIMAL_ENV_FILE=none: never read the developer's .env (it may select a live provider).
      env: { PROXIMAL_DATA_DIR: ".e2e-data", PROXIMAL_ENV_FILE: "none", LLM_MODE: "mock", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" },
    },
    {
      // Same build, separate data, first mock assessment fails: exercises pending/retry without credentials.
      command: "node scripts/e2e-fault-server.mjs",
      url: "http://127.0.0.1:3101/api/courses",
      timeout: 300_000,
      reuseExistingServer: false,
      env: { PROXIMAL_ENV_FILE: "none", LLM_MODE: "mock", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" },
    },
  ],
});

import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

// Key-free and deterministic: offline mock mode, an isolated data directory, production build.
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `rm -rf .e2e-data && npm run db:seed && npm run build && npx next start --hostname 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/home`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: { PROXIMAL_DATA_DIR: ".e2e-data", LLM_MODE: "mock", ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: "" },
  },
});

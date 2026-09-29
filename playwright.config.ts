import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

// The end-to-end suite (PROJECT.md 22 AT 30; Phase 13). It runs against a production build on its own port, with a
// mocked OpenRouter endpoint (global setup) and Redis emptied so the budget and the limiter fail open. The cached
// Chromium from the local Playwright installation is used because install scripts are blocked on this machine.
const PORT = Number(process.env.E2E_PORT ?? 3109);
const BASE = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const CHROME = process.env.PW_CHROME ?? `${process.env.LOCALAPPDATA}\\ms-playwright\\chromium-1194\\chrome-win\\chrome.exe`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  outputDir: ".playwright-mcp/e2e-results",
  use: {
    baseURL: BASE,
    viewport: { width: 1440, height: 900 },
    launchOptions: existsSync(CHROME) ? { executablePath: CHROME } : undefined,
    trace: "retain-on-failure",
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next start -p ${PORT}`,
        url: `${BASE}/api/health`,
        reuseExistingServer: true,
        timeout: 60_000,
        env: {
          // The ladder talks to the mock; Redis is emptied so the budget fails open and the limiter skips.
          OPENROUTER_API_URL: "http://127.0.0.1:4319/api/v1",
          UPSTASH_REDIS_REST_URL: "",
          UPSTASH_REDIS_REST_TOKEN: "",
        },
      },
});

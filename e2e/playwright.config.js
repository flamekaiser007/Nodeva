// Real-browser E2E config. Deliberately NOT using Playwright's own
// `webServer` option to boot the frontend/backend/worker -- this suite
// needs a real Postgres, a real migrated schema, and a real Python worker
// process alongside the Vite dev server, which is exactly the multi-process
// orchestration scripts/e2e_demo.sh already does for the curl-level e2e
// check. run_e2e.sh (this directory) does the equivalent setup for the
// browser-level check, then runs `playwright test` against the result.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false, // tests share one backend/DB; running serially avoids one test's data confusing another's assertions
  retries: 0,
  // 'list' for a readable local/CI log; 'html' (never auto-opened) so a
  // failed CI run has something worth uploading as an artifact instead of
  // just a stack trace.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});

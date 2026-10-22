import { defineConfig, devices } from '@playwright/test';

const CI = Boolean(process.env.CI);
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

/**
 * The journeys run against a running stack: `make e2e` brings it up and resets it (see README.md). On the dev
 * stack (the default base URL) Playwright starts the Vite dev server unless one already runs; the prod-like stack
 * (`E2E_STACK=prodlike`, CI) serves the built SPA behind Caddy, so nothing is started.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: CI,
  // Once in CI, never locally: a test that needs its retry is flaky, and the policy in README.md applies.
  retries: CI ? 1 : 0,
  workers: CI ? 2 : 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Quarantined tests (README "Flaky tests") stay out of the required run.
  grepInvert: /@quarantine/,
  reporter: CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    // Every failed attempt keeps its trace, the first one too when its retry fails differently (review round 1, F3).
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['setup'] },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, dependencies: ['setup'] },
  ],
  webServer: baseURL.endsWith(':5173')
    ? {
        command: 'npm run dev -- --strictPort',
        cwd: '../frontend',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 60_000,
      }
    : undefined,
});

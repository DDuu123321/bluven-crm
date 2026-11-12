import { defineConfig } from '@playwright/test';
import { E2E, zohoEnv } from './env';

export default defineConfig({
  testDir: './tests',
  // The journey is one story told in order, against one database.
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: E2E.baseURL,
    viewport: { width: 1440, height: 900 },
    // The screenshots are kept for people to look at, so render them sharp.
    deviceScaleFactor: 2,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      // Zoho's sign-in and mail services, played by a small local server.
      command: 'pnpm exec tsx scripts/fake-zoho.ts',
      url: `${E2E.zohoUrl}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The same standalone production server the container image runs.
      command: 'pnpm --filter @bluven/web build && pnpm --filter @bluven/web start',
      url: `${E2E.baseURL}/api/intake/health`,
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PORT: String(E2E.port),
        HOSTNAME: '127.0.0.1',
        DATABASE_URL: E2E.databaseUrl,
        APP_URL: E2E.baseURL,
        APP_TIMEZONE: 'Australia/Sydney',
        STORAGE_DIR: E2E.storageDir,
        PYLON_WEBHOOK_SECRET: E2E.pylonWebhookSecret,
        PYLON_API_TOKEN: '',
        SMTP_URL: '',
        NEXT_TELEMETRY_DISABLED: '1',
        ...zohoEnv,
      },
    },
  ],
});

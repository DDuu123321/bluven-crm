import { defineConfig } from '@playwright/test';
import { E2E } from './env';

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
  webServer: {
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
    },
  },
});

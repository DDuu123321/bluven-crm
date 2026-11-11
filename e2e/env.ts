import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Two checkouts can run the suite side by side by giving one of them another port and database.
const port = Number(process.env.E2E_PORT ?? 3100);

/** The end-to-end tests run against their own database, storage directory and port. */
export const E2E = {
  port,
  baseURL: `http://127.0.0.1:${port}`,
  databaseUrl: process.env.DATABASE_URL_E2E ?? 'postgresql://bluven:bluven@127.0.0.1:5432/bluven_e2e',
  storageDir: path.join(here, '.tmp/storage'),
  stateFile: path.join(here, '.tmp/state.json'),
  screenshotDir: path.join(here, 'screenshots'),
  password: 'Test-password-1',
  pylonWebhookSecret: 'whsec_e2e_0123456789',
};

export interface E2EState {
  intakeToken: string;
  users: Record<'admin' | 'manager' | 'sam' | 'alex' | 'fin' | 'ops', { email: string; name: string }>;
}

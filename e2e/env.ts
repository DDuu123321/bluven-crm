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
  /** A stand-in for Zoho (sign-in and mail), started next to the application. */
  zohoPort: port + 50,
  zohoUrl: `http://127.0.0.1:${port + 50}`,
  zohoClientId: 'e2e-client-id',
  zohoClientSecret: 'e2e-client-secret',
  mailbox: 'sam.mailbox@bluven.example',
  /** A stand-in for the language model's service. */
  modelPort: port + 60,
  modelUrl: `http://127.0.0.1:${port + 60}`,
};

/** What the application, and the script that reads mailboxes, need to know about the stand-in. */
export const zohoEnv = {
  ZOHO_CLIENT_ID: E2E.zohoClientId,
  ZOHO_CLIENT_SECRET: E2E.zohoClientSecret,
  ZOHO_ACCOUNTS_URL: E2E.zohoUrl,
  ZOHO_MAIL_URL: E2E.zohoUrl,
};

/** What the application, and the script that does the assistant's background work, need to reach the stand-in model. */
export const modelEnv = {
  ANTHROPIC_API_KEY: 'e2e-model-key',
  ANTHROPIC_BASE_URL: E2E.modelUrl,
  AI_MODEL: 'claude-opus-5-5',
};

export interface E2EState {
  intakeToken: string;
  users: Record<'admin' | 'manager' | 'sam' | 'alex' | 'fin' | 'ops', { email: string; name: string }>;
}

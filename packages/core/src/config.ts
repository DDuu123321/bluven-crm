import path from 'node:path';
import { loadRootEnv, repoRoot } from '@bluven/db';
import { DEFAULT_TIMEZONE } from './domain';

export interface AppConfig {
  /** Public base URL, no trailing slash. */
  appUrl: string;
  /** Business time zone for display and date-only values. */
  timeZone: string;
  /** Absolute directory for uploaded files. */
  storageDir: string;
  /** Upper bound for a single upload, in bytes. */
  maxUploadBytes: number;
  smtpUrl: string;
  mailFrom: string;
  /**
   * Sending email through an HTTPS relay instead of SMTP, for hosts that block outgoing SMTP.
   * The Bluven website already runs such a relay (POST /api/send-mail, header x-relay-key).
   */
  mailRelay: { url: string; key: string };
  pylon: { apiToken: string; webhookSecret: string; apiBase: string };
  /**
   * Pulling leads from the Bluven website's CMS (GET /api/crm/leads there). Off unless both the
   * address and the shared key are set.
   */
  bluvenLeads: { url: string; key: string; since: string };
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;
  loadRootEnv();
  const env = process.env;
  const storage = env.STORAGE_DIR?.trim() || './data/storage';
  const maxMb = Number(env.MAX_UPLOAD_MB ?? '500');
  cached = {
    appUrl: (env.APP_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, ''),
    timeZone: env.APP_TIMEZONE?.trim() || DEFAULT_TIMEZONE,
    storageDir: path.isAbsolute(storage) ? storage : path.resolve(repoRoot(), storage),
    maxUploadBytes: (Number.isFinite(maxMb) && maxMb > 0 ? maxMb : 500) * 1024 * 1024,
    smtpUrl: env.SMTP_URL?.trim() ?? '',
    mailFrom: env.MAIL_FROM?.trim() || 'Bluven CRM <crm@localhost>',
    mailRelay: { url: env.MAIL_RELAY_URL?.trim() ?? '', key: env.MAIL_RELAY_KEY?.trim() ?? '' },
    pylon: {
      apiToken: env.PYLON_API_TOKEN?.trim() ?? '',
      webhookSecret: env.PYLON_WEBHOOK_SECRET?.trim() ?? '',
      apiBase: (env.PYLON_API_BASE?.trim() || 'https://api.getpylon.com').replace(/\/+$/, ''),
    },
    bluvenLeads: {
      url: env.BLUVEN_LEADS_URL?.trim() ?? '',
      key: env.BLUVEN_LEADS_KEY?.trim() ?? '',
      since: env.BLUVEN_LEADS_SINCE?.trim() ?? '',
    },
  };
  return cached;
}

/** For tests. */
export function resetConfigCache(): void {
  cached = undefined;
}

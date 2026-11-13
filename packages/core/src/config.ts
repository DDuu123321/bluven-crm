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
  /**
   * Zoho Mail. Each salesperson connects their own mailbox by OAuth; the client id and secret
   * come from one application registered in Zoho's API console. Off unless both are set.
   * The company's account lives in Zoho's Australian data centre, hence the default addresses.
   * Zoho blocks an application that sends more than 30 API requests a minute, for a time it
   * does not disclose; `requestsPerMinute` is how many the background reading allows itself.
   */
  zoho: { clientId: string; clientSecret: string; accountsUrl: string; mailUrl: string; requestsPerMinute: number };
  /**
   * The assistant: summaries, reply drafts, reading attachments and bills, the brief for
   * operations. Off unless a key for Anthropic's API is set. `baseUrl` is only for tests and
   * for a gateway in front of the API.
   */
  ai: { apiKey: string; model: string; baseUrl: string };
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;
  loadRootEnv();
  const env = process.env;
  const storage = env.STORAGE_DIR?.trim() || './data/storage';
  const maxMb = Number(env.MAX_UPLOAD_MB ?? '500');
  const zohoRate = Number(env.ZOHO_REQUESTS_PER_MINUTE ?? '24');
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
    zoho: {
      clientId: env.ZOHO_CLIENT_ID?.trim() ?? '',
      clientSecret: env.ZOHO_CLIENT_SECRET?.trim() ?? '',
      accountsUrl: (env.ZOHO_ACCOUNTS_URL?.trim() || 'https://accounts.zoho.com.au').replace(/\/+$/, ''),
      mailUrl: (env.ZOHO_MAIL_URL?.trim() || 'https://mail.zoho.com.au').replace(/\/+$/, ''),
      requestsPerMinute: Number.isFinite(zohoRate) && zohoRate >= 1 ? Math.min(120, Math.floor(zohoRate)) : 24,
    },
    ai: {
      apiKey: env.ANTHROPIC_API_KEY?.trim() ?? '',
      model: env.AI_MODEL?.trim() || 'claude-opus-5-5',
      baseUrl: (env.ANTHROPIC_BASE_URL?.trim() ?? '').replace(/\/+$/, ''),
    },
  };
  return cached;
}

/** For tests. */
export function resetConfigCache(): void {
  cached = undefined;
}

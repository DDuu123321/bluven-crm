// Zoho Mail: OAuth 2.0 and the REST API, as far as the CRM needs them.
// Written from Zoho's developer documentation (accounts: /oauth/v2, mail: /api/accounts/...).
// It has not been exercised against a live Zoho account yet, so every field is read defensively.
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { decodeEntities, parseAddressList, parseMessageIds, type Mailbox } from '@bluven/core';

export interface ZohoSettings {
  clientId: string;
  clientSecret: string;
  /** For example https://accounts.zoho.com.au (the data centre the company's account lives in). */
  accountsUrl: string;
  /** For example https://mail.zoho.com.au */
  mailUrl: string;
  /** Where Zoho sends the browser back to: <APP_URL>/api/zoho/callback. */
  redirectUri: string;
}

/** Read accounts and folders, read messages and their attachments, send messages. Nothing else. */
export const ZOHO_SCOPES = ['ZohoMail.accounts.READ', 'ZohoMail.folders.READ', 'ZohoMail.messages.READ', 'ZohoMail.messages.CREATE'] as const;

export class MailApiError extends Error {
  /** The provider says we are asking too often. Everything waits a while; no mailbox is at fault. */
  readonly throttled: boolean;
  /** The provider does not accept this server's own settings (client id, secret, address). Nothing a mailbox owner can fix. */
  readonly setupFailed: boolean;

  constructor(
    message: string,
    readonly status: number | null,
    /** Worth trying again later: network trouble, rate limiting, server errors. */
    readonly retryable: boolean,
    /** The provider no longer accepts the permission this mailbox's owner gave. */
    readonly authFailed = false,
    kind: { throttled?: boolean; setupFailed?: boolean } = {},
  ) {
    super(message);
    this.name = 'MailApiError';
    this.throttled = !!kind.throttled;
    this.setupFailed = !!kind.setupFailed;
  }
}

/** How Zoho words a refusal for asking too often. Its reference documents no status or code for it. */
const THROTTLE_WORDS = /too many requests|rate.?limit|throttl|exceeded.{0,40}(limit|quota)|temporarily (blocked|locked)/i;

/**
 * Spaces requests evenly: at most `perMinute` a minute and never in a burst. Zoho blocks an
 * application that passes 30 requests a minute for a time it does not disclose, and does not say
 * whether that is counted per mailbox or for everyone, so one pacer serves every mailbox read
 * in this process.
 */
export function createPacer(perMinute: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), now: () => number = Date.now): () => Promise<void> {
  const gap = 60_000 / Math.max(1, perMinute);
  let next = 0;
  return async () => {
    const t = now();
    const at = Math.max(t, next);
    next = at + gap;
    if (at > t) await sleep(at - t);
  };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/** The page a salesperson is sent to in order to let the CRM use their mailbox. */
export function zohoAuthorizeUrl(settings: ZohoSettings, state: string): string {
  const params = new URLSearchParams({
    client_id: settings.clientId,
    response_type: 'code',
    redirect_uri: settings.redirectUri,
    scope: ZOHO_SCOPES.join(','),
    // "offline" is what makes Zoho hand out a refresh token; "consent" makes it do so every
    // time, also when the same person connects a second time.
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${settings.accountsUrl}/oauth/v2/auth?${params.toString()}`;
}

export interface ZohoTokens {
  accessToken: string;
  /** Present on the first exchange only. */
  refreshToken: string | null;
  expiresInSeconds: number;
}

async function tokenRequest(settings: ZohoSettings, params: Record<string, string>, fetchImpl: typeof fetch): Promise<ZohoTokens> {
  let res: Response;
  try {
    res = await fetchImpl(`${settings.accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret, ...params }).toString(),
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
  } catch (e) {
    throw new MailApiError(`Could not reach Zoho: ${e instanceof Error ? e.message : 'network error'}`, null, true);
  }
  let body: Json = {};
  try {
    body = obj(await res.json());
  } catch {
    /* handled below */
  }
  // Zoho answers 200 with an "error" field when it refuses.
  const error = text(body.error);
  const accessToken = text(body.access_token);
  if (!res.ok || error || !accessToken) {
    const said = `Zoho refused the request${error ? ` (${error})` : ` (status ${res.status})`}.`;
    // Ten tokens in ten minutes is the limit; the refusal reads "Access Denied" with a sentence about too many requests.
    if (res.status === 429 || THROTTLE_WORDS.test(JSON.stringify(body))) throw new MailApiError(said, res.status, true, false, { throttled: true });
    // Only this one says the person's permission is gone: the code or the refresh token is not, or no longer, valid.
    if (error === 'invalid_code' || error === 'invalid_grant') throw new MailApiError(said, res.status, false, true);
    // These are about the server's own settings: the client id, the secret, or the accounts address for the data centre.
    if (error === 'invalid_client' || error === 'invalid_client_secret' || error === 'invalid_redirect_uri' || error === 'unauthorized_client') {
      throw new MailApiError(`${said} Check ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_ACCOUNTS_URL on the server.`, res.status, false, false, { setupFailed: true });
    }
    throw new MailApiError(said, res.status, res.status >= 500);
  }
  // In seconds, and an hour at most: some of Zoho's products report milliseconds under the same name.
  const expires = Number(body.expires_in_sec ?? body.expires_in);
  return { accessToken, refreshToken: text(body.refresh_token), expiresInSeconds: Number.isFinite(expires) && expires > 0 ? Math.min(3600, Math.max(60, expires)) : 3600 };
}

/** Turns the code Zoho passes back after consent into tokens. The code is valid for two minutes. */
export function exchangeZohoCode(settings: ZohoSettings, code: string, fetchImpl: typeof fetch = fetch): Promise<ZohoTokens> {
  return tokenRequest(settings, { grant_type: 'authorization_code', code, redirect_uri: settings.redirectUri }, fetchImpl);
}

export function refreshZohoToken(settings: ZohoSettings, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<ZohoTokens> {
  return tokenRequest(settings, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl);
}

/**
 * Tells Zoho to forget the grant, and says whether Zoho confirmed it. A failure must not stop a
 * disconnect, so nothing is thrown. Zoho documents two forms of this call; the newer one is
 * tried first and the older one after it.
 */
export async function revokeZohoToken(settings: ZohoSettings, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const attempts: (() => Promise<Response>)[] = [
    () =>
      fetchImpl(`${settings.accountsUrl}/oauth/v2/revoke/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ token: refreshToken, token_type: 'refresh_token' }).toString(),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      }),
    () => fetchImpl(`${settings.accountsUrl}/oauth/v2/token/revoke?token=${encodeURIComponent(refreshToken)}`, { method: 'POST', signal: AbortSignal.timeout(15_000), redirect: 'error' }),
  ];
  for (const attempt of attempts) {
    try {
      const res = await attempt();
      if (!res.ok) continue;
      // A refusal can come with status 200 and an "error" field, like everything else on this server.
      const body = obj(await res.json().catch(() => ({})));
      if (!text(body.error)) return true;
    } catch {
      /* the next form, or give up */
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The mailbox, as the CRM's mail logic sees it. Tests supply a stand-in.
// ---------------------------------------------------------------------------

export interface MailAccountInfo {
  accountId: string;
  primaryAddress: string;
  /** Primary address and aliases, lower-cased. */
  addresses: string[];
  displayName: string;
}

export interface MailFolder {
  id: string;
  name: string;
  /** Zoho's folder type: "Inbox" (also for folders the user made), "Sent", "Drafts", "Spam", "Trash"... */
  type: string;
  path: string;
}

export interface MailListItem {
  messageId: string;
  folderId: string;
  threadId: string | null;
  subject: string;
  from: Mailbox | null;
  to: Mailbox[];
  cc: Mailbox[];
  /** When the mailbox received it (or, in the sent folder, when it was sent). */
  time: Date;
  hasAttachment: boolean;
  summary: string;
}

/** One page of a folder's list. */
export interface MailPage {
  items: MailListItem[];
  /** How many entries the provider sent, readable or not. Fewer than were asked for means the folder ends here. */
  received: number;
}

export interface MailAttachmentInfo {
  attachmentId: string;
  name: string;
  size: number;
}

export interface UploadedAttachment {
  storeName: string;
  attachmentPath: string;
  attachmentName: string;
}

export interface OutgoingMail {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  html: string;
  attachments: UploadedAttachment[];
  /** The provider's id of the message this one answers, in the same mailbox. */
  replyToMessageId?: string | null;
}

export interface MailApi {
  listAccounts(): Promise<MailAccountInfo[]>;
  listFolders(accountId: string): Promise<MailFolder[]>;
  /** Newest first. `start` counts from 1. */
  listMessages(accountId: string, folderId: string, opts: { start: number; limit: number }): Promise<MailPage>;
  getContent(accountId: string, folderId: string, messageId: string): Promise<string>;
  /** Header names in lower case. */
  getHeaders(accountId: string, folderId: string, messageId: string): Promise<Record<string, string[]>>;
  listAttachments(accountId: string, folderId: string, messageId: string): Promise<MailAttachmentInfo[]>;
  downloadAttachment(accountId: string, folderId: string, messageId: string, attachmentId: string): Promise<Readable>;
  uploadAttachment(accountId: string, fileName: string, body: Readable): Promise<UploadedAttachment>;
  /** Returns the provider's id of the sent message, and its Message-ID header, when it tells us. */
  send(accountId: string, mail: OutgoingMail): Promise<{ messageId: string | null; messageIdHeader?: string | null }>;
}

export function parseAccount(data: unknown): MailAccountInfo | null {
  const a = obj(data);
  const accountId = text(a.accountId);
  const listed = arr(a.emailAddress)
    .map((e) => text(obj(e).mailId)?.toLowerCase())
    .filter((v): v is string => !!v);
  const primary = (text(a.primaryEmailAddress) ?? text(a.incomingUserName) ?? listed[0] ?? '').toLowerCase();
  if (!accountId || !primary.includes('@')) return null;
  // Only a mailbox that Zoho itself hosts: an external IMAP account added inside Zoho is not ours to read.
  const type = text(a.type);
  if (type && type !== 'ZOHO_ACCOUNT') return null;
  return { accountId, primaryAddress: primary, addresses: [...new Set([primary, ...listed])], displayName: text(a.displayName) ?? '' };
}

/**
 * When a message arrived, in milliseconds. `receivedTime` is the real moment. Zoho's ids begin
 * with the same thirteen digits, which serves when the field is missing. `sentDateInGMT` is the
 * last resort only: in Zoho's own samples it is off by the mailbox's distance from UTC.
 */
function arrivalTime(m: Json, messageId: string | null): number {
  const received = Number(text(m.receivedTime));
  if (Number.isFinite(received) && received > 0) return received;
  const fromId = Number((messageId ?? '').slice(0, 13));
  if (/^\d{16,}$/.test(messageId ?? '') && fromId > Date.UTC(2015, 0, 1) && fromId < Date.now() + 86_400_000) return fromId;
  return Number(text(m.sentDateInGMT));
}

export function parseListItem(data: unknown): MailListItem | null {
  const m = obj(data);
  const messageId = text(m.messageId);
  const folderId = text(m.folderId);
  const ms = arrivalTime(m, messageId);
  if (!messageId || !folderId || !Number.isFinite(ms) || ms <= 0) return null;
  const from = parseAddressList(text(m.fromAddress))[0] ?? null;
  // Zoho writes text fields of the list HTML-encoded ("&lt;", "&amp;"), as it does the addresses.
  const sender = decodeEntities(text(m.sender) ?? '').trim();
  return {
    messageId,
    folderId,
    threadId: text(m.threadId),
    subject: decodeEntities(text(m.subject) ?? ''),
    from: from ? { address: from.address, name: from.name || (sender && !sender.includes('@') ? sender : '') } : null,
    to: parseAddressList(text(m.toAddress)),
    cc: parseAddressList(text(m.ccAddress)),
    time: new Date(ms),
    hasAttachment: m.hasAttachment === '1' || m.hasAttachment === 1 || m.hasAttachment === true || m.hasAttachment === 'true',
    summary: decodeEntities(text(m.summary) ?? ''),
  };
}

export interface ZohoMailClientOptions {
  mailUrl: string;
  /** Supplies a valid access token; called again with `true` after the API refused the last one. */
  accessToken: (forceRefresh?: boolean) => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Waited on before every request. The background reading passes a pacer; a person sending a message does not wait. */
  pace?: () => Promise<void>;
}

export class ZohoMailClient implements MailApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ZohoMailClientOptions) {
    this.base = `${opts.mailUrl.replace(/\/+$/, '')}/api`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async request(path: string, init: { method?: string; body?: string | ArrayBuffer; headers?: Record<string, string>; accept?: string } = {}): Promise<Response> {
    const call = async (force: boolean): Promise<Response> => {
      const token = await this.opts.accessToken(force);
      await this.opts.pace?.();
      try {
        return await this.fetchImpl(`${this.base}${path}`, {
          method: init.method ?? 'GET',
          headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: init.accept ?? 'application/json', ...init.headers },
          body: init.body,
          signal: AbortSignal.timeout(this.timeoutMs),
          // The token must never follow a redirect to another host.
          redirect: 'error',
        });
      } catch (e) {
        throw new MailApiError(`Could not reach Zoho Mail: ${e instanceof Error ? e.message : 'network error'}`, null, true);
      }
    };
    /** What a refusal says, read from its body once. */
    const refusal = async (res: Response): Promise<{ detail: string; all: string }> => {
      try {
        const body = obj(await res.json());
        const parts = [text(obj(body.data).errorCode), text(obj(body.data).moreInfo), text(obj(body.status).description)].filter((v): v is string => !!v);
        return { detail: parts[0] ?? '', all: parts.join(' ') };
      } catch {
        return { detail: '', all: '' };
      }
    };
    let res = await call(false);
    let said = res.ok ? null : await refusal(res);
    // An access token lives for an hour; one that has just run out is replaced once. Zoho does
    // not always answer 401 for it, so the code in the body counts as well.
    if (said && (res.status === 401 || /INVALID_OAUTHTOKEN|INVALID_TICKET/i.test(said.all))) {
      res = await call(true);
      said = res.ok ? null : await refusal(res);
    }
    if (said) {
      const where = `Zoho Mail answered ${res.status}${said.detail ? ` (${said.detail})` : ''} for ${path.split('?')[0]}`;
      if (res.status === 429 || THROTTLE_WORDS.test(said.all)) throw new MailApiError(where, res.status, true, false, { throttled: true });
      const authFailed = res.status === 401 || /INVALID_OAUTHTOKEN|INVALID_TICKET|OAUTH_SCOPE_MISMATCH/i.test(said.all);
      throw new MailApiError(where, res.status, !authFailed && (res.status >= 500 || res.status === 408), authFailed);
    }
    return res;
  }

  private async data(path: string, init?: Parameters<ZohoMailClient['request']>[1]): Promise<unknown> {
    const res = await this.request(path, init);
    try {
      return obj(await res.json()).data;
    } catch {
      throw new MailApiError('Zoho Mail returned a response that is not JSON.', res.status, true);
    }
  }

  async listAccounts(): Promise<MailAccountInfo[]> {
    return arr(await this.data('/accounts'))
      .map(parseAccount)
      .filter((a): a is MailAccountInfo => a !== null);
  }

  async listFolders(accountId: string): Promise<MailFolder[]> {
    const out: MailFolder[] = [];
    for (const item of arr(await this.data(`/accounts/${encodeURIComponent(accountId)}/folders`))) {
      const f = obj(item);
      const id = text(f.folderId);
      if (id) out.push({ id, name: text(f.folderName) ?? '', type: text(f.folderType) ?? '', path: text(f.path) ?? '' });
    }
    return out;
  }

  async listMessages(accountId: string, folderId: string, opts: { start: number; limit: number }): Promise<MailPage> {
    // Archived mail stays in its folder but is left out of the list unless asked for.
    const params = new URLSearchParams({ folderId, start: String(opts.start), limit: String(Math.min(200, Math.max(1, opts.limit))), sortBy: 'date', sortorder: 'false', includeto: 'true', includearchive: 'true' });
    const entries = arr(await this.data(`/accounts/${encodeURIComponent(accountId)}/messages/view?${params.toString()}`));
    return { items: entries.map(parseListItem).filter((m): m is MailListItem => m !== null), received: entries.length };
  }

  private messagePath(accountId: string, folderId: string, messageId: string): string {
    return `/accounts/${encodeURIComponent(accountId)}/folders/${encodeURIComponent(folderId)}/messages/${encodeURIComponent(messageId)}`;
  }

  async getContent(accountId: string, folderId: string, messageId: string): Promise<string> {
    return text(obj(await this.data(`${this.messagePath(accountId, folderId, messageId)}/content`)).content) ?? '';
  }

  async getHeaders(accountId: string, folderId: string, messageId: string): Promise<Record<string, string[]>> {
    const content = obj(await this.data(`${this.messagePath(accountId, folderId, messageId)}/header?raw=false`)).headerContent;
    const out: Record<string, string[]> = {};
    if (typeof content === 'string') {
      // The raw form, should Zoho send it anyway: unfold continuation lines, then split.
      for (const line of content.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
        const at = line.indexOf(':');
        if (at > 0) (out[line.slice(0, at).trim().toLowerCase()] ??= []).push(line.slice(at + 1).trim());
      }
      return out;
    }
    for (const [name, values] of Object.entries(obj(content))) {
      const list = (Array.isArray(values) ? values : [values]).map((v) => text(v)).filter((v): v is string => v !== null);
      if (list.length) out[name.toLowerCase()] = list;
    }
    return out;
  }

  async listAttachments(accountId: string, folderId: string, messageId: string): Promise<MailAttachmentInfo[]> {
    const out: MailAttachmentInfo[] = [];
    // Inline images (signatures, logos) are left out by default, which is what we want.
    for (const item of arr(obj(await this.data(`${this.messagePath(accountId, folderId, messageId)}/attachmentinfo`)).attachments)) {
      const a = obj(item);
      const attachmentId = text(a.attachmentId);
      const size = Number(a.attachmentSize);
      if (attachmentId) out.push({ attachmentId, name: text(a.attachmentName) ?? 'attachment', size: Number.isFinite(size) && size >= 0 ? size : 0 });
    }
    return out;
  }

  async downloadAttachment(accountId: string, folderId: string, messageId: string, attachmentId: string): Promise<Readable> {
    const res = await this.request(`${this.messagePath(accountId, folderId, messageId)}/attachments/${encodeURIComponent(attachmentId)}`, { accept: 'application/octet-stream' });
    if (!res.body) throw new MailApiError('Zoho Mail sent an empty attachment.', res.status, true);
    return Readable.fromWeb(res.body as unknown as NodeWebStream<Uint8Array>);
  }

  async uploadAttachment(accountId: string, fileName: string, body: Readable): Promise<UploadedAttachment> {
    // The file is held in memory for the upload: a stream cannot be sent again if the token has
    // to be renewed in between, and attachments are limited to what mail accepts anyway.
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
    const bytes = Buffer.concat(chunks);
    const d = obj(
      await this.data(`/accounts/${encodeURIComponent(accountId)}/messages/attachments?fileName=${encodeURIComponent(fileName)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        // A copy in a buffer of its own: Node's buffers may share a larger pool.
        body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      }),
    );
    const storeName = text(d.storeName);
    const attachmentPath = text(d.attachmentPath);
    if (!storeName || !attachmentPath) throw new MailApiError('Zoho Mail did not confirm the uploaded attachment.', 200, true);
    return { storeName, attachmentPath, attachmentName: text(d.attachmentName) ?? fileName };
  }

  async send(accountId: string, mail: OutgoingMail): Promise<{ messageId: string | null; messageIdHeader: string | null }> {
    const body: Json = {
      fromAddress: mail.from,
      toAddress: mail.to.join(','),
      subject: mail.subject,
      content: mail.html,
      mailFormat: 'html',
      askReceipt: 'no',
    };
    if (mail.cc.length) body.ccAddress = mail.cc.join(',');
    if (mail.attachments.length) body.attachments = mail.attachments;
    const path = mail.replyToMessageId ? `/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(mail.replyToMessageId)}` : `/accounts/${encodeURIComponent(accountId)}/messages`;
    if (mail.replyToMessageId) body.action = 'reply';
    const d = obj(await this.data(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    // "mailId" is the Message-ID header of what was sent, which lets the copy in the sent folder be recognised for certain.
    const mailId = text(d.mailId);
    return { messageId: text(d.messageId), messageIdHeader: parseMessageIds(mailId)[0] ?? (mailId && /^[^<>\s]+@[^<>\s]+$/.test(mailId) ? mailId : null) };
  }
}

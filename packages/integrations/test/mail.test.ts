import { Readable } from 'node:stream';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assignOrders, confirmCustomerEmail, createQuote, getConfig, ingestLeads, openSecret, parseDateOnly, pushOrder, resetConfigCache, systemCtx, updateCustomer, uploadDocument, type Ctx, type Mailbox } from '@bluven/core';
import { as, docType, lead, makeUser, pdf, png, resetDb, source, stream, testDb } from '../../core/test/helpers';
import { makeWorld, orderAt, type World } from '../../core/test/setup-order';
import {
  MailApiError,
  ZohoMailClient,
  addSenderToCustomer,
  archiveContractFromAttachment,
  assignEmailToOrder,
  classifyFolders,
  connectMailbox,
  createPacer,
  disconnectMailbox,
  exchangeZohoCode,
  fileEmailAttachment,
  getMailPause,
  getOrderMail,
  getOwnMailbox,
  listMailboxes,
  mailApiFor,
  openEmailAttachment,
  openEmailHtml,
  parseListItem,
  refreshZohoToken,
  revokeZohoToken,
  sendOrderEmail,
  setMailboxScope,
  syncAllMailboxes,
  syncMailbox,
  zohoAuthorizeUrl,
  zohoSettings,
  type MailApi,
  type MailAttachmentInfo,
  type MailFolder,
  type OutgoingMail,
} from '../src';

const db = testDb();
let w: World;
let ctx: Ctx;
let n = 0;

interface FakeMessage {
  id: string;
  folderId: string;
  threadId: string | null;
  subject: string;
  from: Mailbox;
  to: Mailbox[];
  cc: Mailbox[];
  time: Date;
  html: string;
  messageIdHeader: string;
  inReplyTo?: string;
  attachments: { id: string; name: string; body: Buffer | 'unreachable'; size?: number }[];
}

const SAM_MAIL = 'sam@bluven.example';
const who = (address: string, name = ''): Mailbox => ({ address, name });

/** A stand-in mailbox that the tests fill and inspect. */
class FakeMail implements MailApi {
  account = { accountId: 'acc_1', primaryAddress: SAM_MAIL, addresses: [SAM_MAIL, 'sam.alias@bluven.example'], displayName: 'Sam Sales' };
  folders: MailFolder[] = [
    { id: 'f_inbox', name: 'Inbox', type: 'Inbox', path: '/Inbox' },
    { id: 'f_sent', name: 'Sent', type: 'Sent', path: '/Sent' },
    { id: 'f_spam', name: 'Spam', type: 'Spam', path: '/Spam' },
    { id: 'f_filed', name: 'Customers', type: 'Inbox', path: '/Customers' },
  ];
  messages: FakeMessage[] = [];
  sent: OutgoingMail[] = [];
  uploads: { name: string; bytes: number }[] = [];
  calls: string[] = [];
  authFailed = false;
  down = false;
  throttled = false;
  reportSentId = true;
  reportSentHeader = false;
  /** Messages whose content the provider will not hand out: for good ("bad"), or for now ("flaky"). */
  broken: Record<string, 'bad' | 'flaky'> = {};

  private check(call: string) {
    this.calls.push(call);
    if (this.throttled) throw new MailApiError('Zoho Mail answered 429', 429, true, false, { throttled: true });
    if (this.authFailed) throw new MailApiError('Zoho Mail answered 401 (INVALID_OAUTHTOKEN)', 401, false, true);
    if (this.down) throw new MailApiError('Zoho Mail answered 503', 503, true);
  }
  add(over: Partial<FakeMessage> & Pick<FakeMessage, 'from' | 'to'>): FakeMessage {
    n++;
    const m: FakeMessage = { id: `m${n}`, folderId: 'f_inbox', threadId: `t${n}`, subject: 'Your solar quote', cc: [], time: new Date(w.clock.current.getTime() - 60_000), html: '<p>Hello</p>', messageIdHeader: `msg-${n}@mail.example`, attachments: [], ...over };
    this.messages.push(m);
    return m;
  }
  /** The requests of one kind made since the list was last emptied. */
  made(prefix: string): string[] {
    return this.calls.filter((c) => c.startsWith(prefix));
  }
  async listAccounts() {
    this.check('accounts');
    return [this.account];
  }
  async listFolders() {
    this.check('folders');
    return this.folders;
  }
  async listMessages(_account: string, folderId: string, opts: { start: number; limit: number }) {
    this.check(`list:${folderId}:${opts.start}`);
    const items = this.messages
      .filter((m) => m.folderId === folderId)
      .sort((a, b) => b.time.getTime() - a.time.getTime())
      .slice(opts.start - 1, opts.start - 1 + opts.limit)
      .map((m) => ({ messageId: m.id, folderId: m.folderId, threadId: m.threadId, subject: m.subject, from: m.from, to: m.to, cc: m.cc, time: m.time, hasAttachment: m.attachments.length > 0, summary: '' }));
    return { items, received: items.length };
  }
  private find(id: string) {
    return this.messages.find((m) => m.id === id)!;
  }
  async getContent(_a: string, _f: string, id: string) {
    this.check(`content:${id}`);
    if (this.broken[id] === 'bad') throw new MailApiError('Zoho Mail answered 400 (INVALID_MESSAGE)', 400, false);
    if (this.broken[id] === 'flaky') throw new MailApiError('Zoho Mail answered 502', 502, true);
    return this.find(id).html;
  }
  async getHeaders(_a: string, _f: string, id: string) {
    this.check(`headers:${id}`);
    const m = this.find(id);
    return { 'message-id': [`<${m.messageIdHeader}>`], ...(m.inReplyTo ? { 'in-reply-to': [`<${m.inReplyTo}>`], references: [`<${m.inReplyTo}>`] } : {}) };
  }
  async listAttachments(_a: string, _f: string, id: string): Promise<MailAttachmentInfo[]> {
    this.check(`attachments:${id}`);
    return this.find(id).attachments.map((a) => ({ attachmentId: a.id, name: a.name, size: a.size ?? (a.body === 'unreachable' ? 10 : a.body.length) }));
  }
  async downloadAttachment(_a: string, _f: string, id: string, attachmentId: string) {
    this.check(`download:${attachmentId}`);
    const a = this.find(id).attachments.find((x) => x.id === attachmentId)!;
    if (a.body === 'unreachable') throw new MailApiError('Zoho Mail answered 500', 500, true);
    return Readable.from([a.body]);
  }
  async uploadAttachment(_a: string, fileName: string, body: Readable) {
    this.check(`upload:${fileName}`);
    let bytes = 0;
    for await (const chunk of body) bytes += (chunk as Buffer).length;
    this.uploads.push({ name: fileName, bytes });
    return { storeName: `store-${this.uploads.length}`, attachmentPath: `/compose/${fileName}`, attachmentName: fileName };
  }
  async send(_a: string, mail: OutgoingMail) {
    this.check('send');
    this.sent.push(mail);
    return { messageId: this.reportSentId ? `sent${this.sent.length}` : null, messageIdHeader: this.reportSentHeader ? `crm-${this.sent.length}@mail.example` : null };
  }
}

let mail: FakeMail;
const JANE = who('jane@example.com', 'Jane Smith');
const sam = () => as(w.sam, w.clock);

/** Connects Sam's mailbox the way the OAuth callback does, with Zoho's token endpoint faked. */
async function connect(user = w.sam, fake = mail) {
  const fetchImpl = (async () => Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' })) as unknown as typeof fetch;
  await connectMailbox(as(user, w.clock), { code: 'code-1' }, { fetchImpl, apiWithToken: () => fake });
  return db.emailAccount.findUniqueOrThrow({ where: { userId: user.id } });
}
const run = async (fake = mail) => syncMailbox(ctx, (await db.emailAccount.findFirstOrThrow({ where: { address: fake.account.primaryAddress } })).id, fake);

beforeAll(() => {
  process.env.ZOHO_CLIENT_ID = '1000.CLIENT';
  process.env.ZOHO_CLIENT_SECRET = 'client-secret-for-tests';
  process.env.APP_URL = 'https://crm.bluven.example';
  resetConfigCache();
});

beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
  ctx = systemCtx(db, 'Mail', w.clock.now);
  mail = new FakeMail();
  n = 0;
});

describe('Zoho client', () => {
  it('builds the consent address and exchanges the code, including the refusals Zoho sends with status 200', async () => {
    const settings = zohoSettings()!;
    expect(settings).toMatchObject({ accountsUrl: 'https://accounts.zoho.com.au', mailUrl: 'https://mail.zoho.com.au', redirectUri: 'https://crm.bluven.example/api/zoho/callback' });
    const url = new URL(zohoAuthorizeUrl(settings, 'state-123'));
    expect(url.origin + url.pathname).toBe('https://accounts.zoho.com.au/oauth/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: '1000.CLIENT',
      response_type: 'code',
      redirect_uri: 'https://crm.bluven.example/api/zoho/callback',
      scope: 'ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoMail.messages.READ,ZohoMail.messages.CREATE',
      access_type: 'offline',
      prompt: 'consent',
      state: 'state-123',
    });

    const seen: { url: string; body: string }[] = [];
    let answer: unknown = { access_token: 'a', refresh_token: 'r', expires_in: 3600 };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), body: String(init?.body) });
      return Response.json(answer);
    }) as typeof fetch;
    expect(await exchangeZohoCode(settings, 'the-code', fetchImpl)).toEqual({ accessToken: 'a', refreshToken: 'r', expiresInSeconds: 3600 });
    expect(seen[0]!.url).toBe('https://accounts.zoho.com.au/oauth/v2/token');
    expect(Object.fromEntries(new URLSearchParams(seen[0]!.body))).toEqual({ client_id: '1000.CLIENT', client_secret: 'client-secret-for-tests', grant_type: 'authorization_code', code: 'the-code', redirect_uri: 'https://crm.bluven.example/api/zoho/callback' });
    answer = { error: 'invalid_code' };
    await expect(exchangeZohoCode(settings, 'old', fetchImpl)).rejects.toMatchObject({ authFailed: true, retryable: false });
  });

  it('talks to the mail API with the Zoho token header, renews a token that ran out once, and reads what comes back', async () => {
    const seen: { url: string; auth: string | null; method: string; body: unknown }[] = [];
    let tokens = 0;
    let refuseFirst = true;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('authorization');
      seen.push({ url, auth, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      if (refuseFirst && auth === 'Zoho-oauthtoken token-1') return Response.json({ status: { code: 401 }, data: { errorCode: 'INVALID_OAUTHTOKEN' } }, { status: 401 });
      if (url.endsWith('/messages/view?folderId=f1&start=1&limit=50&sortBy=date&sortorder=false&includeto=true&includearchive=true')) {
        return Response.json({
          status: { code: 200 },
          data: [
            { messageId: '171', folderId: 'f1', threadId: '170', subject: 'Re: Smith &amp; Sons &lt;quote&gt;', summary: 'Hi &quot;Sam&quot;', sender: 'Jane Smith', fromAddress: 'Jane@Example.com', toAddress: '&quot;Sam&quot;&lt;sam@bluven.example&gt;', ccAddress: 'Not Provided', receivedTime: '1794300000000', hasAttachment: '1' },
            { subject: 'broken, no id' },
          ],
        });
      }
      if (url.includes('/header')) return Response.json({ data: { headerContent: { 'Message-Id': ['<abc@mail>'], 'In-Reply-To': ['<prev@mail>'], Received: ['a', 'b'] } } });
      if (url.includes('/attachments?fileName=')) return Response.json({ data: { storeName: 's1', attachmentPath: '/compose/q.pdf', attachmentName: 'q.pdf' } });
      return Response.json({ data: { messageId: 9001 } });
    }) as typeof fetch;
    const client = new ZohoMailClient({ mailUrl: 'https://mail.zoho.com.au/', fetchImpl, accessToken: async (force) => `token-${force ? ++tokens + 1 : 1}` });

    const list = await client.listMessages('acc', 'f1', { start: 1, limit: 50 });
    // Text comes HTML-encoded, like the addresses; the entry without an id is counted but not kept.
    expect(list).toEqual({
      items: [{ messageId: '171', folderId: 'f1', threadId: '170', subject: 'Re: Smith & Sons <quote>', from: { address: 'jane@example.com', name: 'Jane Smith' }, to: [{ name: 'Sam', address: 'sam@bluven.example' }], cc: [], time: new Date(1794300000000), hasAttachment: true, summary: 'Hi "Sam"' }],
      received: 2,
    });
    // The first token was refused; the call was repeated once with a fresh one.
    expect(seen.map((s) => s.auth)).toEqual(['Zoho-oauthtoken token-1', 'Zoho-oauthtoken token-2']);
    refuseFirst = false;

    expect(await client.getHeaders('acc', 'f1', '171')).toEqual({ 'message-id': ['<abc@mail>'], 'in-reply-to': ['<prev@mail>'], received: ['a', 'b'] });
    expect(await client.uploadAttachment('acc', 'q u.pdf', Readable.from([Buffer.from('%PDF')]))).toEqual({ storeName: 's1', attachmentPath: '/compose/q.pdf', attachmentName: 'q.pdf' });
    expect(seen.at(-1)).toMatchObject({ url: 'https://mail.zoho.com.au/api/accounts/acc/messages/attachments?fileName=q%20u.pdf', method: 'POST' });

    const outgoing = { from: 'sam@bluven.example', to: ['jane@example.com', 'j2@example.com'], cc: ['p@example.com'], subject: 'Quote', html: '<p>Hi</p>', attachments: [{ storeName: 's1', attachmentPath: '/compose/q.pdf', attachmentName: 'q.pdf' }] };
    expect(await client.send('acc', outgoing)).toEqual({ messageId: '9001', messageIdHeader: null });
    expect(seen.at(-1)).toMatchObject({
      url: 'https://mail.zoho.com.au/api/accounts/acc/messages',
      method: 'POST',
      body: { fromAddress: 'sam@bluven.example', toAddress: 'jane@example.com,j2@example.com', ccAddress: 'p@example.com', subject: 'Quote', content: '<p>Hi</p>', mailFormat: 'html', askReceipt: 'no', attachments: outgoing.attachments },
    });
    await client.send('acc', { ...outgoing, cc: [], attachments: [], replyToMessageId: '171' });
    expect(seen.at(-1)).toMatchObject({ url: 'https://mail.zoho.com.au/api/accounts/acc/messages/171', body: { action: 'reply' } });
    expect((seen.at(-1)!.body as Record<string, unknown>).ccAddress).toBeUndefined();
    expect(parseListItem({ messageId: 'x', folderId: 'f', receivedTime: 'soon' })).toBeNull();
  });

  it('reads the inbox, the sent folder and folders of the user’s own, and nothing else', () => {
    expect(classifyFolders(new FakeMail().folders)).toEqual([
      { id: 'f_inbox', name: 'Inbox', kind: 'inbox' },
      { id: 'f_sent', name: 'Sent', kind: 'sent' },
      { id: 'f_filed', name: 'Customers', kind: 'filed' },
    ]);
  });
});

describe('what Zoho says when it refuses', () => {
  const settings = () => zohoSettings()!;
  const answering = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;

  it('tells apart a withdrawn permission, wrong server settings and being asked to wait', async () => {
    await expect(refreshZohoToken(settings(), 'r', answering({ error: 'invalid_code' }))).rejects.toMatchObject({ authFailed: true, setupFailed: false, throttled: false });
    await expect(refreshZohoToken(settings(), 'r', answering({ error: 'invalid_client' }))).rejects.toMatchObject({ authFailed: false, setupFailed: true, message: expect.stringContaining('ZOHO_CLIENT_ID') });
    await expect(refreshZohoToken(settings(), 'r', answering({ error: 'invalid_client_secret' }))).rejects.toMatchObject({ authFailed: false, setupFailed: true });
    await expect(
      refreshZohoToken(settings(), 'r', answering({ error: 'Access Denied', error_description: 'You have made too many requests continuously. Please try again after some time.' }, 400)),
    ).rejects.toMatchObject({ throttled: true, authFailed: false, retryable: true });
    // A status by itself says nothing about the person's permission.
    await expect(refreshZohoToken(settings(), 'r', answering({}, 400))).rejects.toMatchObject({ authFailed: false, setupFailed: false, throttled: false, retryable: false });
    await expect(refreshZohoToken(settings(), 'r', answering({}, 503))).rejects.toMatchObject({ authFailed: false, retryable: true });
    // An hour at most, whatever unit the number came in.
    expect((await refreshZohoToken(settings(), 'r', answering({ access_token: 'a', expires_in: 3_600_000 }))).expiresInSeconds).toBe(3600);
    expect((await refreshZohoToken(settings(), 'r', answering({ access_token: 'a', expires_in: 3_600_000, expires_in_sec: 1800 }))).expiresInSeconds).toBe(1800);
  });

  it('withdraws a permission by the documented call, and by the older one when that is refused', async () => {
    const seen: string[] = [];
    const refusingTheNewForm = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return String(url).endsWith('/oauth/v2/revoke/token') ? Response.json({ error: 'invalid_request' }, { status: 400 }) : new Response(null, { status: 200 });
    }) as typeof fetch;
    expect(await revokeZohoToken(settings(), 'r 1', refusingTheNewForm)).toBe(true);
    expect(seen).toEqual(['https://accounts.zoho.com.au/oauth/v2/revoke/token', 'https://accounts.zoho.com.au/oauth/v2/token/revoke?token=r%201']);
    // A refusal can come with status 200.
    expect(await revokeZohoToken(settings(), 'r', answering({ error: 'invalid_token' }))).toBe(false);
    expect(await revokeZohoToken(settings(), 'r', (async () => new Response(null, { status: 500 })) as unknown as typeof fetch)).toBe(false);
    expect(
      await revokeZohoToken(settings(), 'r', (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch),
    ).toBe(false);
  });

  it('renews a token Zoho calls invalid without answering 401, and recognises being told to slow down', async () => {
    let calls = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      return new Headers(init?.headers).get('authorization') === 'Zoho-oauthtoken old'
        ? Response.json({ status: { code: 404, description: 'Invalid Input' }, data: { errorCode: 'INVALID_OAUTHTOKEN' } }, { status: 404 })
        : Response.json({ data: [] });
    }) as typeof fetch;
    const client = new ZohoMailClient({ mailUrl: 'https://mail.zoho.com.au', fetchImpl, accessToken: async (force) => (force ? 'new' : 'old') });
    expect(await client.listFolders('acc')).toEqual([]);
    expect(calls).toBe(2);

    const told = (body: unknown, status: number) => new ZohoMailClient({ mailUrl: 'https://mail.zoho.com.au', fetchImpl: answering(body, status), accessToken: async () => 't' });
    await expect(told({ status: { code: 400, description: 'Too many requests. Please try again later.' } }, 400).listFolders('acc')).rejects.toMatchObject({ throttled: true, authFailed: false, retryable: true });
    await expect(told({}, 429).listFolders('acc')).rejects.toMatchObject({ throttled: true });
    await expect(told({ data: { errorCode: 'OAUTH_SCOPE_MISMATCH' } }, 400).listFolders('acc')).rejects.toMatchObject({ authFailed: true, throttled: false });
    await expect(told({ data: { errorCode: 'INVALID_METHOD' } }, 400).listFolders('acc')).rejects.toMatchObject({ authFailed: false, throttled: false, retryable: false });
  });

  it('takes the time of a message from its id when Zoho leaves it out, and spaces its requests evenly', async () => {
    expect(parseListItem({ messageId: '1794300000123100007', folderId: 'f', sentDateInGMT: '1794260400000' })!.time).toEqual(new Date(1794300000123));
    expect(parseListItem({ messageId: '1794300000123100007', folderId: 'f', receivedTime: '1794300009999', sentDateInGMT: '1794260400000' })!.time).toEqual(new Date(1794300009999));
    expect(parseListItem({ messageId: 'abc', folderId: 'f', sentDateInGMT: '1794260400000' })!.time).toEqual(new Date(1794260400000));

    let t = 0;
    const waits: number[] = [];
    const pace = createPacer(24, async (ms) => void (waits.push(ms), (t += ms)), () => t);
    await pace();
    await pace();
    await pace();
    expect(waits).toEqual([2500, 2500]);
    // After a quiet spell the next request goes at once.
    t += 10_000;
    await pace();
    expect(waits).toHaveLength(2);
  });

  it('a pacer given to a mailbox is waited on before each request', async () => {
    const account = await connect();
    let waited = 0;
    const fetchImpl = (async () => Response.json({ data: [] })) as unknown as typeof fetch;
    const api = mailApiFor(db, account, { fetchImpl, pace: async () => void waited++ }, w.clock.now);
    await api.listFolders('acc_1');
    await api.listMessages('acc_1', 'f', { start: 1, limit: 50 });
    expect(waited).toBe(2);
  });
});

describe('connecting a mailbox', () => {
  it('stores the permission sealed, one mailbox per person, and forgets it on request', async () => {
    const account = await connect();
    expect(account).toMatchObject({ address: SAM_MAIL, addresses: [SAM_MAIL, 'sam.alias@bluven.example'], providerAccountId: 'acc_1', needsReconnect: false });
    expect(account.refreshTokenEnc).not.toContain('refresh-1');
    expect(openSecret(account.refreshTokenEnc, getConfig().zoho.clientSecret, 'mail-token')).toBe('refresh-1');
    // The first read goes two weeks back.
    expect(Math.round((w.clock.current.getTime() - account.syncFrom.getTime()) / 86_400_000)).toBe(14);
    expect(await db.auditLog.count({ where: { action: 'mail.connect', actorId: w.sam.id } })).toBe(1);
    expect(await getOwnMailbox(sam())).toMatchObject({ address: SAM_MAIL, needsReconnect: false });

    // The same mailbox cannot be claimed by a second person; other roles do not connect one at all.
    await expect(connect(w.alex)).rejects.toMatchObject({ code: 'conflict' });
    await expect(connect(w.fin)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await listMailboxes(as(w.manager, w.clock))).map((m) => [m.userName, m.address])).toEqual([['Sam Sales', SAM_MAIL]]);
    await expect(listMailboxes(sam())).rejects.toMatchObject({ code: 'forbidden' });

    const revoked: { url: string; auth: string | null; body: string }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => (revoked.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), body: String(init?.body ?? '') }), Response.json({ status: 'success' }))) as typeof fetch;
    expect(await disconnectMailbox(sam(), {}, { fetchImpl })).toEqual({ revoked: true });
    expect(revoked).toEqual([{ url: 'https://accounts.zoho.com.au/oauth/v2/revoke/token', auth: `Basic ${Buffer.from('1000.CLIENT:client-secret-for-tests').toString('base64')}`, body: 'token=refresh-1&token_type=refresh_token' }]);
    expect(await db.emailAccount.count()).toBe(0);
    expect(await getOwnMailbox(sam())).toBeNull();
  });

  it('renews the hourly token from the stored permission and remembers the new one', async () => {
    const account = await connect();
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      asked.push(url.includes('/oauth/') ? `token:${new URLSearchParams(String(init?.body)).get('refresh_token')}` : `${new Headers(init?.headers).get('authorization')}`);
      return url.includes('/oauth/') ? Response.json({ access_token: 'access-2', expires_in: 3600 }) : Response.json({ data: [] });
    }) as typeof fetch;
    // Within the hour the stored token is used as it is.
    await mailApiFor(db, account, { fetchImpl }, w.clock.now).listFolders('acc_1');
    expect(asked).toEqual(['Zoho-oauthtoken access-1']);
    w.clock.advanceMinutes(61);
    await mailApiFor(db, account, { fetchImpl }, w.clock.now).listFolders('acc_1');
    expect(asked.slice(1)).toEqual(['token:refresh-1', 'Zoho-oauthtoken access-2']);
    const after = await db.emailAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(openSecret(after.accessTokenEnc!, getConfig().zoho.clientSecret, 'mail-token')).toBe('access-2');
  });
});

describe('reading a mailbox', () => {
  it('puts mail with a known customer on their order and leaves everything else alone', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await connect();
    const fromJane = mail.add({ from: JANE, to: [who(SAM_MAIL)], subject: 'Question about the battery', html: '<p>Hi Sam,</p><p>Does the battery work in a blackout?</p><br><p>On Mon, 9 Nov 2026, Sam wrote:</p><blockquote>Hello</blockquote>' });
    mail.add({ from: who('newsletter@shop.example'), to: [who(SAM_MAIL)], subject: 'Sale!' });
    mail.add({ from: who(w.alex.email, 'Alex'), to: [who(SAM_MAIL)], cc: [JANE], subject: 'Between colleagues' });
    mail.add({ folderId: 'f_spam', from: JANE, to: [who(SAM_MAIL)], subject: 'In the spam folder' });
    mail.add({ folderId: 'f_filed', from: JANE, to: [who('sam.alias@bluven.example')], subject: 'Filed by a rule', time: new Date(w.clock.current.getTime() - 3_600_000) });

    expect(await run()).toEqual({ stored: 2, passedOver: 2, attachments: 0 });
    const stored = await db.emailMessage.findMany({ orderBy: { sentAt: 'desc' } });
    expect(stored.map((m) => [m.subject, m.direction, m.orderId === orderId])).toEqual([
      ['Question about the battery', 'IN', true],
      ['Filed by a rule', 'IN', true],
    ]);
    expect(stored[0]).toMatchObject({ fromAddress: 'jane@example.com', fromName: 'Jane Smith', toAddresses: [SAM_MAIL], providerMessageId: fromJane.id, messageIdHeader: fromJane.messageIdHeader, unknownSender: null });
    expect(stored[0]!.bodyText).toContain('Does the battery work in a blackout?');
    // Only what the content of a known customer needs was fetched; the newsletter was never opened.
    expect(mail.calls.filter((c) => c.startsWith('content:'))).toHaveLength(2);

    // On the timeline, without the conversation quoted underneath, and the salesperson is told in the CRM only.
    const activity = await db.activity.findFirstOrThrow({ where: { orderId, type: 'EMAIL_IN' }, orderBy: { occurredAt: 'desc' } });
    expect(activity).toMatchObject({ summary: 'Email from Jane Smith: Question about the battery', body: 'Hi Sam,\n\nDoes the battery work in a blackout?', actorId: null, actorLabel: 'Jane Smith' });
    expect(await db.notification.findMany({ where: { userId: w.sam.id, type: 'mail.received' }, select: { emailStatus: true } })).toEqual([{ emailStatus: 'NONE' }, { emailStatus: 'NONE' }]);
    // A customer writing is not the salesperson working: the order stays where it was.
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).stage).toBe('NEW');

    // Reading again stores nothing twice.
    w.clock.advanceMinutes(1);
    expect((await run()).stored).toBe(0);
    expect(await db.emailMessage.count()).toBe(2);
  });

  it('treats what the salesperson sent from their own mail program as work on the order', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await connect();
    w.clock.advanceDays(1);
    const sentAt = new Date(w.clock.current.getTime() - 2 * 3_600_000);
    // Mail from before the enquiry (an earlier sale, perhaps) says nothing about this order.
    mail.add({ folderId: 'f_sent', from: who(SAM_MAIL, 'Sam Sales'), to: [JANE], subject: 'Last year', time: new Date(w.clock.current.getTime() - 3 * 86_400_000) });
    mail.add({ folderId: 'f_sent', from: who(SAM_MAIL, 'Sam Sales'), to: [JANE], subject: 'Your solar quote', html: '<p>Hi Jane, the quote is attached.</p>', time: sentAt });
    await db.order.update({ where: { id: orderId }, data: { lastStaffActivityAt: new Date(w.clock.current.getTime() - 6 * 86_400_000), idleLevel: 1 } });

    expect((await run()).stored).toBe(2);
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({ stage: 'CONTACTED', firstContactedAt: sentAt, lastStaffActivityAt: sentAt, idleLevel: 0 });
    expect(await db.activity.findFirstOrThrow({ where: { orderId, type: 'EMAIL_OUT' }, orderBy: { occurredAt: 'desc' } })).toMatchObject({ summary: 'Email to Jane Smith: Your solar quote', actorId: w.sam.id });
    expect(await db.notification.count({ where: { type: 'mail.received' } })).toBe(0);
  });

  it('keeps attachments, and says so when one could not be kept', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await connect();
    const bill = pdf('electricity bill');
    mail.add({
      from: JANE,
      to: [who(SAM_MAIL)],
      subject: 'My bill',
      attachments: [
        { id: 'a1', name: 'AGL bill.pdf', body: bill },
        { id: 'a2', name: 'huge.mov', body: Buffer.from('x'), size: getConfig().maxUploadBytes + 1 },
        { id: 'a3', name: 'photo.png', body: 'unreachable' },
      ],
    });
    expect(await run()).toEqual({ stored: 1, passedOver: 0, attachments: 1 });
    const { emails } = await getOrderMail(sam(), orderId);
    expect(emails[0]!.attachments.map((a) => [a.fileName, a.available, a.mimeType, !!a.skippedReason])).toEqual([
      ['AGL bill.pdf', true, 'application/pdf', false],
      ['huge.mov', false, 'application/octet-stream', true],
      ['photo.png', false, 'application/octet-stream', true],
    ]);
    const opened = await openEmailAttachment(sam(), { attachmentId: emails[0]!.attachments[0]!.id, purpose: 'download' });
    expect(opened).toMatchObject({ fileName: 'AGL bill.pdf', sizeBytes: bill.length, inlineSafe: true });
    expect(await db.auditLog.count({ where: { action: 'mail.attachment_download', actorId: w.sam.id } })).toBe(1);
    await expect(openEmailAttachment(sam(), { attachmentId: emails[0]!.attachments[1]!.id, purpose: 'download' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('follows a conversation when the customer answers from another address, and offers to add it', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await connect();
    const first = mail.add({ folderId: 'f_sent', threadId: 'thread-9', from: who(SAM_MAIL), to: [JANE], time: new Date(w.clock.current.getTime() - 3_600_000) });
    await run();
    mail.add({ threadId: 'thread-9', from: who('jane.work@corp.example', 'Jane S'), to: [who(SAM_MAIL)], subject: 'Re: Your solar quote', inReplyTo: first.messageIdHeader });
    mail.add({ from: who('stranger@corp.example'), to: [who(SAM_MAIL)], subject: 'Unrelated' });
    w.clock.advanceMinutes(1);
    expect((await run()).stored).toBe(1);
    const reply = await db.emailMessage.findFirstOrThrow({ where: { direction: 'IN' } });
    expect(reply).toMatchObject({ orderId, unknownSender: 'jane.work@corp.example', inReplyTo: first.messageIdHeader, references: [first.messageIdHeader] });

    // Only someone working on the order can add the address; then nothing asks again.
    await expect(addSenderToCustomer(as(w.alex, w.clock), { emailId: reply.id })).rejects.toMatchObject({ code: 'not_found' });
    expect(await addSenderToCustomer(sam(), { emailId: reply.id })).toEqual({ address: 'jane.work@corp.example' });
    expect((await db.customerEmail.findMany({ where: { customerId: reply.customerId }, orderBy: { createdAt: 'asc' } })).map((e) => e.email)).toEqual(['jane@example.com', 'jane.work@corp.example']);
    expect((await db.emailMessage.findUniqueOrThrow({ where: { id: reply.id } })).unknownSender).toBeNull();
    expect(await db.auditLog.count({ where: { action: 'customer.update', customerId: reply.customerId, summary: { contains: 'jane.work@corp.example' } } })).toBe(1);
  });

  it('stores a message once however many mailboxes it reached', async () => {
    await orderAt(w, 'ASSIGNED');
    await connect();
    const alexMail = new FakeMail();
    alexMail.account = { accountId: 'acc_2', primaryAddress: 'alex@bluven.example', addresses: ['alex@bluven.example'], displayName: 'Alex' };
    await connect(w.alex, alexMail);
    const shared = { from: JANE, to: [who(SAM_MAIL), who('alex@bluven.example')], subject: 'To you both', messageIdHeader: 'same@mail.example' };
    mail.add(shared);
    alexMail.add(shared);
    expect((await run(mail)).stored).toBe(1);
    expect((await run(alexMail)).stored).toBe(0);
    expect(await db.emailMessage.count()).toBe(1);
  });

  it('leaves the order open when the customer has several, for a person to choose', async () => {
    const first = await orderAt(w, 'ASSIGNED');
    const second = await orderAt(w, 'ASSIGNED', { address: '9 Other Rd', suburb: 'Ryde', postcode: '2112' });
    expect(second.orderId).not.toBe(first.orderId);
    await connect();
    w.clock.advanceMinutes(30);
    mail.add({ threadId: 'th', from: JANE, to: [who(SAM_MAIL)], subject: 'About the second house' });
    mail.add({ threadId: 'th', folderId: 'f_sent', from: who(SAM_MAIL), to: [JANE], subject: 'Re: About the second house', time: new Date(w.clock.current.getTime() - 30_000) });
    expect((await run()).stored).toBe(2);
    expect((await db.emailMessage.findMany()).every((m) => m.orderId === null)).toBe(true);
    // The person who can say which order it is about is told; nothing is on either timeline yet.
    const told = await db.notification.findMany({ where: { type: 'mail.unplaced' }, select: { userId: true, title: true, href: true, emailStatus: true } });
    expect(told).toEqual([{ userId: w.sam.id, title: 'Email from Jane Smith: choose the order it is about', href: expect.stringMatching(/^\/orders\/ord_\w+\?tab=email$/), emailStatus: 'NONE' }]);
    expect([first.orderId, second.orderId].some((id) => told[0]!.href === `/orders/${id}?tab=email`)).toBe(true);
    expect(await db.activity.count({ where: { orderId: { in: [first.orderId, second.orderId] }, type: 'EMAIL_IN' } })).toBe(0);
    // A summary written now does not know about the mail that is still to be placed.
    w.clock.advanceMinutes(10);
    await db.orderSummary.create({ data: { orderId: second.orderId, content: {}, model: 'test', coversUntil: w.clock.current, generatedAt: w.clock.current } });
    // Shown on both orders as waiting to be placed.
    const view = await getOrderMail(sam(), second.orderId);
    expect(view.emails).toHaveLength(0);
    expect(view.unplaced.map((m) => m.subject).sort()).toEqual(['About the second house', 'Re: About the second house']);

    await expect(assignEmailToOrder(as(w.alex, w.clock), { emailId: view.unplaced[0]!.id, orderId: second.orderId })).rejects.toMatchObject({ code: 'not_found' });
    await assignEmailToOrder(sam(), { emailId: view.unplaced.find((m) => m.direction === 'IN')!.id, orderId: second.orderId });
    // The whole conversation moved, the reply counts as first contact, and the timeline follows.
    expect((await db.emailMessage.findMany()).every((m) => m.orderId === second.orderId)).toBe(true);
    expect(await db.activity.count({ where: { orderId: second.orderId, type: { in: ['EMAIL_IN', 'EMAIL_OUT'] } } })).toBe(2);
    expect((await db.order.findUniqueOrThrow({ where: { id: second.orderId } })).stage).toBe('CONTACTED');
    expect((await db.order.findUniqueOrThrow({ where: { id: first.orderId } })).stage).toBe('NEW');
    expect((await getOrderMail(sam(), first.orderId)).unplaced).toHaveLength(0);
    // The summary is now older than what is on the order: it reads as out of date and is rewritten.
    const arrived = await db.activity.findFirstOrThrow({ where: { orderId: second.orderId, type: 'EMAIL_IN' }, select: { createdAt: true } });
    expect((await db.orderSummary.findUniqueOrThrow({ where: { orderId: second.orderId } })).coversUntil < arrived.createdAt).toBe(true);
  });

  it('looks through recent mail again when a new customer address appears', async () => {
    await connect();
    mail.add({ from: who('new.lead@example.com', 'Nina New'), to: [who(SAM_MAIL)], subject: 'Enquiry before the lead existed', time: new Date(w.clock.current.getTime() - 86_400_000) });
    await orderAt(w, 'ASSIGNED'); // so there is at least one customer address to mark as looked at
    expect((await run()).stored).toBe(0);

    w.clock.advanceMinutes(45);
    const { orderId } = await orderAt(w, 'ASSIGNED', { firstName: 'Nina', lastName: 'New', email: 'new.lead@example.com', phone: '0499 111 222', address: '4 New St' });
    w.clock.advanceMinutes(1);
    expect((await run()).stored).toBe(1);
    expect(await db.emailMessage.findFirstOrThrow()).toMatchObject({ subject: 'Enquiry before the lead existed', orderId });
    // No third pass without a reason.
    w.clock.advanceMinutes(1);
    mail.calls = [];
    await run();
    expect(mail.calls.filter((c) => c.startsWith('headers:'))).toEqual([]);
  });

  it('switches off a mailbox whose permission was withdrawn, tells its owner, and carries on with the others', async () => {
    await orderAt(w, 'ASSIGNED');
    await connect();
    const alexMail = new FakeMail();
    alexMail.account = { accountId: 'acc_2', primaryAddress: 'alex@bluven.example', addresses: ['alex@bluven.example'], displayName: 'Alex' };
    await connect(w.alex, alexMail);
    await setMailboxScope(as(w.alex, w.clock), { scope: 'ALL' });
    alexMail.add({ from: JANE, to: [who('alex@bluven.example')] });
    mail.authFailed = true;
    const apiFor = (account: { address: string }) => (account.address === SAM_MAIL ? mail : alexMail);

    expect(await syncAllMailboxes(ctx, apiFor)).toEqual({ mailboxes: 2, stored: 1, failed: 1, removed: 0, pausedUntil: null });
    expect(await db.emailAccount.findFirstOrThrow({ where: { address: SAM_MAIL } })).toMatchObject({ needsReconnect: true, consecutiveFailures: 1, lastError: expect.stringContaining('401') });
    expect(await db.notification.count({ where: { userId: w.sam.id, type: 'mail.reconnect' } })).toBe(1);
    // It is not read again until it has been connected again, and connecting clears the flag.
    expect(await syncAllMailboxes(ctx, apiFor)).toMatchObject({ mailboxes: 1 });
    mail.authFailed = false;
    await connect();
    expect(await syncAllMailboxes(ctx, apiFor)).toMatchObject({ mailboxes: 2, failed: 0 });

    // A passing fault is noted and tried again on the next round.
    mail.down = true;
    w.clock.advanceMinutes(1);
    expect(await syncAllMailboxes(ctx, apiFor)).toMatchObject({ failed: 1 });
    expect(await db.emailAccount.findFirstOrThrow({ where: { address: SAM_MAIL } })).toMatchObject({ needsReconnect: false, consecutiveFailures: 1 });
  });
});

/** A second mailbox, Alex's. */
async function alexMailbox(): Promise<FakeMail> {
  const fake = new FakeMail();
  fake.account = { accountId: 'acc_2', primaryAddress: 'alex@bluven.example', addresses: ['alex@bluven.example'], displayName: 'Alex' };
  await connect(w.alex, fake);
  return fake;
}

describe('whose mail is kept', () => {
  it('keeps mail from a mailbox only for customers its owner works with, unless the owner shares all of it', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await connect();
    const alexMail = await alexMailbox();
    // Sam puts the address of someone Alex corresponds with on his own customer's record.
    await updateCustomer(sam(), { orderId, firstName: 'Jane', lastName: 'Smith', notes: '', phones: ['0412 345 678'], emails: ['jane@example.com', 'accountant@firm.example'] });
    alexMail.add({ from: who('accountant@firm.example', 'The Accountant'), to: [who('alex@bluven.example')], subject: 'Payroll figures' });
    alexMail.add({ folderId: 'f_sent', from: who('alex@bluven.example'), to: [who('accountant@firm.example')], subject: 'Re: Payroll figures' });
    alexMail.add({ from: JANE, to: [who('alex@bluven.example')], subject: 'Wrong salesperson?' });

    expect(await run(alexMail)).toEqual({ stored: 0, passedOver: 3, attachments: 0 });
    // Not kept, and not even opened.
    expect(alexMail.made('headers:')).toEqual([]);
    expect(await db.emailMessage.count()).toBe(0);
    w.clock.advanceMinutes(40);
    expect((await run(alexMail)).stored).toBe(0);

    // Nobody can make the choice for Alex; when he makes it, recent mail is looked through again.
    await expect(setMailboxScope(as(w.manager, w.clock), { scope: 'ALL' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(setMailboxScope(as(w.alex, w.clock), { scope: 'EVERYTHING' })).rejects.toMatchObject({ code: 'validation' });
    await setMailboxScope(as(w.alex, w.clock), { scope: 'ALL' });
    expect(await db.auditLog.count({ where: { action: 'mail.scope', actorId: w.alex.id } })).toBe(1);
    w.clock.advanceMinutes(1);
    expect((await run(alexMail)).stored).toBe(3);
    expect((await db.emailMessage.findMany()).every((m) => m.orderId === orderId)).toBe(true);

    // And back: what is on the order stays, nothing new is added.
    await setMailboxScope(as(w.alex, w.clock), { scope: 'OWN' });
    alexMail.add({ from: who('accountant@firm.example'), to: [who('alex@bluven.example')], subject: 'Next month', time: w.clock.current });
    w.clock.advanceMinutes(1);
    expect((await run(alexMail)).stored).toBe(0);
    expect(await db.emailMessage.count()).toBe(3);
  });

  it('keeps reading for a customer the owner used to have, and for one they wrote to from the CRM', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await connect();
    await assignOrders(as(w.manager, w.clock), { orderIds: [orderId], ownerId: w.alex.id });
    w.clock.advanceMinutes(2);
    mail.add({ from: JANE, to: [who(SAM_MAIL)], subject: 'Still writing to Sam' });
    expect((await run()).stored).toBe(1);
    // It is Alex's order now: he is the one who is told.
    expect(await db.notification.count({ where: { userId: w.alex.id, type: 'mail.received' } })).toBe(1);

    // A manager who writes to the customer from the CRM gets the answer onto the order too.
    const managerMail = new FakeMail();
    managerMail.account = { accountId: 'acc_3', primaryAddress: 'morgan@bluven.example', addresses: ['morgan@bluven.example'], displayName: 'Morgan' };
    await connect(w.manager, managerMail);
    managerMail.add({ from: JANE, to: [who('morgan@bluven.example')], subject: 'Before Morgan wrote' });
    expect((await run(managerMail)).stored).toBe(0);
    await sendOrderEmail(as(w.manager, w.clock), { orderId, to: ['jane@example.com'], subject: 'From the manager', body: 'Hello Jane' }, { apiFor: () => managerMail });
    w.clock.advanceMinutes(31);
    managerMail.add({ from: JANE, to: [who('morgan@bluven.example')], subject: 'Re: From the manager' });
    expect((await run(managerMail)).stored).toBe(2);
  });

  it('treats an address that only came with a website enquiry as unconfirmed until a person says otherwise', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await connect();
    // Somebody who knows Jane's phone number fills in the website form with an address of their own.
    w.clock.advanceMinutes(5);
    const website = await source('bluven-website');
    await ingestLeads(systemCtx(db, 'Bluven website', w.clock.now), [lead({ externalId: 'again', email: 'impostor@evil.example' })], { sourceId: website.id, requireExternalId: true });
    // An address our own people type in is theirs to vouch for.
    await ingestLeads(as(w.manager, w.clock), [lead({ externalId: 'typed', email: 'jane.second@example.com' })], { sourceId: (await source('manual')).id, requireExternalId: false });
    const onRecord = async () => (await db.customerEmail.findMany({ orderBy: [{ createdAt: 'asc' }, { email: 'asc' }] })).map((r) => [r.email, r.unconfirmed]);
    expect((await onRecord()).sort()).toEqual([
      ['impostor@evil.example', true],
      ['jane.second@example.com', false],
      ['jane@example.com', false],
    ]);

    mail.add({ from: who('impostor@evil.example', 'Jane Smith'), to: [who(SAM_MAIL)], subject: 'Please send the contract again' });
    w.clock.advanceMinutes(1);
    expect((await run()).stored).toBe(1);
    const view = (await getOrderMail(sam(), orderId)).emails[0]!;
    expect(view).toMatchObject({ unknownSender: 'impostor@evil.example', senderAwaitsConfirmation: true });
    // The name is whatever the sender typed, so the address goes with it.
    expect((await db.activity.findFirstOrThrow({ where: { orderId, type: 'EMAIL_IN' } })).summary).toBe('Email from Jane Smith <impostor@evil.example>: Please send the contract again');
    // It is not an address the order's mail can go to.
    const deps = { apiFor: () => mail };
    await expect(sendOrderEmail(sam(), { orderId, to: ['impostor@evil.example'], subject: 'Contract', body: 'Attached.' }, deps)).rejects.toMatchObject({ fieldErrors: { to: expect.stringContaining('nobody has confirmed') } });
    expect(mail.sent).toHaveLength(0);

    // Someone working on the order confirms it, from the message or from the customer's card.
    await expect(addSenderToCustomer(as(w.alex, w.clock), { emailId: view.id })).rejects.toMatchObject({ code: 'not_found' });
    await addSenderToCustomer(sam(), { emailId: view.id });
    expect((await onRecord()).every(([, unconfirmed]) => !unconfirmed)).toBe(true);
    expect((await getOrderMail(sam(), orderId)).emails[0]).toMatchObject({ unknownSender: null, senderAwaitsConfirmation: false });
    expect(await db.auditLog.count({ where: { action: 'customer.update', summary: { contains: 'Confirmed that impostor@evil.example' } } })).toBe(1);
    await sendOrderEmail(sam(), { orderId, to: ['impostor@evil.example'], subject: 'Contract', body: 'Attached.' }, deps);
    expect(mail.sent).toHaveLength(1);

    await ingestLeads(systemCtx(db, 'Bluven website', w.clock.now), [lead({ externalId: 'third', email: 'another@evil.example' })], { sourceId: website.id, requireExternalId: true });
    const row = await db.customerEmail.findFirstOrThrow({ where: { email: 'another@evil.example' } });
    expect(row.unconfirmed).toBe(true);
    await expect(confirmCustomerEmail(as(w.alex, w.clock), { orderId, emailId: row.id })).rejects.toMatchObject({ code: 'not_found' });
    await confirmCustomerEmail(sam(), { orderId, emailId: row.id });
    expect((await db.customerEmail.findUniqueOrThrow({ where: { id: row.id } })).unconfirmed).toBe(false);
  });

  it('does not take a message’s own word for who it is from', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await connect();
    // A stranger writes to Sam and copies the customer in.
    mail.add({ from: who('someone@elsewhere.example', 'Jane Smith'), to: [who(SAM_MAIL)], cc: [JANE], subject: 'About my quote' });
    // A message in the inbox that claims to be from Sam himself.
    mail.add({ from: who(SAM_MAIL, 'Sam Sales'), to: [JANE], subject: 'We will install it for free' });
    expect((await run()).stored).toBe(1);
    expect(await db.emailMessage.findMany()).toMatchObject([{ subject: 'About my quote', direction: 'IN', unknownSender: 'someone@elsewhere.example', orderId }]);
    expect((await getOrderMail(sam(), orderId)).emails[0]).toMatchObject({ unknownSender: 'someone@elsewhere.example', senderAwaitsConfirmation: false });
    // Nothing here is the salesperson's work on the order.
    expect(await db.order.findUniqueOrThrow({ where: { id: orderId } })).toMatchObject({ stage: 'NEW', firstContactedAt: null });
    expect(await db.activity.count({ where: { orderId, type: 'EMAIL_OUT' } })).toBe(0);

    // What the owner moved out of the sent folder into a folder of their own is still theirs.
    mail.add({ folderId: 'f_filed', from: who(SAM_MAIL, 'Sam Sales'), to: [JANE], subject: 'Filed away after sending', time: new Date(w.clock.current.getTime() - 30_000) });
    for (let i = 0; i < 2; i++) {
      w.clock.advanceMinutes(1);
      await run();
    }
    expect(await db.emailMessage.findFirstOrThrow({ where: { direction: 'OUT' } })).toMatchObject({ subject: 'Filed away after sending', orderId });
  });

  it('follows a conversation the way Zoho numbers it: no id on the first message, the first message’s id from then on', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await connect();
    const first = mail.add({ folderId: 'f_sent', threadId: null, from: who(SAM_MAIL), to: [JANE], subject: 'Your quote', time: new Date(w.clock.current.getTime() - 3_600_000) });
    await run();
    expect(await db.emailMessage.findFirstOrThrow()).toMatchObject({ providerMessageId: first.id, providerThreadId: first.id });
    // Jane's partner answers from an address nobody has on record.
    first.threadId = first.id;
    mail.add({ threadId: first.id, from: who('partner@home.example', 'Pat'), to: [who(SAM_MAIL)], subject: 'Re: Your quote', inReplyTo: first.messageIdHeader });
    w.clock.advanceMinutes(1);
    expect((await run()).stored).toBe(1);
    expect(await db.emailMessage.findFirstOrThrow({ where: { direction: 'IN' } })).toMatchObject({ orderId, unknownSender: 'partner@home.example', providerThreadId: first.id });
  });

  it('puts an answer to a message written in the CRM on the order it was written from', async () => {
    await orderAt(w, 'ASSIGNED');
    const ryde = await orderAt(w, 'ASSIGNED', { address: '9 Other Rd', suburb: 'Ryde', postcode: '2112' });
    await connect();
    mail.reportSentHeader = true;
    const sent = await sendOrderEmail(sam(), { orderId: ryde.orderId, to: ['jane@example.com'], subject: 'About Ryde', body: 'Hello' }, { apiFor: () => mail });
    expect(await db.emailMessage.findUniqueOrThrow({ where: { id: sent.id! } })).toMatchObject({ providerMessageId: 'sent1', providerThreadId: 'sent1', messageIdHeader: 'crm-1@mail.example' });

    // Jane has two open orders, so her mail would wait for a person. But this one says what it answers,
    w.clock.advanceMinutes(2);
    mail.add({ threadId: null, from: JANE, to: [who(SAM_MAIL)], subject: 'Re: About Ryde', inReplyTo: 'crm-1@mail.example' });
    expect((await run()).stored).toBe(1);
    // and the next one is in the conversation Zoho numbers after the message that started it.
    w.clock.advanceMinutes(2);
    mail.add({ threadId: 'sent1', from: JANE, to: [who(SAM_MAIL)], subject: 'One more thing' });
    expect((await run()).stored).toBe(1);
    expect((await db.emailMessage.findMany({ where: { direction: 'IN' } })).map((m) => m.orderId)).toEqual([ryde.orderId, ryde.orderId]);

    // Without a Message-ID from the provider at sending, it is read from the copy in the sent folder.
    mail.reportSentHeader = false;
    const second = await sendOrderEmail(sam(), { orderId: ryde.orderId, to: ['jane@example.com'], subject: 'And another', body: 'Hello again' }, { apiFor: () => mail });
    mail.add({ id: 'sent2', folderId: 'f_sent', threadId: null, from: who(SAM_MAIL), to: [JANE], subject: 'And another', time: w.clock.current, messageIdHeader: 'later@mail.example' });
    w.clock.advanceMinutes(1);
    expect((await run()).stored).toBe(0);
    expect(await db.emailMessage.findUniqueOrThrow({ where: { id: second.id! } })).toMatchObject({ messageIdHeader: 'later@mail.example', providerThreadId: 'sent2' });
  });
});

describe('when reading does not go smoothly', () => {
  it('does not let one unreadable message hold up the rest, and gives up on it after three tries', async () => {
    await orderAt(w, 'ASSIGNED');
    await connect();
    const bad = mail.add({ from: JANE, to: [who(SAM_MAIL)], subject: 'Cannot be opened', time: new Date(w.clock.current.getTime() - 10 * 60_000) });
    mail.broken[bad.id] = 'bad';
    mail.add({ from: JANE, to: [who(SAM_MAIL)], subject: 'Fine', time: new Date(w.clock.current.getTime() - 5 * 60_000) });
    mail.add({ folderId: 'f_sent', from: who(SAM_MAIL), to: [JANE], subject: 'From Sam', time: new Date(w.clock.current.getTime() - 4 * 60_000) });
    // The good one in the same folder and the folder after it are both read.
    expect((await run()).stored).toBe(2);
    expect((await getOwnMailbox(sam()))!.unreadable).toEqual([]);
    for (let i = 0; i < 2; i++) {
      w.clock.advanceMinutes(1);
      await run();
    }
    expect((await getOwnMailbox(sam()))!.unreadable).toEqual([{ subject: 'Cannot be opened', at: bad.time, error: expect.stringContaining('400') }]);
    expect((await listMailboxes(as(w.manager, w.clock)))[0]!.unreadable).toHaveLength(1);
    // After that it is left alone, and it no longer costs a request.
    mail.calls = [];
    w.clock.advanceMinutes(1);
    expect(await run()).toMatchObject({ stored: 0 });
    expect(mail.made(`headers:${bad.id}`)).toEqual([]);
    expect(await db.emailMessage.count()).toBe(2);
  });

  it('takes a failure that may be the service’s for what it is', async () => {
    await orderAt(w, 'ASSIGNED');
    await connect();
    const flaky = mail.add({ from: JANE, to: [who(SAM_MAIL)], subject: 'Flaky', time: new Date(w.clock.current.getTime() - 5 * 60_000) });
    mail.broken[flaky.id] = 'flaky';
    // By itself it proves nothing: it is tried again, and nobody is told it cannot be read.
    expect((await run()).stored).toBe(0);
    w.clock.advanceMinutes(1);
    expect((await run()).stored).toBe(0);
    expect(mail.made(`content:${flaky.id}`)).toHaveLength(2);
    expect((await getOwnMailbox(sam()))!.unreadable).toEqual([]);

    // Two in a row: the service is having trouble. The round for this mailbox ends, and no message is blamed.
    const second = mail.add({ from: JANE, to: [who(SAM_MAIL)], subject: 'Also flaky', time: new Date(w.clock.current.getTime() - 30_000) });
    mail.broken[second.id] = 'flaky';
    w.clock.advanceMinutes(1);
    await expect(run()).rejects.toMatchObject({ retryable: true });
    expect((await getOwnMailbox(sam()))!.unreadable).toEqual([]);

    // One of them gets through later; the other keeps failing for hours and is given up on.
    delete mail.broken[second.id];
    w.clock.advanceMinutes(1);
    expect((await run()).stored).toBe(1);
    w.clock.advanceMinutes(7 * 60);
    await run();
    expect((await getOwnMailbox(sam()))!.unreadable).toMatchObject([{ subject: 'Flaky' }]);
  });

  it('reads a backlog a little at a time, without losing its place', async () => {
    await orderAt(w, 'ASSIGNED');
    const account = await connect();
    for (let i = 0; i < 6; i++) mail.add({ from: JANE, to: [who(SAM_MAIL)], subject: `Message ${i}`, time: new Date(w.clock.current.getTime() - (i + 1) * 60_000) });
    const rounds: number[] = [];
    for (let round = 0; round < 4; round++) {
      mail.calls = [];
      rounds.push((await syncMailbox(ctx, account.id, mail, { maxCalls: 8 })).stored);
      expect(mail.calls.length).toBeLessThanOrEqual(8);
      w.clock.advanceMinutes(1);
    }
    // The folder list and the inbox list, then two messages; three the next time; the last one after that.
    expect(rounds).toEqual([2, 3, 1, 0]);
    expect(await db.emailMessage.count()).toBe(6);
    // Once the look at the inbox got all the way back, stored messages are not asked about again.
    mail.calls = [];
    await syncMailbox(ctx, account.id, mail, { maxCalls: 8 });
    expect(mail.made('headers:')).toEqual([]);
  });

  it('stops everything for a while when Zoho says the CRM asks too often', async () => {
    await orderAt(w, 'ASSIGNED');
    await connect();
    const alexMail = await alexMailbox();
    const apiFor = (account: { address: string }) => (account.address === SAM_MAIL ? mail : alexMail);
    mail.throttled = alexMail.throttled = true;

    const first = await syncAllMailboxes(ctx, apiFor);
    // The second mailbox was not even tried, and nobody is asked to connect again.
    expect(first).toMatchObject({ mailboxes: 1, failed: 1 });
    expect(first.pausedUntil!.getTime() - w.clock.current.getTime()).toBe(10 * 60_000);
    expect(await db.emailAccount.count({ where: { needsReconnect: true } })).toBe(0);
    expect(await db.notification.count({ where: { type: 'mail.reconnect' } })).toBe(0);

    // Within the pause nothing is asked at all.
    mail.calls = alexMail.calls = [];
    w.clock.advanceMinutes(5);
    expect(await syncAllMailboxes(ctx, apiFor)).toMatchObject({ mailboxes: 0, failed: 0, pausedUntil: first.pausedUntil });
    expect([...mail.calls, ...alexMail.calls]).toEqual([]);

    // Told again after the pause: the next one is longer.
    w.clock.advanceMinutes(6);
    const second = await syncAllMailboxes(ctx, apiFor);
    expect(second.pausedUntil!.getTime() - w.clock.current.getTime()).toBe(20 * 60_000);
    expect(await getMailPause(db)).toMatchObject({ strikes: 2, reason: expect.stringContaining('slow down') });

    // When it works again the count starts afresh.
    mail.throttled = alexMail.throttled = false;
    w.clock.advanceMinutes(21);
    expect(await syncAllMailboxes(ctx, apiFor)).toMatchObject({ mailboxes: 2, failed: 0, pausedUntil: null });
    expect(await getMailPause(db)).toBeNull();
  });

  it('does not ask people to connect again when it is the server’s own Zoho settings that are wrong', async () => {
    await orderAt(w, 'ASSIGNED');
    await connect();
    // The hourly token has run out, and Zoho does not accept the client id when a new one is asked for.
    w.clock.advanceMinutes(61);
    const fetchImpl = (async () => Response.json({ error: 'invalid_client' })) as unknown as typeof fetch;
    const result = await syncAllMailboxes(ctx, (account) => mailApiFor(db, account, { fetchImpl }, w.clock.now));
    expect(result).toMatchObject({ failed: 1 });
    expect(result.pausedUntil).not.toBeNull();
    expect(await db.emailAccount.findFirstOrThrow()).toMatchObject({ needsReconnect: false, lastError: expect.stringContaining('ZOHO_CLIENT_ID') });
    expect(await db.notification.count({ where: { type: 'mail.reconnect' } })).toBe(0);
  });

  it('tells the owner and the managers when a mailbox has not been readable for a while', async () => {
    await orderAt(w, 'ASSIGNED');
    await connect();
    mail.down = true;
    for (let i = 0; i < 31; i++) {
      w.clock.advanceMinutes(1);
      await syncAllMailboxes(ctx, () => mail);
    }
    const told = await db.notification.findMany({ where: { type: 'mail.unreadable' }, select: { userId: true } });
    expect(told.map((t) => t.userId).sort()).toEqual([w.sam.id, w.manager.id].sort());
    expect((await db.emailAccount.findFirstOrThrow()).needsReconnect).toBe(false);
  });

  it('disconnects the mailbox of someone who may no longer have one', async () => {
    await orderAt(w, 'ASSIGNED');
    await connect();
    await alexMailbox();
    await db.user.update({ where: { id: w.sam.id }, data: { roles: ['FINANCE'] } });
    await db.user.update({ where: { id: w.alex.id }, data: { isActive: false } });
    const asked: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => (asked.push(String(url)), Response.json({ status: 'success' }))) as typeof fetch;
    expect(await syncAllMailboxes(ctx, () => mail, { fetchImpl })).toMatchObject({ mailboxes: 0, removed: 2 });
    expect(await db.emailAccount.count()).toBe(0);
    expect(asked).toEqual(['https://accounts.zoho.com.au/oauth/v2/revoke/token', 'https://accounts.zoho.com.au/oauth/v2/revoke/token']);
    expect((await db.auditLog.findMany({ where: { action: 'mail.disconnect' }, orderBy: { summary: 'asc' } })).map((a) => a.summary)).toEqual([
      'The mailbox alex@bluven.example of Alex Sales was disconnected: their account is switched off',
      'The mailbox sam@bluven.example of Sam Sales was disconnected: they no longer have a sales or manager role',
    ]);
  });

  it('fetches an attachment later that could not be fetched at first', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await connect();
    const message = mail.add({ from: JANE, to: [who(SAM_MAIL)], subject: 'My bill', attachments: [{ id: 'a1', name: 'bill.pdf', body: 'unreachable' }] });
    await run();
    const reload = () => db.emailAttachment.findFirstOrThrow();
    expect(await reload()).toMatchObject({ storageKey: null, providerAttachmentId: 'a1', fetchAttempts: 0, skippedReason: expect.stringContaining('try again') });
    // The assistant set it aside meanwhile, as a file it could not see.
    await db.emailAttachment.update({ where: { id: (await reload()).id }, data: { aiReadAt: w.clock.current } });

    // Not at once; after five minutes, and it fails again; after half an hour it works.
    w.clock.advanceMinutes(2);
    mail.calls = [];
    await run();
    expect(mail.made('download:')).toEqual([]);
    w.clock.advanceMinutes(4);
    await run();
    expect(await reload()).toMatchObject({ storageKey: null, fetchAttempts: 1 });
    message.attachments[0]!.body = pdf('the bill');
    w.clock.advanceMinutes(30);
    expect((await run()).attachments).toBe(1);
    const fetched = await reload();
    expect(fetched).toMatchObject({ storageKey: expect.stringContaining('mail/'), skippedReason: null, providerAttachmentId: null, aiReadAt: null, mimeType: 'application/pdf' });
    expect((await getOrderMail(sam(), orderId)).emails[0]!.attachments[0]).toMatchObject({ available: true, skippedReason: null });
    await expect(openEmailAttachment(sam(), { attachmentId: fetched.id, purpose: 'download' })).resolves.toMatchObject({ fileName: 'bill.pdf' });
  });

  it('gives up fetching an attachment after three more tries, and leaves it in the mailbox when one sender fills the day', async () => {
    await orderAt(w, 'ASSIGNED');
    await connect();
    mail.add({ from: JANE, to: [who(SAM_MAIL)], subject: 'Photos', attachments: [{ id: 'a1', name: 'roof.png', body: 'unreachable' }] });
    await run();
    for (const minutes of [6, 30, 180]) {
      w.clock.advanceMinutes(minutes);
      await run();
    }
    expect(await db.emailAttachment.findFirstOrThrow()).toMatchObject({ storageKey: null, providerAttachmentId: null, fetchAttempts: 3, skippedReason: 'Could not be fetched from the mailbox; open it there.' });

    // 250 MB within a day from one customer is where the CRM stops storing.
    mail.add({ from: JANE, to: [who(SAM_MAIL)], subject: 'A big one', time: w.clock.current, attachments: [{ id: 'b1', name: 'first.pdf', body: pdf('first') }] });
    w.clock.advanceMinutes(1);
    await run();
    await db.emailAttachment.updateMany({ where: { fileName: 'first.pdf' }, data: { sizeBytes: 249 * 1024 * 1024 } });
    mail.add({ from: JANE, to: [who(SAM_MAIL)], subject: 'And more', time: w.clock.current, attachments: [{ id: 'c1', name: 'second.pdf', body: pdf('second'), size: 2 * 1024 * 1024 }] });
    w.clock.advanceMinutes(1);
    await run();
    expect(await db.emailAttachment.findFirstOrThrow({ where: { fileName: 'second.pdf' } })).toMatchObject({ storageKey: null, providerAttachmentId: null, skippedReason: expect.stringContaining('within a day') });
  });
});

describe('writing to the customer', () => {
  it('sends from the salesperson’s own mailbox with files of the order, and records the quote as sent', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await connect();
    const quote = await createQuote(sam(), { orderId, title: '6.6 kW', dcWatts: 6600, storageWh: null, totalCents: 900_000, depositCents: 90_000, notes: '', file: await (await import('../../core/test/helpers')).staged(pdf('quote v1'), 'Quote.pdf') });
    const quoteDoc = (await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).documentId!;
    const photo = await uploadDocument(sam(), { orderId, typeId: (await docType('install_location')).id, fileName: 'roof.png', body: stream(await png(3)) });

    const sent = await sendOrderEmail(sam(), { orderId, to: ['Jane@Example.com'], cc: ['partner@example.com'], subject: 'Your solar quote', body: 'Hi Jane,\n\nThe quote is attached.\nSam', documentIds: [quoteDoc, photo.id] }, { apiFor: () => mail });
    expect(sent.id).not.toBeNull();
    expect(mail.uploads.map((u) => u.name)).toEqual(['Quote.pdf', 'roof.png']);
    expect(mail.sent[0]).toMatchObject({ from: SAM_MAIL, to: ['jane@example.com'], cc: ['partner@example.com'], subject: 'Your solar quote', replyToMessageId: null });
    expect(mail.sent[0]!.html).toContain('The quote is attached.<br>Sam');
    expect(mail.sent[0]!.attachments).toHaveLength(2);

    const stored = await db.emailMessage.findUniqueOrThrow({ where: { id: sent.id! }, include: { attachments: true } });
    expect(stored).toMatchObject({ direction: 'OUT', orderId, sentById: w.sam.id, providerMessageId: 'sent1', fromAddress: SAM_MAIL, toAddresses: ['jane@example.com'], bodyText: 'Hi Jane,\n\nThe quote is attached.\nSam' });
    expect(stored.attachments.map((a) => a.documentId).sort()).toEqual([quoteDoc, photo.id].sort());
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.stage).toBe('QUOTED');
    expect(order.firstContactedAt).not.toBeNull();
    expect(await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).toMatchObject({ sentVia: 'EMAIL', sentAt: w.clock.current });
    expect(await db.activity.findFirstOrThrow({ where: { orderId, type: 'EMAIL_OUT' } })).toMatchObject({ summary: 'Email to Jane Smith: Your solar quote', actorId: w.sam.id });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: 'mail.send' } })).toMatchObject({ actorId: w.sam.id, orderId });

    // When the sent folder is read afterwards the message is recognised, not stored a second time.
    mail.add({ id: 'sent1', folderId: 'f_sent', from: who(SAM_MAIL), to: [JANE], subject: 'Your solar quote', time: w.clock.current, messageIdHeader: 'crm-1@mail.example' });
    w.clock.advanceMinutes(1);
    expect((await run()).stored).toBe(0);
    expect(await db.emailMessage.count()).toBe(1);
  });

  it('answers a message in the mailbox it is in, and recognises its own mail when the provider gave no id', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    await connect();
    const question = mail.add({ from: JANE, to: [who(SAM_MAIL)], subject: 'Question' });
    await run();
    const received = await db.emailMessage.findFirstOrThrow();
    mail.reportSentId = false;
    const reply = await sendOrderEmail(sam(), { orderId, to: ['jane@example.com'], subject: 'Re: Question', body: 'Yes, it does.', replyToEmailId: received.id }, { apiFor: () => mail });
    expect(mail.sent[0]).toMatchObject({ replyToMessageId: question.id, subject: 'Re: Question' });
    expect(await db.emailMessage.findUniqueOrThrow({ where: { id: reply.id! } })).toMatchObject({ providerMessageId: null, inReplyTo: question.messageIdHeader });

    mail.add({ folderId: 'f_sent', threadId: question.threadId, from: who(SAM_MAIL), to: [JANE], subject: 'Re: Question', time: new Date(w.clock.current.getTime() + 20_000), messageIdHeader: 'reply@mail.example' });
    w.clock.advanceMinutes(1);
    expect((await run()).stored).toBe(0);
    expect(await db.emailMessage.findUniqueOrThrow({ where: { id: reply.id! } })).toMatchObject({ messageIdHeader: 'reply@mail.example', providerThreadId: question.threadId });
    expect(await db.emailMessage.count()).toBe(2);
  });

  it('refuses what should not go out, before anything is sent', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const other = await orderAt(w, 'ASSIGNED', { externalId: 'other', firstName: 'Omar', email: 'omar@example.com', phone: '0400 999 888', address: '1 Else St' });
    const foreignDoc = await uploadDocument(sam(), { orderId: other.orderId, typeId: (await docType('other')).id, fileName: 'theirs.pdf', body: stream(pdf('theirs')) });
    const input = { orderId, to: ['jane@example.com'], subject: 'Hello', body: 'Hi' };
    const deps = { apiFor: () => mail };

    // No mailbox yet.
    await expect(sendOrderEmail(sam(), input, deps)).rejects.toMatchObject({ code: 'validation', message: expect.stringContaining('Connect your mailbox') });
    await connect();
    await expect(sendOrderEmail(sam(), { ...input, to: ['someone@else.example'] }, deps)).rejects.toMatchObject({ fieldErrors: { to: expect.stringContaining('on this customer’s record') } });
    await expect(sendOrderEmail(sam(), { ...input, to: ['not an address'] }, deps)).rejects.toMatchObject({ fieldErrors: { to: expect.any(String) } });
    await expect(sendOrderEmail(sam(), { ...input, subject: ' ', body: '' }, deps)).rejects.toMatchObject({ fieldErrors: { subject: expect.any(String), body: expect.any(String) } });
    await expect(sendOrderEmail(sam(), { ...input, documentIds: [foreignDoc.id] }, deps)).rejects.toMatchObject({ fieldErrors: { documentIds: expect.any(String) } });
    await expect(sendOrderEmail(as(w.alex, w.clock), input, deps)).rejects.toMatchObject({ code: 'not_found' });
    await expect(sendOrderEmail(as(w.fin, w.clock), input, deps)).rejects.toMatchObject({ code: 'not_found' });
    expect(mail.sent).toHaveLength(0);

    // The mail service refusing is told to the person, and a withdrawn permission is remembered.
    mail.down = true;
    await expect(sendOrderEmail(sam(), input, deps)).rejects.toMatchObject({ code: 'validation', message: expect.stringContaining('was not sent') });
    mail.down = false;
    mail.authFailed = true;
    await expect(sendOrderEmail(sam(), input, deps)).rejects.toMatchObject({ message: expect.stringContaining('Connect it again') });
    expect((await db.emailAccount.findFirstOrThrow()).needsReconnect).toBe(true);
    expect(await db.emailMessage.count()).toBe(0);
  });
});

describe('using what the customer sent', () => {
  async function received(attachments: FakeMessage['attachments']) {
    const made = await orderAt(w, 'QUOTED');
    await connect();
    mail.add({ from: JANE, to: [who(SAM_MAIL)], subject: 'Signed and my bill', attachments });
    await run();
    const { emails } = await getOrderMail(sam(), made.orderId);
    return { ...made, email: emails[0]! };
  }

  it('files an attachment into a folder of the order', async () => {
    const { orderId, email } = await received([{ id: 'a1', name: 'AGL bill.pdf', body: pdf('bill') }]);
    const attachment = email.attachments[0]!;
    await expect(fileEmailAttachment(as(w.alex, w.clock), { attachmentId: attachment.id, typeId: (await docType('electricity_bill')).id })).rejects.toMatchObject({ code: 'not_found' });
    // Contracts go through their own step, which also records which version was signed.
    await expect(fileEmailAttachment(sam(), { attachmentId: attachment.id, typeId: (await docType('signed_contract')).id })).rejects.toMatchObject({ code: 'validation' });

    const { documentId } = await fileEmailAttachment(sam(), { attachmentId: attachment.id, typeId: (await docType('electricity_bill')).id });
    expect(await db.document.findUniqueOrThrow({ where: { id: documentId }, include: { type: true } })).toMatchObject({ orderId, fileName: 'AGL bill.pdf', source: 'EMAIL', uploadedById: w.sam.id, type: { key: 'electricity_bill' }, note: 'From the customer’s e-mail “Signed and my bill”' });
    const again = (await getOrderMail(sam(), orderId)).emails[0]!.attachments[0]!;
    expect(again).toMatchObject({ documentId, documentLabel: 'Electricity bill' });
    // The same file a second time is a duplicate, as it would be if uploaded by hand.
    await expect(fileEmailAttachment(sam(), { attachmentId: attachment.id, typeId: (await docType('electricity_bill')).id })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('archives a signed contract that came back by e-mail', async () => {
    const { orderId, quoteId, email } = await received([{ id: 'a1', name: 'Signed contract.pdf', body: pdf('signed by Jane') }]);
    const attachment = email.attachments[0]!;
    await expect(archiveContractFromAttachment(sam(), { attachmentId: attachment.id, quoteId: null, signedOn: parseDateOnly('2026-11-09') })).rejects.toMatchObject({ fieldErrors: { quoteId: expect.any(String) } });
    const { contractId } = await archiveContractFromAttachment(sam(), { attachmentId: attachment.id, quoteId: quoteId!, signedOn: parseDateOnly('2026-11-09') });
    expect(await db.contract.findUniqueOrThrow({ where: { id: contractId } })).toMatchObject({ orderId, quoteId, source: 'EMAIL' });
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).stage).toBe('SIGNED');
    expect((await getOrderMail(sam(), orderId)).emails[0]!.attachments[0]!.documentLabel).toBe('Signed contract');
  });
});

describe('what is said to whom', () => {
  it('answers "not found" about an attachment of mail that is on no order to someone who may not see it', async () => {
    await orderAt(w, 'ASSIGNED');
    await orderAt(w, 'ASSIGNED', { address: '9 Other Rd', suburb: 'Ryde', postcode: '2112' });
    await connect();
    mail.add({ from: JANE, to: [who(SAM_MAIL)], subject: 'Which house?', attachments: [{ id: 'a1', name: 'bill.pdf', body: pdf('bill') }] });
    await run();
    const attachment = await db.emailAttachment.findFirstOrThrow();
    const typeId = (await docType('electricity_bill')).id;
    await expect(fileEmailAttachment(as(w.alex, w.clock), { attachmentId: attachment.id, typeId })).rejects.toMatchObject({ code: 'not_found' });
    await expect(fileEmailAttachment(as(w.fin, w.clock), { attachmentId: attachment.id, typeId })).rejects.toMatchObject({ code: 'not_found' });
    await expect(fileEmailAttachment(sam(), { attachmentId: attachment.id, typeId })).rejects.toMatchObject({ code: 'validation', message: 'Place the e-mail on an order first.' });
  });
});

describe('who may read the correspondence', () => {
  it('is for sales and managers, for operations once the order is theirs, and not for finance', async () => {
    const { orderId } = await orderAt(w, 'READY');
    await connect();
    mail.add({ from: JANE, to: [who(SAM_MAIL)], subject: 'When is the install?', html: '<p>Hello <b>Sam</b></p><script>alert(1)</script>' });
    await run();
    const email = (await getOrderMail(sam(), orderId)).emails[0]!;
    expect(email).toMatchObject({ subject: 'When is the install?', hasHtml: true, bodyText: 'Hello Sam' });
    expect((await getOrderMail(as(w.manager, w.clock), orderId)).emails).toHaveLength(1);
    await expect(getOrderMail(as(w.alex, w.clock), orderId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(getOrderMail(as(w.ops, w.clock), orderId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(getOrderMail(as(w.fin, w.clock), orderId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(openEmailHtml(as(w.fin, w.clock), email.id)).rejects.toMatchObject({ code: 'not_found' });

    await pushOrder(sam(), { orderId });
    const forOps = await getOrderMail(as(w.ops, w.clock), orderId);
    expect(forOps.emails).toHaveLength(1);
    expect(forOps.unplaced).toEqual([]);
    // The original markup is only handed out for sandboxed display.
    expect((await openEmailHtml(as(w.ops, w.clock), email.id)).html).toContain('<script>');
  });
});

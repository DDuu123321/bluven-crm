import { Readable } from 'node:stream';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createQuote, getConfig, openSecret, parseDateOnly, pushOrder, resetConfigCache, systemCtx, uploadDocument, type Ctx, type Mailbox } from '@bluven/core';
import { as, docType, makeUser, pdf, png, resetDb, stream, testDb } from '../../core/test/helpers';
import { makeWorld, orderAt, type World } from '../../core/test/setup-order';
import {
  MailApiError,
  ZohoMailClient,
  addSenderToCustomer,
  archiveContractFromAttachment,
  assignEmailToOrder,
  classifyFolders,
  connectMailbox,
  disconnectMailbox,
  exchangeZohoCode,
  fileEmailAttachment,
  getOrderMail,
  getOwnMailbox,
  listMailboxes,
  mailApiFor,
  openEmailAttachment,
  openEmailHtml,
  parseListItem,
  sendOrderEmail,
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
  reportSentId = true;

  private check(call: string) {
    this.calls.push(call);
    if (this.authFailed) throw new MailApiError('Zoho Mail answered 401 (INVALID_OAUTHTOKEN)', 401, false, true);
    if (this.down) throw new MailApiError('Zoho Mail answered 503', 503, true);
  }
  add(over: Partial<FakeMessage> & Pick<FakeMessage, 'from' | 'to'>): FakeMessage {
    n++;
    const m: FakeMessage = { id: `m${n}`, folderId: 'f_inbox', threadId: `t${n}`, subject: 'Your solar quote', cc: [], time: new Date(w.clock.current.getTime() - 60_000), html: '<p>Hello</p>', messageIdHeader: `msg-${n}@mail.example`, attachments: [], ...over };
    this.messages.push(m);
    return m;
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
    return this.messages
      .filter((m) => m.folderId === folderId)
      .sort((a, b) => b.time.getTime() - a.time.getTime())
      .slice(opts.start - 1, opts.start - 1 + opts.limit)
      .map((m) => ({ messageId: m.id, folderId: m.folderId, threadId: m.threadId, subject: m.subject, from: m.from, to: m.to, cc: m.cc, time: m.time, hasAttachment: m.attachments.length > 0, summary: '' }));
  }
  private find(id: string) {
    return this.messages.find((m) => m.id === id)!;
  }
  async getContent(_a: string, _f: string, id: string) {
    this.check(`content:${id}`);
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
    return { messageId: this.reportSentId ? `sent${this.sent.length}` : null };
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
      if (url.endsWith('/messages/view?folderId=f1&start=1&limit=50&sortBy=date&sortorder=false&includeto=true')) {
        return Response.json({
          status: { code: 200 },
          data: [
            { messageId: '171', folderId: 'f1', threadId: '170', subject: 'Re: Hello', summary: 'Hi', sender: 'Jane Smith', fromAddress: 'Jane@Example.com', toAddress: '&quot;Sam&quot;&lt;sam@bluven.example&gt;', ccAddress: 'Not Provided', receivedTime: '1794300000000', hasAttachment: '1' },
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
    expect(list).toEqual([{ messageId: '171', folderId: 'f1', threadId: '170', subject: 'Re: Hello', from: { address: 'jane@example.com', name: 'Jane Smith' }, to: [{ name: 'Sam', address: 'sam@bluven.example' }], cc: [], time: new Date(1794300000000), hasAttachment: true, summary: 'Hi' }]);
    // The first token was refused; the call was repeated once with a fresh one.
    expect(seen.map((s) => s.auth)).toEqual(['Zoho-oauthtoken token-1', 'Zoho-oauthtoken token-2']);
    refuseFirst = false;

    expect(await client.getHeaders('acc', 'f1', '171')).toEqual({ 'message-id': ['<abc@mail>'], 'in-reply-to': ['<prev@mail>'], received: ['a', 'b'] });
    expect(await client.uploadAttachment('acc', 'q u.pdf', Readable.from([Buffer.from('%PDF')]))).toEqual({ storeName: 's1', attachmentPath: '/compose/q.pdf', attachmentName: 'q.pdf' });
    expect(seen.at(-1)).toMatchObject({ url: 'https://mail.zoho.com.au/api/accounts/acc/messages/attachments?fileName=q%20u.pdf', method: 'POST' });

    const outgoing = { from: 'sam@bluven.example', to: ['jane@example.com', 'j2@example.com'], cc: ['p@example.com'], subject: 'Quote', html: '<p>Hi</p>', attachments: [{ storeName: 's1', attachmentPath: '/compose/q.pdf', attachmentName: 'q.pdf' }] };
    expect(await client.send('acc', outgoing)).toEqual({ messageId: '9001' });
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

    const revoked: string[] = [];
    await disconnectMailbox(sam(), {}, { fetchImpl: (async (url: string | URL | Request) => (revoked.push(String(url)), new Response(null, { status: 200 }))) as typeof fetch });
    expect(revoked).toEqual(['https://accounts.zoho.com.au/oauth/v2/token/revoke?token=refresh-1']);
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
    alexMail.add({ from: JANE, to: [who('alex@bluven.example')] });
    mail.authFailed = true;
    const apiFor = (account: { address: string }) => (account.address === SAM_MAIL ? mail : alexMail);

    expect(await syncAllMailboxes(ctx, apiFor)).toEqual({ mailboxes: 2, stored: 1, failed: 1 });
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

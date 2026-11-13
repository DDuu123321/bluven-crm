// A stand-in for Zoho's sign-in and mail services, for the end-to-end tests. It speaks the same
// HTTP as the real thing as far as the CRM uses it, keeps everything in memory, and has a few
// extra addresses (under /__test) through which a test plays the customer.
//
// Where Zoho's reference shows a peculiarity in its sample answers, this follows the sample:
// ids are nineteen digits that begin with the time, a conversation has no id until it has a
// second message and then carries the id of its first, "sentDateInGMT" is off by the mailbox's
// distance from UTC, and sending answers with the Message-ID of what was sent as "mailId".
import http from 'node:http';
import { E2E } from '../env';

interface Attachment {
  attachmentId: string;
  attachmentName: string;
  body: Buffer;
}
interface Message {
  messageId: string;
  folderId: string;
  /** The id of the first message of the conversation this one belongs to. */
  conversation: string;
  subject: string;
  fromAddress: string;
  sender: string;
  to: string[];
  cc: string[];
  time: number;
  html: string;
  messageIdHeader: string;
  inReplyTo: string | null;
  attachments: Attachment[];
}

const ACCOUNT = '9001';
const INBOX = '1001';
const SENT = '1002';
let seq = 100;
/** Ids as Zoho makes them: the time in milliseconds, then six more digits. */
const nextId = (): string => `${Date.now()}${String(++seq).padStart(6, '0')}`;
/** What Zoho's samples show for a mailbox in Sydney: the same moment, eleven hours off. */
const SYDNEY_OFFSET_MS = 11 * 3_600_000;
const revoked = new Set<string>();
const messages: Message[] = [];
const uploads = new Map<string, { name: string; body: Buffer }>();
const sent: { to: string[]; cc: string[]; subject: string; content: string; attachments: string[]; replyTo: string | null }[] = [];

const encode = (addresses: string[]): string => (addresses.length ? addresses.map((a) => `&lt;${a}&gt;`).join(',') : 'Not Provided');

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', E2E.zohoUrl);
  const path = url.pathname;
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const ok = (data: unknown) => send(200, { status: { code: 200, description: 'success' }, data });

  try {
    if (path === '/health') return send(200, { ok: true });

    // ---- sign-in
    if (path === '/oauth/v2/auth') {
      // The person "agrees" at once: straight back to the application with a code.
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('code', 'fake-code');
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      back.searchParams.set('location', 'au');
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (path === '/oauth/v2/token' && req.method === 'POST') {
      const form = new URLSearchParams((await readBody(req)).toString());
      if (form.get('client_id') !== E2E.zohoClientId || form.get('client_secret') !== E2E.zohoClientSecret) return send(200, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') return send(200, form.get('code') === 'fake-code' ? { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' } : { error: 'invalid_code' });
      return send(200, form.get('refresh_token') === 'rt-1' && !revoked.has('rt-1') ? { access_token: 'at-1', expires_in: 3600, token_type: 'Bearer' } : { error: 'invalid_code' });
    }
    // The documented form: the application's own credentials in the header, the token in the body.
    if (path === '/oauth/v2/revoke/token' && req.method === 'POST') {
      const expected = `Basic ${Buffer.from(`${E2E.zohoClientId}:${E2E.zohoClientSecret}`).toString('base64')}`;
      const token = new URLSearchParams((await readBody(req)).toString()).get('token');
      if (req.headers.authorization !== expected || !token) return send(400, { error: 'invalid_request' });
      revoked.add(token);
      return send(200, { status: 'success' });
    }
    // The older form, which the Mail API guide still shows.
    if (path === '/oauth/v2/token/revoke' && req.method === 'POST') {
      revoked.add(url.searchParams.get('token') ?? '');
      return send(200, { status: 'success' });
    }
    if (path === '/__test/revoked') return send(200, [...revoked]);

    // ---- what a test does as the customer
    if (path === '/__test/receive' && req.method === 'POST') {
      const input = JSON.parse((await readBody(req)).toString()) as { from: string; fromName?: string; subject: string; html: string; inReplyToSubject?: string; attachments?: { name: string; base64: string }[] };
      const answered = input.inReplyToSubject ? messages.find((m) => m.subject === input.inReplyToSubject) : undefined;
      const id = nextId();
      messages.push({
        messageId: id,
        folderId: INBOX,
        conversation: answered?.conversation ?? id,
        subject: input.subject,
        fromAddress: input.from,
        sender: input.fromName ?? input.from,
        to: [E2E.mailbox],
        cc: [],
        time: Date.now(),
        html: input.html,
        messageIdHeader: `customer-${id}@mail.example`,
        inReplyTo: answered?.messageIdHeader ?? null,
        attachments: (input.attachments ?? []).map((a, i) => ({ attachmentId: `${++seq}${i}`, attachmentName: a.name, body: Buffer.from(a.base64, 'base64') })),
      });
      return send(200, { messageId: id });
    }
    if (path === '/__test/sent') return send(200, sent);

    // ---- mail
    if (!path.startsWith('/api/')) return send(404, { error: 'not found' });
    if (req.headers.authorization !== 'Zoho-oauthtoken at-1') return send(401, { status: { code: 401 }, data: { errorCode: 'INVALID_OAUTHTOKEN' } });

    if (path === '/api/accounts') {
      return ok([{ accountId: ACCOUNT, primaryEmailAddress: E2E.mailbox, emailAddress: [{ mailId: E2E.mailbox, isPrimary: true, isAlias: false }], displayName: 'Sam Sales', type: 'ZOHO_ACCOUNT', enabled: true }]);
    }
    const base = `/api/accounts/${ACCOUNT}`;
    if (path === `${base}/folders`) {
      return ok([
        { folderId: INBOX, folderName: 'Inbox', folderType: 'Inbox', path: '/Inbox' },
        { folderId: SENT, folderName: 'Sent', folderType: 'Sent', path: '/Sent' },
        { folderId: '1003', folderName: 'Spam', folderType: 'Spam', path: '/Spam' },
      ]);
    }
    if (path === `${base}/messages/view`) {
      const start = Number(url.searchParams.get('start') ?? '1');
      const limit = Number(url.searchParams.get('limit') ?? '10');
      const list = messages
        .filter((m) => m.folderId === url.searchParams.get('folderId'))
        .sort((a, b) => b.time - a.time)
        .slice(start - 1, start - 1 + limit);
      return ok(
        list.map((m) => ({
          messageId: m.messageId,
          folderId: m.folderId,
          // No conversation id while the message is the only one of its conversation.
          ...(messages.filter((x) => x.conversation === m.conversation).length > 1 ? { threadId: m.conversation } : {}),
          subject: m.subject.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
          summary: '',
          sender: m.sender,
          fromAddress: m.fromAddress,
          toAddress: encode(m.to),
          ccAddress: encode(m.cc),
          receivedTime: String(m.time),
          sentDateInGMT: String(Math.floor(m.time / 1000) * 1000 - SYDNEY_OFFSET_MS),
          hasAttachment: m.attachments.length ? '1' : '0',
        })),
      );
    }
    if (path === `${base}/messages/attachments` && req.method === 'POST') {
      const name = url.searchParams.get('fileName') ?? 'file';
      const storeName = `store-${++seq}`;
      uploads.set(storeName, { name, body: await readBody(req) });
      return ok({ storeName, attachmentName: name, attachmentPath: `/compose/${name}` });
    }
    const reply = new RegExp(`^${base}/messages/(\\d+)$`).exec(path);
    if ((path === `${base}/messages` || reply) && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString()) as { fromAddress: string; toAddress: string; ccAddress?: string; subject: string; content: string; attachments?: { storeName: string }[]; action?: string };
      const original = reply ? messages.find((m) => m.messageId === reply[1]) : undefined;
      if (reply && (!original || body.action !== 'reply')) return send(404, { status: { code: 404 }, data: { errorCode: 'URL_RULE_NOT_CONFIGURED' } });
      const id = nextId();
      const files = (body.attachments ?? []).map((a) => uploads.get(a.storeName)).filter((u): u is { name: string; body: Buffer } => !!u);
      messages.push({
        messageId: id,
        folderId: SENT,
        conversation: original?.conversation ?? id,
        subject: body.subject,
        fromAddress: body.fromAddress,
        sender: 'Sam Sales',
        to: body.toAddress.split(','),
        cc: body.ccAddress ? body.ccAddress.split(',') : [],
        time: Date.now(),
        html: body.content,
        messageIdHeader: `crm-${id}@mail.example`,
        inReplyTo: original?.messageIdHeader ?? null,
        attachments: files.map((f, i) => ({ attachmentId: `${++seq}${i}`, attachmentName: f.name, body: f.body })),
      });
      sent.push({ to: body.toAddress.split(','), cc: body.ccAddress ? body.ccAddress.split(',') : [], subject: body.subject, content: body.content, attachments: files.map((f) => f.name), replyTo: original?.messageId ?? null });
      return ok({ messageId: id, mailId: `<crm-${id}@mail.example>`, subject: body.subject });
    }
    const one = new RegExp(`^${base}/folders/(\\d+)/messages/(\\d+)/(content|header|attachmentinfo|attachments/(\\d+))$`).exec(path);
    if (one) {
      const message = messages.find((m) => m.messageId === one[2] && m.folderId === one[1]);
      if (!message) return send(404, { status: { code: 404 }, data: { errorCode: 'EXTRA_KEY_FOUND_IN_JSON' } });
      if (one[3] === 'content') return ok({ messageId: message.messageId, content: message.html });
      if (one[3] === 'header') return ok({ headerContent: { 'Message-Id': [`<${message.messageIdHeader}>`], ...(message.inReplyTo ? { 'In-Reply-To': [`<${message.inReplyTo}>`], References: [`<${message.inReplyTo}>`] } : {}) } });
      if (one[3] === 'attachmentinfo') return ok({ attachments: message.attachments.map((a) => ({ attachmentId: a.attachmentId, attachmentName: a.attachmentName, attachmentSize: a.body.length })), messageId: message.messageId });
      const attachment = message.attachments.find((a) => a.attachmentId === one[4]);
      if (!attachment) return send(404, { status: { code: 404 } });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': attachment.body.length });
      return res.end(attachment.body);
    }
    return send(404, { status: { code: 404 }, data: { errorCode: 'URL_RULE_NOT_CONFIGURED' } });
  } catch (e) {
    return send(500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(E2E.zohoPort, '127.0.0.1', () => console.log(`stand-in for Zoho on ${E2E.zohoUrl}`));

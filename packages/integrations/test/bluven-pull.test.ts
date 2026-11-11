// The CRM pulling leads from the Bluven website. The stand-in server below answers exactly like
// the website's CMS does (cms/src/server.ts there): Bearer key, ?since=, "at or after", at most
// 200 of each kind per request, oldest first.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listUnassignedOrders, systemCtx, type Ctx } from '@bluven/core';
import { Clock, as, makeUser, resetDb, testDb, type TestUser } from '../../core/test/helpers';
import { getBluvenPullState, pullBluvenLeads, websiteItemToLead } from '../src';

const db = testDb();
const KEY = 'shared-key-for-tests';

interface WebsiteRow {
  kind: 'quote' | 'assessment';
  id: number;
  createdAt: string;
  firstName: string;
  phone: string;
  email?: string;
  components?: string[];
  referrer?: string;
  extra?: Record<string, unknown>;
}

class FakeWebsite {
  rows: WebsiteRow[] = [];
  key: string | null = KEY;
  requests: string[] = [];
  broken = false;
  private server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://website.test');
    this.requests.push(url.search);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (this.broken) return send(500, { error: 'sync query failed' });
    if (!this.key) return send(503, { error: 'CRM sync not configured' });
    if (req.headers.authorization !== `Bearer ${this.key}`) return send(401, { error: 'unauthorized' });
    const sinceRaw = url.searchParams.get('since') ?? '';
    const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? Date.parse(sinceRaw) : 0;
    const page = (kind: string) =>
      this.rows
        .filter((r) => r.kind === kind && Date.parse(r.createdAt) >= since)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, 200);
    const items = [
      ...page('quote').map((q) => ({
        kind: 'quote',
        externalId: `quote:${q.id}`,
        createdAt: q.createdAt,
        firstName: q.firstName,
        lastName: 'Test',
        email: q.email ?? '',
        phone: q.phone,
        address: '',
        suburb: '',
        state: '',
        postcode: '',
        source: q.referrer === 'ai-chat' ? 'AI_CHAT' : (q.referrer ?? '').startsWith('partner:') ? 'PARTNER' : 'WEBSITE_QUOTE',
        title: q.components?.length ? q.components.join(' + ') : 'Website quote',
        householdSize: '',
        goals: '',
        productPreference: '',
        ...q.extra,
      })),
      ...page('assessment').map((a) => ({
        kind: 'assessment',
        externalId: `assessment:${a.id}`,
        createdAt: a.createdAt,
        firstName: a.firstName,
        lastName: 'Test',
        email: a.email ?? '',
        phone: a.phone,
        address: '',
        suburb: '',
        state: '',
        postcode: '',
        source: 'WEBSITE_ASSESSMENT',
        title: 'Free assessment',
      })),
    ].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    send(200, { items, count: items.length });
  });
  url = '';
  start(): Promise<void> {
    return new Promise((resolve) =>
      this.server.listen(0, '127.0.0.1', () => {
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api/crm/leads`;
        resolve();
      }),
    );
  }
  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

let site: FakeWebsite;
let clock: Clock;
let ctx: Ctx;
let manager: TestUser;
let admin: TestUser;
const phone = (n: number) => `04${String(10_000_000 + n)}`;
const at = (minutes: number) => new Date(clock.current.getTime() + minutes * 60_000).toISOString();
const pull = (since?: string) => pullBluvenLeads(ctx, { url: site.url, key: KEY, since });

beforeEach(async () => {
  await resetDb();
  site = new FakeWebsite();
  await site.start();
  clock = new Clock();
  ctx = systemCtx(db, 'Bluven website', clock.now);
  manager = await makeUser(['MANAGER'], 'Morgan Manager');
  admin = await makeUser(['ADMIN'], 'Ada Admin');
});
afterEach(async () => {
  await site.stop();
});

describe('pulling leads from the website', () => {
  it('starts from now, takes each new lead once and puts it in the pool', async () => {
    site.rows.push({ kind: 'quote', id: 1, createdAt: at(-60 * 24 * 30), firstName: 'Old', phone: phone(1) });
    expect(await pull()).toEqual({ fetched: 0, created: 0, duplicates: 0, alreadyReceived: 0, failed: 0 });
    expect(await db.order.count()).toBe(0);

    clock.advanceMinutes(1);
    site.rows.push({ kind: 'quote', id: 2, createdAt: at(0), firstName: 'Nina', phone: phone(2), email: 'nina@example.com', components: ['Solar', 'Battery'] });
    expect(await pull()).toMatchObject({ fetched: 1, created: 1 });

    const order = await db.order.findFirstOrThrow({ include: { customer: true, source: true } });
    expect(order).toMatchObject({ externalLeadId: 'quote:2', sourceDetail: 'website/quote-form', isBackfill: false, ownerId: null });
    expect(order.source.key).toBe('bluven-website');
    expect(order.customer.firstName).toBe('Nina');
    expect(order.leadDetails).toEqual({ components: ['Solar', 'Battery'] });
    expect((await listUnassignedOrders(as(manager), {})).rows).toHaveLength(1);
    expect(await db.notification.count({ where: { type: 'pool.new_leads', userId: manager.id } })).toBe(1);

    // Asking again brings the same lead back (the website answers "at or after"); it is not taken twice.
    for (let i = 0; i < 3; i++) {
      clock.advanceMinutes(1);
      expect(await pull()).toEqual({ fetched: 0, created: 0, duplicates: 0, alreadyReceived: 0, failed: 0 });
    }
    expect(await db.order.count()).toBe(1);
    expect(await db.notification.count({ where: { type: 'pool.new_leads' } })).toBe(1);
    expect(await getBluvenPullState(db)).toMatchObject({ lastError: null, consecutiveFailures: 0, imported: 1, since: at(-3) });
  });

  it('labels where on the website a lead came from', async () => {
    await pull();
    clock.advanceMinutes(1);
    site.rows.push(
      { kind: 'quote', id: 1, createdAt: at(0), firstName: 'Chat', phone: phone(1), referrer: 'ai-chat' },
      { kind: 'quote', id: 2, createdAt: at(0), firstName: 'Partner', phone: phone(2), referrer: 'partner:Acme' },
      { kind: 'assessment', id: 1, createdAt: at(0), firstName: 'Quiz', phone: phone(3), email: 'quiz@example.com' },
    );
    expect(await pull()).toMatchObject({ created: 3 });
    const orders = await db.order.findMany({ orderBy: { externalLeadId: 'asc' } });
    expect(orders.map((o) => [o.externalLeadId, o.sourceDetail])).toEqual([
      ['assessment:1', 'website/assessment'],
      ['quote:1', 'website/ai-chat'],
      ['quote:2', 'website/partner'],
    ]);
  });

  it('takes over what was there before as history when given a start date', async () => {
    site.rows.push(
      { kind: 'quote', id: 1, createdAt: at(-60 * 24 * 400), firstName: 'Ancient', phone: phone(1) },
      { kind: 'quote', id: 2, createdAt: at(-60 * 24 * 20), firstName: 'Recent', phone: phone(2) },
      { kind: 'assessment', id: 7, createdAt: at(-60 * 24 * 3), firstName: 'Quiz', phone: phone(3), email: 'quiz@example.com' },
    );
    const since = at(-60 * 24 * 30);
    expect(await pull(since)).toMatchObject({ fetched: 2, created: 2 });
    const history = await db.order.findMany({ orderBy: { leadCreatedAt: 'asc' } });
    expect(history.map((o) => [o.externalLeadId, o.isBackfill])).toEqual([['quote:2', true], ['assessment:7', true]]);
    expect(history[0]!.leadCreatedAt.toISOString()).toBe(at(-60 * 24 * 20));
    // History is quiet: nothing in the pool, nobody notified.
    expect((await listUnassignedOrders(as(manager), {})).rows).toHaveLength(0);
    expect(await db.notification.count()).toBe(0);

    // From now on leads are live.
    clock.advanceMinutes(2);
    site.rows.push({ kind: 'quote', id: 3, createdAt: at(0), firstName: 'Fresh', phone: phone(4) });
    expect(await pull(since)).toMatchObject({ created: 1 });
    expect((await db.order.findFirstOrThrow({ where: { externalLeadId: 'quote:3' } })).isBackfill).toBe(false);
    expect(await db.notification.count({ where: { type: 'pool.new_leads' } })).toBe(1);
  });

  it('works through a backlog larger than one page without skipping anything', async () => {
    const start = at(-60 * 24 * 10);
    // 450 quotes a minute apart, and three assessments spread across the same days.
    for (let i = 0; i < 450; i++) site.rows.push({ kind: 'quote', id: i + 1, createdAt: at(-60 * 24 * 9 + i), firstName: `Q${i + 1}`, phone: phone(i + 1) });
    for (const [n, offset] of [[1, 10], [2, 250], [3, 440]] as const) site.rows.push({ kind: 'assessment', id: n, createdAt: at(-60 * 24 * 9 + offset), firstName: `A${n}`, phone: phone(9000 + n), email: `a${n}@example.com` });

    const result = await pull(start);
    expect(result).toMatchObject({ created: 453, failed: 0 });
    expect(await db.order.count()).toBe(453);
    expect(await db.leadReceipt.count()).toBe(453);
    expect(site.requests.length).toBeGreaterThanOrEqual(3);
    // Nothing more to do afterwards.
    clock.advanceMinutes(1);
    expect(await pull(start)).toMatchObject({ fetched: 0, created: 0 });
  }, 120_000);

  it('passes through enquiry details when the website sends them', async () => {
    await pull();
    clock.advanceMinutes(1);
    site.rows.push({
      kind: 'quote',
      id: 5,
      createdAt: at(0),
      firstName: 'Detail',
      phone: phone(5),
      extra: { components: ['Solar', 'EV'], propertyType: 'House', monthlyBill: 410, timeline: 'asap', bestTime: 'morning', notes: 'Two storey, tile roof.', address: '4 Kite St', suburb: 'Orange', state: 'NSW', postcode: '2800' },
    });
    expect(await pull()).toMatchObject({ created: 1 });
    const order = await db.order.findFirstOrThrow({ include: { property: true } });
    expect(order.leadDetails).toEqual({ components: ['Solar', 'EV'], monthlyBill: 410, timeline: 'asap', bestTime: 'morning', notes: 'Two storey, tile roof.' });
    expect(order.property).toMatchObject({ addressLine1: '4 Kite St', suburb: 'Orange', postcode: '2800', propertyType: 'House' });
  });

  it('reports a lead it cannot take over once, and carries on with the rest', async () => {
    await pull();
    clock.advanceMinutes(1);
    site.rows.push({ kind: 'quote', id: 1, createdAt: at(0), firstName: 'Bad', phone: '12' }, { kind: 'quote', id: 2, createdAt: at(0), firstName: 'Good', phone: phone(2) });
    expect(await pull()).toMatchObject({ created: 1, failed: 1 });
    const notes = await db.notification.findMany({ where: { type: 'intake.pull_rejected' } });
    expect(notes.map((n) => n.userId)).toEqual([manager.id]);
    expect(notes[0]!.body).toContain('quote:1: phone: Please enter a valid phone number.');
    expect(await db.auditLog.count({ where: { action: 'lead.pull_rejected' } })).toBe(1);
    // Not reported again on the following pulls.
    clock.advanceMinutes(1);
    await pull();
    clock.advanceMinutes(1);
    site.rows.push({ kind: 'quote', id: 3, createdAt: at(0), firstName: 'Later', phone: phone(3) });
    expect(await pull()).toMatchObject({ created: 1, failed: 0 });
    expect(await db.notification.count({ where: { type: 'intake.pull_rejected' } })).toBe(1);
  });

  it('says what is wrong when the connection fails, alerts the administrators once, and recovers', async () => {
    await pull();
    site.key = 'a-different-key';
    for (let i = 0; i < 7; i++) {
      clock.advanceMinutes(1);
      expect(await pull()).toEqual({ fetched: 0, created: 0, duplicates: 0, alreadyReceived: 0, failed: 0 });
    }
    let state = await getBluvenPullState(db);
    expect(state).toMatchObject({ consecutiveFailures: 7, alerted: true });
    expect(state!.lastError).toContain('CRM_SYNC_KEY');
    const alerts = await db.notification.findMany({ where: { type: 'intake.pull_failing' } });
    expect(alerts.map((n) => n.userId)).toEqual([admin.id]);

    site.key = null; // the website has no key configured
    clock.advanceMinutes(1);
    await pull();
    expect((await getBluvenPullState(db))!.lastError).toContain('not switched on');
    site.key = KEY;
    site.broken = true;
    clock.advanceMinutes(1);
    await pull();
    expect((await getBluvenPullState(db))!.lastError).toContain('status 500');

    // A lead submitted during the outage arrives as soon as the connection is back.
    site.broken = false;
    site.rows.push({ kind: 'quote', id: 9, createdAt: at(-4), firstName: 'Waited', phone: phone(9) });
    clock.advanceMinutes(1);
    expect(await pull()).toMatchObject({ created: 1 });
    state = await getBluvenPullState(db);
    expect(state).toMatchObject({ consecutiveFailures: 0, alerted: false, lastError: null });
    expect(await db.notification.count({ where: { type: 'intake.pull_failing' } })).toBe(1);
  });

  it('maps a website item to a lead', () => {
    expect(websiteItemToLead({ kind: 'quote', externalId: 'quote:1', source: 'WEBSITE_QUOTE', title: 'Solar + Heat pump', firstName: 'A' })).toEqual({
      externalId: 'quote:1',
      firstName: 'A',
      sourceDetail: 'website/quote-form',
      components: ['Solar', 'Heat pump'],
    });
    // A title that is not a list of products is not guessed at.
    expect(websiteItemToLead({ kind: 'quote', externalId: 'quote:2', source: 'WEBSITE_QUOTE', title: 'Website quote' })).toEqual({ externalId: 'quote:2', sourceDetail: 'website/quote-form' });
    expect(websiteItemToLead({ kind: 'assessment', externalId: 'assessment:3', title: 'Free assessment' })).toEqual({ externalId: 'assessment:3', sourceDetail: 'website/assessment' });
  });
});

import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { archiveContract, cancelOrder, markLost, parseDateOnly, pushOrder, systemCtx, unlinkPylonProject, type Ctx } from '@bluven/core';
import { as, makeUser, pdf, resetDb, staged, testDb } from '../../core/test/helpers';
import { makeWorld, orderAt, type World } from '../../core/test/setup-order';
import {
  PylonApiError,
  PylonClient,
  parseDesign,
  parseProject,
  processPylonEvents,
  reconcilePylonEvents,
  recordPylonEvent,
  retryPylonEvent,
  signPylonPayload,
  verifyPylonSignature,
  type PylonApi,
  type PylonDesign,
  type PylonProject,
} from '../src';

const db = testDb();
let w: World;
let ctx: Ctx;
let seq = 0;

/** A stand-in for Pylon that the tests can script. */
class FakePylon implements PylonApi {
  projects = new Map<string, PylonProject>();
  designs = new Map<string, PylonDesign>();
  files = new Map<string, Buffer>();
  down = false;
  calls: string[] = [];
  pages: { events: unknown[]; next: string | null }[] = [];

  private check(call: string) {
    this.calls.push(call);
    if (this.down) throw new PylonApiError('Pylon answered 503 for /v1', 503, true);
  }
  async getSolarProject(id: string) {
    this.check(`project:${id}`);
    const p = this.projects.get(id);
    if (!p) throw new PylonApiError('Pylon answered 404', 404, false);
    return p;
  }
  async findProjectByReference(reference: string) {
    this.check(`find:${reference}`);
    return [...this.projects.values()].find((p) => p.referenceNumber === reference) ?? null;
  }
  async getSolarDesign(id: string) {
    this.check(`design:${id}`);
    const d = this.designs.get(id);
    if (!d) throw new PylonApiError('Pylon answered 404', 404, false);
    return d;
  }
  async download(url: string) {
    this.check(`download:${url}`);
    const body = this.files.get(url);
    if (!body) throw new PylonApiError('Downloading the file from Pylon failed with status 403.', 403, false);
    return Readable.from([body]);
  }
  async listEvents(next?: string | null) {
    this.check(`events:${next ?? 'first'}`);
    return this.pages[next ? Number(next) : 0] ?? { events: [], next: null };
  }
}

function event(name: string, attributes: Record<string, unknown>, related: Record<string, string> = {}) {
  seq++;
  return {
    data: {
      type: 'events',
      id: `evt_${seq}`,
      attributes: { name, created_at: '2026-11-10T03:15:00Z', description: name, ...attributes },
      relationships: Object.fromEntries(Object.entries(related).map(([key, id]) => [key, { data: { type: `${key}s`, id } }])),
    },
  };
}

const project = (over: Partial<PylonProject> = {}): PylonProject => ({ id: 'prj_1', referenceNumber: null, isAccepted: false, manuallySold: false, hasEsignature: false, esignaturePdfUrl: null, latestSignedDesignId: null, primaryDesignId: null, ...over });
const design = (over: Partial<PylonDesign> = {}): PylonDesign => ({ id: 'des_1', projectId: 'prj_1', dcOutputKw: 6.6, storageKwh: 13.5, totalCents: 1_850_000, currency: 'AUD', depositCents: 185_000, webProposalUrl: 'https://app.getpylon.com/p/abc', pdfProposalUrl: 'https://files.getpylon.com/p/abc.pdf', ...over });
const order = (id: string) => db.order.findUniqueOrThrow({ where: { id } });
const stored = (pylonEventId: string) => db.pylonEvent.findUniqueOrThrow({ where: { pylonEventId } });
const cancelOrderAsSam = (orderId: string) => cancelOrder(as(w.sam, w.clock), { orderId, note: 'Customer changed their mind', refundStatus: 'NOT_REQUIRED' });

beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
  ctx = systemCtx(db, 'Pylon', w.clock.now);
  seq = 0;
});

describe('webhook signature', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ data: { id: 'evt_1' } });
  const now = new Date('2026-11-10T00:00:00Z');

  it('accepts what Pylon signs and nothing else', () => {
    const headers = signPylonPayload(secret, body, now);
    const input = { secret, rawBody: body, timestamp: headers['Pylon-Webhook-Timestamp']!, signature: headers['Pylon-Webhook-Signature']!, now };
    expect(headers['Pylon-Webhook-Signature']).toMatch(/^hs256=[0-9a-f]{64}$/);
    expect(verifyPylonSignature(input)).toEqual({ ok: true });
    expect(verifyPylonSignature({ ...input, rawBody: body + ' ' })).toEqual({ ok: false, reason: 'signature mismatch' });
    expect(verifyPylonSignature({ ...input, secret: 'other' })).toEqual({ ok: false, reason: 'signature mismatch' });
    expect(verifyPylonSignature({ ...input, signature: input.signature.replace('hs256=', '') })).toEqual({ ok: false, reason: 'signature mismatch' });
    expect(verifyPylonSignature({ ...input, signature: null })).toEqual({ ok: false, reason: 'missing signature headers' });
    expect(verifyPylonSignature({ ...input, secret: '' })).toEqual({ ok: false, reason: 'no secret configured' });
    expect(verifyPylonSignature({ ...input, timestamp: 'yesterday' })).toEqual({ ok: false, reason: 'malformed timestamp' });
  });

  it('matches a signature computed independently with openssl', () => {
    // printf '1700000000.{}' | openssl dgst -sha256 -hmac 's3cret'
    const signature = 'hs256=97926816e98fbb41ccb1673225ff29a2f35369099990e1b1561651e7bd097ebf';
    expect(verifyPylonSignature({ secret: 's3cret', timestamp: '1700000000', signature, rawBody: '{}', now: new Date(1700000000_000) })).toEqual({ ok: true });
  });

  it('tolerates the whole retry schedule but not stale deliveries', () => {
    const headers = signPylonPayload(secret, body, now);
    const base = { secret, rawBody: body, timestamp: headers['Pylon-Webhook-Timestamp']!, signature: headers['Pylon-Webhook-Signature']! };
    expect(verifyPylonSignature({ ...base, now: new Date(now.getTime() + 31 * 3_600_000) }).ok).toBe(true);
    expect(verifyPylonSignature({ ...base, now: new Date(now.getTime() + 37 * 3_600_000) })).toEqual({ ok: false, reason: 'timestamp outside the accepted window' });
  });
});

describe('storing events', () => {
  it('stores each event once', async () => {
    const e = event('solar_projects.created', { project_reference_number: 'X' }, { solar_project: 'prj_1' });
    expect(await recordPylonEvent(db, e)).toMatchObject({ name: 'solar_projects.created', duplicate: false });
    expect(await recordPylonEvent(db, e)).toMatchObject({ duplicate: true });
    // The events list returns bare event objects.
    expect(await recordPylonEvent(db, e.data)).toMatchObject({ duplicate: true });
    expect(await db.pylonEvent.count()).toBe(1);
    await expect(recordPylonEvent(db, { data: { id: 'x' } })).rejects.toMatchObject({ code: 'validation' });
    await expect(recordPylonEvent(db, 'nope')).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('processing events', () => {
  it('follows a web-proposal sale from design to deposit without anyone touching the CRM', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const orderNo = (await order(orderId)).orderNo;
    const pylon = new FakePylon();
    pylon.projects.set('prj_1', project({ referenceNumber: orderNo }));
    pylon.designs.set('des_1', design());

    // ---- project created from the "Design in Pylon" link: linked by our order number
    await recordPylonEvent(db, event('solar_projects.created', { project_reference_number: orderNo, project_in_app_url: 'https://app.getpylon.com/projects/prj_1' }, { solar_project: 'prj_1' }), w.clock.current);
    expect(await processPylonEvents(ctx, pylon)).toEqual({ processed: 1, ignored: 0, retrying: 0, failed: 0 });
    expect(await order(orderId)).toMatchObject({ pylonProjectId: 'prj_1', pylonProjectUrl: 'https://app.getpylon.com/projects/prj_1', stage: 'NEW' });

    // ---- design created: a quote version appears, the stage does not move
    await recordPylonEvent(db, event('solar_designs.created', { project_reference_number: orderNo }, { solar_project: 'prj_1', solar_design: 'des_1' }), w.clock.current);
    await processPylonEvents(ctx, pylon);
    let quotes = await db.quote.findMany({ where: { orderId } });
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ version: 1, pylonDesignId: 'des_1', dcWatts: 6600, storageWh: 13500, totalCents: 1_850_000, depositCents: 185_000, webProposalUrl: 'https://app.getpylon.com/p/abc', sentAt: null });
    expect((await order(orderId)).stage).toBe('NEW');

    // ---- design updated before it is sent: same version, new figures
    pylon.designs.set('des_1', design({ totalCents: 1_790_000, depositCents: 179_000 }));
    await recordPylonEvent(db, event('solar_designs.updated', {}, { solar_project: 'prj_1', solar_design: 'des_1' }), w.clock.current);
    await processPylonEvents(ctx, pylon);
    quotes = await db.quote.findMany({ where: { orderId } });
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.totalCents).toBe(1_790_000);

    // ---- the customer signs the web proposal
    const signedPdf = pdf('signed in pylon');
    pylon.files.set('https://files.getpylon.com/esign/1.pdf', signedPdf);
    pylon.projects.set('prj_1', project({ referenceNumber: orderNo, isAccepted: true, hasEsignature: true, esignaturePdfUrl: 'https://files.getpylon.com/esign/1.pdf', latestSignedDesignId: 'des_1' }));
    await recordPylonEvent(db, event('web_proposals.signed', { customer_name: 'Jane Smith', customer_email: 'jane@example.com' }, { solar_project: 'prj_1', solar_design: 'des_1' }), w.clock.current);
    expect(await processPylonEvents(ctx, pylon)).toMatchObject({ processed: 1 });
    const o = await order(orderId);
    expect(o.stage).toBe('SIGNED');
    expect(o.signedAt!.toISOString()).toBe('2026-11-10T00:00:00.000Z'); // 03:15 UTC is 10 Nov in Sydney
    const contract = await db.contract.findFirstOrThrow({ where: { orderId }, include: { document: true } });
    expect(contract).toMatchObject({ source: 'PYLON', quoteId: quotes[0]!.id, voidedAt: null });
    expect(contract.document).toMatchObject({ mimeType: 'application/pdf', sizeBytes: signedPdf.length, source: 'PYLON' });
    const quote = await db.quote.findUniqueOrThrow({ where: { id: quotes[0]!.id } });
    expect(quote).toMatchObject({ isAccepted: true, sentVia: 'PYLON' });
    expect(await db.notification.count({ where: { userId: w.sam.id, type: 'pylon.signed' } })).toBe(1);

    // ---- the customer pays the deposit through the gateway
    await recordPylonEvent(db, event('gateway_payments.created', { purpose: 'deposit', amount: 179_000, currency: 'aud', receipt_url: 'https://pay.example/r/9' }, { solar_project: 'prj_1', solar_design: 'des_1' }), w.clock.current);
    await processPylonEvents(ctx, pylon);
    expect((await order(orderId)).stage).toBe('DEPOSIT_PENDING');
    expect(await db.deposit.findFirstOrThrow({ where: { orderId } })).toMatchObject({ method: 'GATEWAY', amountCents: 179_000, currency: 'AUD', status: 'PENDING', receiptUrl: 'https://pay.example/r/9' });
    expect(await db.notification.count({ where: { userId: w.fin.id, type: 'deposit.submitted' } })).toBe(1);

    // Everything Pylon did is in the timeline, attributed to Pylon.
    const actors = await db.activity.findMany({ where: { orderId, actorLabel: 'Pylon' }, select: { summary: true }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
    expect(actors.map((a) => a.summary)).toEqual(
      expect.arrayContaining(['Quote v1: 6.6 kW, 13.5 kWh battery, $18,500.00 received from Pylon', 'Signed contract archived (signed 10 Nov 2026, quote v1)', 'Deposit of $1,790.00 paid through the Pylon payment gateway']),
    );
    // A redelivery of any of it changes nothing.
    const before = { contracts: await db.contract.count(), deposits: await db.deposit.count(), quotes: await db.quote.count() };
    await db.pylonEvent.updateMany({ data: { status: 'PENDING', nextAttemptAt: w.clock.current } });
    await processPylonEvents(ctx, pylon);
    expect({ contracts: await db.contract.count(), deposits: await db.deposit.count(), quotes: await db.quote.count() }).toEqual(before);
  });

  it('keeps the version the customer saw when the design changes afterwards', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const pylon = new FakePylon();
    pylon.projects.set('prj_1', project({ referenceNumber: (await order(orderId)).orderNo }));
    pylon.designs.set('des_1', design());
    await recordPylonEvent(db, event('solar_designs.created', {}, { solar_project: 'prj_1', solar_design: 'des_1' }), w.clock.current);
    await processPylonEvents(ctx, pylon);
    const v1 = await db.quote.findFirstOrThrow({ where: { orderId } });
    const { markQuoteSent } = await import('@bluven/core');
    await markQuoteSent(as(w.sam, w.clock), { quoteId: v1.id });

    pylon.designs.set('des_1', design({ totalCents: 1_700_000 }));
    await recordPylonEvent(db, event('solar_designs.updated', {}, { solar_project: 'prj_1', solar_design: 'des_1' }), w.clock.current);
    await processPylonEvents(ctx, pylon);
    const versions = await db.quote.findMany({ where: { orderId }, orderBy: { version: 'asc' } });
    expect(versions.map((q) => [q.version, q.totalCents, !!q.sentAt])).toEqual([[1, 1_850_000, true], [2, 1_700_000, false]]);
  });

  it('keeps the contract sales archived, and asks when the customer then signs another version in Pylon', async () => {
    const { orderId, quoteId } = await orderAt(w, 'QUOTED');
    await archiveContract(as(w.sam, w.clock), { orderId, quoteId: quoteId!, signedOn: parseDateOnly('2026-11-09'), files: [await staged(pdf('emailed back'), 'signed.pdf')] });
    const pylon = new FakePylon();
    pylon.projects.set('prj_1', project({ referenceNumber: (await order(orderId)).orderNo, isAccepted: true, esignaturePdfUrl: 'https://files.getpylon.com/esign/2.pdf' }));
    pylon.designs.set('des_1', design());
    pylon.files.set('https://files.getpylon.com/esign/2.pdf', pdf('pylon copy'));
    const e = event('web_proposals.signed', {}, { solar_project: 'prj_1', solar_design: 'des_1' });
    await recordPylonEvent(db, e, w.clock.current);
    await processPylonEvents(ctx, pylon);

    // The contract on file is untouched…
    expect(await db.contract.count({ where: { orderId } })).toBe(1);
    expect(await db.contract.findFirstOrThrow({ where: { orderId } })).toMatchObject({ source: 'UPLOAD', quoteId });
    // …the copy signed in Pylon is kept (its link dies within the hour), and sales is asked which one applies.
    expect(await db.document.findFirstOrThrow({ where: { orderId, type: { key: 'other' } } })).toMatchObject({ source: 'PYLON', note: expect.stringContaining('another version') });
    expect(await db.task.findFirstOrThrow({ where: { orderId, kind: 'PYLON_RESIGNED' } })).toMatchObject({ assigneeId: w.sam.id, status: 'OPEN' });
    expect(await db.notification.count({ where: { userId: w.sam.id, type: 'pylon.signed_other_version' } })).toBe(1);
    expect((await stored(e.data.id)).resultNote).toContain('different version');
  });

  it('does nothing when the customer signs in Pylon the very version already under contract', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const pylon = new FakePylon();
    pylon.projects.set('prj_1', project({ referenceNumber: (await order(orderId)).orderNo, isAccepted: true, esignaturePdfUrl: 'https://files.getpylon.com/esign/3.pdf' }));
    pylon.designs.set('des_1', design());
    pylon.files.set('https://files.getpylon.com/esign/3.pdf', pdf('signed once'));
    const sign = () => recordPylonEvent(db, event('web_proposals.signed', {}, { solar_project: 'prj_1', solar_design: 'des_1' }), w.clock.current);
    await sign();
    await processPylonEvents(ctx, pylon);
    expect((await order(orderId)).stage).toBe('SIGNED');
    // Pylon reports the signature a second time (a second signer, a re-send).
    await sign();
    await processPylonEvents(ctx, pylon);
    expect(await db.contract.count({ where: { orderId } })).toBe(1);
    expect(await db.task.count({ where: { orderId, kind: { in: ['PYLON_RESIGNED', 'PYLON_ACCEPTED'] } } })).toBe(0);
    expect(await db.document.count({ where: { orderId, type: { key: 'other' } } })).toBe(0);
  });

  it('asks sales to archive the contract when Pylon has no signed PDF', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const pylon = new FakePylon();
    pylon.projects.set('prj_1', project({ referenceNumber: (await order(orderId)).orderNo, isAccepted: true }));
    pylon.designs.set('des_1', design());
    await recordPylonEvent(db, event('web_proposals.signed', {}, { solar_project: 'prj_1', solar_design: 'des_1' }), w.clock.current);
    await processPylonEvents(ctx, pylon);
    expect((await order(orderId)).stage).toBe('QUOTED'); // seen by the customer, but no contract on file
    expect(await db.task.findFirstOrThrow({ where: { orderId, kind: 'PYLON_ACCEPTED' } })).toMatchObject({ assigneeId: w.sam.id, status: 'OPEN' });
  });

  it('records a gateway payment that arrives before the signature', async () => {
    const { orderId } = await orderAt(w, 'QUOTED');
    const orderNo = (await order(orderId)).orderNo;
    const pylon = new FakePylon();
    pylon.projects.set('prj_1', project({ referenceNumber: orderNo }));
    await recordPylonEvent(db, event('gateway_payments.created', { purpose: 'deposit', amount: 90_000, currency: 'aud' }, { solar_project: 'prj_1' }), w.clock.current);
    await processPylonEvents(ctx, pylon);
    expect((await order(orderId)).stage).toBe('QUOTED');
    expect(await db.deposit.count({ where: { orderId, status: 'PENDING' } })).toBe(1);
    expect((await order(orderId)).pylonProjectId).toBe('prj_1'); // linked by asking Pylon for the reference
  });

  it('ignores Pylon projects that do not belong to a CRM order', async () => {
    const pylon = new FakePylon();
    pylon.projects.set('prj_9', project({ id: 'prj_9', referenceNumber: 'something-else' }));
    const a = event('solar_projects.created', { project_reference_number: 'PYL-0003' }, { solar_project: 'prj_9' });
    const b = event('solar_designs.created', {}, { solar_project: 'prj_9', solar_design: 'des_9' });
    const c = event('opportunities.created', {});
    for (const e of [a, b, c]) await recordPylonEvent(db, e, w.clock.current);
    expect(await processPylonEvents(ctx, pylon)).toEqual({ processed: 0, ignored: 3, retrying: 0, failed: 0 });
    expect((await stored(a.data.id)).resultNote).toBe('No CRM order has the number “PYL-0003”.');
    expect((await stored(c.data.id)).resultNote).toBe('This kind of event needs no action in the CRM.');
    expect(await db.quote.count()).toBe(0);
  });

  it('leaves orders that are closed or with operations untouched', async () => {
    const { orderId } = await orderAt(w, 'READY');
    await pushOrder(as(w.sam, w.clock), { orderId });
    const pylon = new FakePylon();
    pylon.projects.set('prj_1', project({ referenceNumber: (await order(orderId)).orderNo }));
    pylon.designs.set('des_1', design({ totalCents: 5 }));
    const e = event('solar_designs.updated', {}, { solar_project: 'prj_1', solar_design: 'des_1' });
    await recordPylonEvent(db, e, w.clock.current);
    expect(await processPylonEvents(ctx, pylon)).toMatchObject({ ignored: 1 });
    expect((await stored(e.data.id)).resultNote).toContain('not open for changes');
    expect(await db.quote.count({ where: { orderId } })).toBe(1);
  });

  it('retries with a growing delay while Pylon is unreachable, then gives up', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const pylon = new FakePylon();
    pylon.projects.set('prj_1', project({ referenceNumber: (await order(orderId)).orderNo }));
    pylon.designs.set('des_1', design());
    const e = event('solar_designs.created', { project_reference_number: (await order(orderId)).orderNo }, { solar_project: 'prj_1', solar_design: 'des_1' });
    await recordPylonEvent(db, e, w.clock.current);

    pylon.down = true;
    expect(await processPylonEvents(ctx, pylon)).toEqual({ processed: 0, ignored: 0, retrying: 1, failed: 0 });
    let row = await stored(e.data.id);
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'Pylon answered 503 for /v1' });
    expect(row.nextAttemptAt.getTime() - w.clock.current.getTime()).toBe(60_000);
    // Not due yet.
    expect(await processPylonEvents(ctx, pylon)).toEqual({ processed: 0, ignored: 0, retrying: 0, failed: 0 });

    // Pylon comes back.
    w.clock.advanceMinutes(2);
    pylon.down = false;
    expect(await processPylonEvents(ctx, pylon)).toMatchObject({ processed: 1 });
    expect(await stored(e.data.id)).toMatchObject({ status: 'PROCESSED', attempts: 2, lastError: null, orderId });

    // An event that never succeeds is marked failed after six attempts.
    const f = event('solar_designs.updated', { project_reference_number: (await order(orderId)).orderNo }, { solar_project: 'prj_1', solar_design: 'des_1' });
    await recordPylonEvent(db, f, w.clock.current);
    pylon.down = true;
    for (let i = 0; i < 6; i++) {
      await processPylonEvents(ctx, pylon);
      w.clock.advanceDays(1);
    }
    row = await stored(f.data.id);
    expect(row).toMatchObject({ status: 'FAILED', attempts: 6 });

    // An admin can queue it again once the cause is fixed.
    const admin = { id: w.manager.id, name: 'Ada', email: 'ada@bluven.test', roles: ['ADMIN' as const] };
    await expect(retryPylonEvent(as(w.sam), row.id)).rejects.toMatchObject({ code: 'validation' });
    await retryPylonEvent(as(admin, w.clock), row.id);
    pylon.down = false;
    expect(await processPylonEvents(ctx, pylon)).toMatchObject({ processed: 1 });
  });

  it('waits for the API token instead of failing', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const e = event('solar_designs.created', { project_reference_number: (await order(orderId)).orderNo }, { solar_project: 'prj_1', solar_design: 'des_1' });
    await recordPylonEvent(db, e, w.clock.current);
    expect(await processPylonEvents(ctx, null)).toMatchObject({ retrying: 1 });
    expect((await stored(e.data.id)).lastError).toBe('The Pylon API token is not configured.');
  });

  it('nudges sales once when a project is marked as sold in Pylon without a contract', async () => {
    const { orderId } = await orderAt(w, 'QUOTED');
    const orderNo = (await order(orderId)).orderNo;
    const pylon = new FakePylon();
    pylon.projects.set('prj_1', project({ referenceNumber: orderNo, isAccepted: true, manuallySold: true }));
    for (let i = 0; i < 2; i++) await recordPylonEvent(db, event('solar_projects.updated', { project_reference_number: orderNo }, { solar_project: 'prj_1' }), w.clock.current);
    await processPylonEvents(ctx, pylon);
    expect(await db.task.count({ where: { orderId, kind: 'PYLON_ACCEPTED' } })).toBe(1);
    expect(await db.notification.count({ where: { userId: w.sam.id, type: 'pylon.accepted' } })).toBe(1);
  });
});

describe('events that cannot be applied', () => {
  it('puts a signature for a lost order on the timeline and tells sales and the managers', async () => {
    const { orderId } = await orderAt(w, 'QUOTED');
    const reason = await db.lostReason.findFirstOrThrow({ where: { key: 'price' } });
    await markLost(as(w.sam, w.clock), { orderId, reasonId: reason.id });
    const pylon = new FakePylon();
    pylon.projects.set('prj_1', project({ referenceNumber: (await order(orderId)).orderNo, isAccepted: true, esignaturePdfUrl: 'https://files.getpylon.com/esign/9.pdf' }));
    pylon.designs.set('des_1', design());
    pylon.files.set('https://files.getpylon.com/esign/9.pdf', pdf('late signature'));
    const e = event('web_proposals.signed', {}, { solar_project: 'prj_1', solar_design: 'des_1' });
    await recordPylonEvent(db, e, w.clock.current);
    expect(await processPylonEvents(ctx, pylon)).toMatchObject({ ignored: 1, failed: 0 });

    expect(await order(orderId)).toMatchObject({ sideState: 'LOST', stage: 'QUOTED' });
    expect(await db.contract.count({ where: { orderId } })).toBe(0);
    expect(await db.activity.count({ where: { orderId, summary: { contains: 'signed the proposal in Pylon' } } })).toBe(1);
    const told = await db.notification.findMany({ where: { type: 'pylon.signed_not_applied' } });
    expect(told.map((n) => n.userId).sort()).toEqual([w.sam.id, w.manager.id].sort());
    expect(told[0]!.title).toContain('marked as lost');
    expect((await stored(e.data.id)).resultNote).toContain('not applied');
  });

  it('never loses sight of money that arrives for a closed order', async () => {
    const { orderId } = await orderAt(w, 'DEPOSIT_PENDING');
    await cancelOrderAsSam(orderId);
    const pylon = new FakePylon();
    pylon.projects.set('prj_1', project({ referenceNumber: (await order(orderId)).orderNo }));
    const e = event('gateway_payments.created', { purpose: 'deposit', amount: 185_000, currency: 'AUD' }, { solar_project: 'prj_1' });
    await recordPylonEvent(db, e, w.clock.current);
    expect(await processPylonEvents(ctx, pylon)).toMatchObject({ ignored: 1 });

    expect(await db.deposit.count({ where: { orderId, method: 'GATEWAY' } })).toBe(0);
    expect(await db.activity.count({ where: { orderId, type: 'DEPOSIT', summary: { contains: '$1,850.00' } } })).toBe(1);
    const told = await db.notification.findMany({ where: { type: 'pylon.payment_not_applied' } });
    expect(told.map((n) => n.userId).sort()).toEqual([w.sam.id, w.manager.id, w.fin.id].sort());
  });

  it('notes a payment that is not a deposit without creating one', async () => {
    const { orderId } = await orderAt(w, 'QUOTED');
    const pylon = new FakePylon();
    pylon.projects.set('prj_1', project({ referenceNumber: (await order(orderId)).orderNo }));
    const e = event('gateway_payments.created', { purpose: 'balance', amount: 1_665_000, currency: 'AUD' }, { solar_project: 'prj_1' });
    await recordPylonEvent(db, e, w.clock.current);
    expect(await processPylonEvents(ctx, pylon)).toMatchObject({ processed: 1 });
    expect(await db.deposit.count({ where: { orderId } })).toBe(0);
    expect(await db.activity.count({ where: { orderId, summary: 'Pylon gateway payment of $16,650.00 (balance) received' } })).toBe(1);
  });

  it('tells the administrators when an event is given up on', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const admin = await makeUser(['ADMIN'], 'Ada Admin');
    const pylon = new FakePylon();
    pylon.projects.set('prj_1', project({ referenceNumber: (await order(orderId)).orderNo }));
    // The design the event points at does not exist in Pylon: a 404 is not worth retrying.
    const e = event('solar_designs.created', {}, { solar_project: 'prj_1', solar_design: 'des_missing' });
    await recordPylonEvent(db, e, w.clock.current);
    expect(await processPylonEvents(ctx, pylon)).toMatchObject({ failed: 1 });
    const alert = await db.notification.findFirstOrThrow({ where: { type: 'pylon.event_failed' } });
    expect(alert).toMatchObject({ userId: admin.id, href: '/settings/pylon' });
    expect(alert.title).toContain('solar_designs.created');
  });
});

describe('which project belongs to which order', () => {
  it('does not hand an order to a second Pylon project that turns up with its number', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const orderNo = (await order(orderId)).orderNo;
    const pylon = new FakePylon();
    pylon.projects.set('prj_1', project({ referenceNumber: orderNo }));
    pylon.projects.set('prj_2', project({ id: 'prj_2', referenceNumber: orderNo }));
    pylon.designs.set('des_1', design());
    pylon.designs.set('des_2', design({ id: 'des_2', projectId: 'prj_2', totalCents: 1 }));

    await recordPylonEvent(db, event('solar_projects.created', { project_reference_number: orderNo }, { solar_project: 'prj_1' }), w.clock.current);
    await processPylonEvents(ctx, pylon);
    expect((await order(orderId)).pylonProjectId).toBe('prj_1');
    // The link shows on the timeline, so the salesperson notices a project they did not start.
    expect(await db.activity.count({ where: { orderId, summary: 'Linked to a project in Pylon' } })).toBe(1);

    // Somebody opens Pylon with this order's number on another project and designs, pays and signs there.
    const foreign = [
      event('solar_projects.created', { project_reference_number: orderNo }, { solar_project: 'prj_2' }),
      event('solar_designs.created', { project_reference_number: orderNo.toLowerCase() }, { solar_project: 'prj_2', solar_design: 'des_2' }),
      event('gateway_payments.created', { purpose: 'deposit', amount: 5_000 }, { solar_project: 'prj_2' }),
    ];
    for (const e of foreign) await recordPylonEvent(db, e, w.clock.current);
    expect(await processPylonEvents(ctx, pylon)).toEqual({ processed: 0, ignored: 3, retrying: 0, failed: 0 });
    expect(await order(orderId)).toMatchObject({ pylonProjectId: 'prj_1', stage: 'NEW' });
    expect(await db.quote.count({ where: { orderId } })).toBe(0);
    expect(await db.deposit.count({ where: { orderId } })).toBe(0);
    expect((await stored(foreign[0]!.data.id)).resultNote).toContain('linked to project prj_1');
    // The managers hear about it once, not once per event.
    expect((await db.notification.findMany({ where: { type: 'pylon.conflict' } })).map((n) => n.userId)).toEqual([w.manager.id]);

    // The project it is linked to keeps working.
    await recordPylonEvent(db, event('solar_designs.created', {}, { solar_project: 'prj_1', solar_design: 'des_1' }), w.clock.current);
    expect(await processPylonEvents(ctx, pylon)).toMatchObject({ processed: 1 });
    expect((await db.quote.findFirstOrThrow({ where: { orderId } })).totalCents).toBe(1_850_000);
  });

  it('lets a new project take over when the old one is gone from Pylon, or when a manager unlinks it', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const orderNo = (await order(orderId)).orderNo;
    const pylon = new FakePylon();
    pylon.projects.set('prj_1', project({ referenceNumber: orderNo }));
    await recordPylonEvent(db, event('solar_projects.created', { project_reference_number: orderNo }, { solar_project: 'prj_1' }), w.clock.current);
    await processPylonEvents(ctx, pylon);

    // Deleted in Pylon and made again.
    pylon.projects.delete('prj_1');
    pylon.projects.set('prj_2', project({ id: 'prj_2', referenceNumber: orderNo }));
    await recordPylonEvent(db, event('solar_projects.created', { project_reference_number: orderNo }, { solar_project: 'prj_2' }), w.clock.current);
    expect(await processPylonEvents(ctx, pylon)).toMatchObject({ processed: 1 });
    expect((await order(orderId)).pylonProjectId).toBe('prj_2');
    expect(await db.notification.count({ where: { type: 'pylon.conflict' } })).toBe(0);

    // Replaced while the old one still exists: a manager decides.
    pylon.projects.set('prj_3', project({ id: 'prj_3', referenceNumber: orderNo }));
    const claim = event('solar_projects.updated', { project_reference_number: orderNo }, { solar_project: 'prj_3' });
    await recordPylonEvent(db, claim, w.clock.current);
    expect(await processPylonEvents(ctx, pylon)).toMatchObject({ ignored: 1 });
    await expect(unlinkPylonProject(as(w.sam, w.clock), { orderId })).rejects.toMatchObject({ code: 'forbidden' });
    await unlinkPylonProject(as(w.manager, w.clock), { orderId });
    expect((await order(orderId)).pylonProjectId).toBeNull();
    await retryPylonEvent(as(await makeUser(['ADMIN']), w.clock), (await stored(claim.data.id)).id);
    expect(await processPylonEvents(ctx, pylon)).toMatchObject({ processed: 1 });
    expect((await order(orderId)).pylonProjectId).toBe('prj_3');
  });

  it('catches up on events that arrived before the project could be matched to an order', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const orderNo = (await order(orderId)).orderNo;
    const pylon = new FakePylon();
    // The reference was mistyped in Pylon at first.
    pylon.projects.set('prj_1', project({ referenceNumber: 'BLV-TYPO' }));
    pylon.designs.set('des_1', design());
    const early = event('solar_designs.created', {}, { solar_project: 'prj_1', solar_design: 'des_1' });
    await recordPylonEvent(db, early, w.clock.current);
    expect(await processPylonEvents(ctx, pylon)).toMatchObject({ ignored: 1 });
    expect(await db.quote.count({ where: { orderId } })).toBe(0);

    // Corrected in Pylon: the project links, and the design that came earlier is applied after all.
    pylon.projects.set('prj_1', project({ referenceNumber: orderNo }));
    await recordPylonEvent(db, event('solar_projects.updated', { project_reference_number: orderNo }, { solar_project: 'prj_1' }), w.clock.current);
    expect(await processPylonEvents(ctx, pylon)).toMatchObject({ processed: 1 });
    expect(await processPylonEvents(ctx, pylon)).toMatchObject({ processed: 1 });
    expect(await db.quote.count({ where: { orderId } })).toBe(1);
    expect((await stored(early.data.id)).status).toBe('PROCESSED');
  });

  it('does not nudge sales about a project accepted by web signature', async () => {
    const { orderId } = await orderAt(w, 'QUOTED');
    const orderNo = (await order(orderId)).orderNo;
    const pylon = new FakePylon();
    // Accepted, but by e-signature: the signed proposal arrives as its own event with the PDF.
    pylon.projects.set('prj_1', project({ referenceNumber: orderNo, isAccepted: true, manuallySold: false, hasEsignature: true }));
    await recordPylonEvent(db, event('solar_projects.updated', { project_reference_number: orderNo }, { solar_project: 'prj_1' }), w.clock.current);
    await processPylonEvents(ctx, pylon);
    expect(await db.task.count({ where: { orderId, kind: 'PYLON_ACCEPTED' } })).toBe(0);
  });
});

describe('reconciliation', () => {
  it('stores events whose webhook never arrived and stops at known ground', async () => {
    const pylon = new FakePylon();
    const [a, b, c, d] = [event('solar_projects.created', {}), event('solar_projects.updated', {}), event('opportunities.created', {}), event('solar_projects.deleted', {})];
    await recordPylonEvent(db, c, w.clock.current); // already delivered by webhook
    await recordPylonEvent(db, d, w.clock.current);
    pylon.pages = [
      { events: [a.data, b.data, { nonsense: true }], next: '1' },
      { events: [c.data, d.data], next: '2' },
      { events: [event('never.read', {}).data], next: null },
    ];
    expect(await reconcilePylonEvents(ctx, pylon)).toEqual({ added: 2, pages: 2 });
    expect(await db.pylonEvent.count()).toBe(4);
  });
});

describe('API client', () => {
  it('reads projects and designs from JSON:API documents', () => {
    expect(
      parseProject({
        type: 'solar_projects',
        id: 'rukSigcyTR',
        attributes: { reference_number: 'BLV-2026-00001', acceptance: { is_accepted: true, manually_sold: false, latest_esignature: true, latest_esignature_pdf_url: 'https://x/y.pdf' } },
        relationships: { primary_design: { data: null }, latest_signed_design: { data: { type: 'solar_designs', id: 'des_7' } }, designs: { data: [] } },
      }),
    ).toEqual({ id: 'rukSigcyTR', referenceNumber: 'BLV-2026-00001', isAccepted: true, manuallySold: false, hasEsignature: true, esignaturePdfUrl: 'https://x/y.pdf', latestSignedDesignId: 'des_7', primaryDesignId: null });
    expect(
      parseDesign({
        type: 'solar_designs',
        id: 'des_7',
        attributes: {
          summary: { dc_output_kw: 6.49, storage_kwh: 13.5, web_proposal_url: 'https://w', pdf_proposal_url: 'https://p' },
          pricing: { total: 760000, total_includes_tax: true, currency: 'aud' },
          proposal_quote: { deposit_amount_formatted: '$1,760.00', currency: 'aud' },
        },
        relationships: { project: { data: { type: 'solar_projects', id: 'rukSigcyTR' } } },
      }),
    ).toEqual({ id: 'des_7', projectId: 'rukSigcyTR', dcOutputKw: 6.49, storageKwh: 13.5, totalCents: 760000, currency: 'AUD', depositCents: 176000, webProposalUrl: 'https://w', pdfProposalUrl: 'https://p' });
    // Missing pieces are null, not exceptions.
    expect(parseDesign({ id: 'd', attributes: {} })).toMatchObject({ dcOutputKw: null, totalCents: null, depositCents: null, projectId: null });
    expect(() => parseProject({ attributes: {} })).toThrow(PylonApiError);
  });

  it('follows a download link to its storage host, but not into our own network', async () => {
    const visited: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      visited.push(String(url));
      expect(init?.redirect).toBe('manual');
      if (String(url) === 'https://app.getpylon.com/files/1') return new Response(null, { status: 302, headers: { location: 'https://storage.example/bucket/1.pdf?sig=abc' } });
      if (String(url) === 'https://app.getpylon.com/files/2') return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } });
      if (String(url) === 'https://app.getpylon.com/files/loop') return new Response(null, { status: 302, headers: { location: '/files/loop' } });
      return new Response('%PDF-1.4 signed', { status: 200 });
    }) as typeof fetch;
    const client = new PylonClient({ apiBase: 'https://api.getpylon.com', apiToken: 'tok', fetchImpl, resolve: async () => ['203.0.113.10'] });

    const chunks: Buffer[] = [];
    for await (const chunk of await client.download('https://app.getpylon.com/files/1')) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('%PDF-1.4 signed');
    expect(visited).toEqual(['https://app.getpylon.com/files/1', 'https://storage.example/bucket/1.pdf?sig=abc']);

    visited.length = 0;
    await expect(client.download('https://app.getpylon.com/files/2')).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('not a public address') });
    expect(visited).toEqual(['https://app.getpylon.com/files/2']); // the redirect target was never fetched
    await expect(client.download('https://app.getpylon.com/files/loop')).rejects.toMatchObject({ retryable: false, message: expect.stringContaining('too many times') });
  });

  it('sends the token only to the configured host and classifies failures', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    let status = 200;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      if (status !== 200) return new Response('nope', { status });
      return Response.json({ data: { id: 'prj_1', attributes: { reference_number: 'R' } }, links: { next: 'https://evil.example/v1/events?page=2' } });
    }) as typeof fetch;
    // Host names of download links resolve to a public address unless the test says otherwise.
    const resolve = async (host: string) => (host === 'inside.example' ? ['10.0.0.5'] : ['203.0.113.10']);
    const client = new PylonClient({ apiBase: 'https://api.getpylon.com/', apiToken: 'tok', fetchImpl, resolve });

    expect((await client.getSolarProject('a b')).referenceNumber).toBe('R');
    expect(seen[0]).toEqual({ url: 'https://api.getpylon.com/v1/solar_projects/a%20b', auth: 'Bearer tok' });
    await client.getSolarDesign('d1');
    expect(seen[1]!.url).toBe('https://api.getpylon.com/v1/solar_designs/d1?fields[solar_designs]=summary,pricing,proposal_quote');

    // A "next" link pointing somewhere else never receives the token.
    const page = await client.listEvents();
    await expect(client.listEvents(page.next)).rejects.toMatchObject({ retryable: false });
    expect(seen.every((s) => s.url.startsWith('https://api.getpylon.com/'))).toBe(true);

    // Downloads use the pre-signed link without credentials, and only over HTTPS.
    await client.download('https://files.example/signed.pdf');
    expect(seen.at(-1)).toEqual({ url: 'https://files.example/signed.pdf', auth: null });
    await expect(client.download('http://files.example/signed.pdf')).rejects.toMatchObject({ retryable: false });

    // A link into our own network is refused before anything is fetched, whichever way it is written.
    const before = seen.length;
    for (const inside of ['https://127.0.0.1/admin', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/x', 'https://10.1.2.3/x', 'https://inside.example/secret.pdf', 'https://user:pw@files.example/x.pdf']) {
      await expect(client.download(inside), inside).rejects.toMatchObject({ retryable: false });
    }
    expect(seen.length).toBe(before);

    status = 503;
    await expect(client.getSolarProject('x')).rejects.toMatchObject({ status: 503, retryable: true });
    status = 404;
    await expect(client.getSolarProject('x')).rejects.toMatchObject({ status: 404, retryable: false });
    status = 401;
    await expect(client.getSolarProject('x')).rejects.toMatchObject({ status: 401, retryable: true });
    await expect(new PylonClient({ apiBase: 'https://api.getpylon.com', apiToken: '', fetchImpl }).getSolarProject('x')).rejects.toMatchObject({ message: 'The Pylon API token is not configured.', retryable: true });
  });
});

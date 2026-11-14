import { beforeEach, describe, expect, it } from 'vitest';
import { acceptQuote, attachQuoteFile, createQuote, getHandoffChecklist, markQuoteSent } from '../src';
import { as, pdf, resetDb, staged, testDb } from './helpers';
import { makeWorld, orderAt, type World } from './setup-order';

const db = testDb();
let w: World;

beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});

describe('the file of a quote version that has not been sent', () => {
  it('can be attached and replaced without marking the version as sent', async () => {
    const { orderId } = await orderAt(w, 'OPENED');
    const sam = as(w.sam, w.clock);
    // As a version from Pylon arrives: the figures, no file.
    const quote = await createQuote(sam, { orderId, title: '6.6 kW', dcWatts: 6600, storageWh: null, totalCents: 900_000, depositCents: 90_000, notes: '' });
    expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).documentId).toBeNull();

    await attachQuoteFile(sam, { quoteId: quote.id, file: await staged(pdf('quote pages'), 'Quote v1.pdf') });
    const first = await db.quote.findUniqueOrThrow({ where: { id: quote.id }, include: { document: { include: { type: true } } } });
    expect(first).toMatchObject({ sentAt: null, document: { fileName: 'Quote v1.pdf', note: 'Quote v1', type: { key: 'quote' } } });
    // The design has started. Nothing has gone to the customer.
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).stage).toBe('DESIGN');

    // A corrected file takes the place of the first, which stays on record as the earlier version.
    await attachQuoteFile(sam, { quoteId: quote.id, file: await staged(pdf('quote pages, corrected'), 'Quote v1 corrected.pdf') });
    const second = await db.quote.findUniqueOrThrow({ where: { id: quote.id }, include: { document: true } });
    expect(second.document).toMatchObject({ fileName: 'Quote v1 corrected.pdf', replacesId: first.documentId });
    expect(await db.auditLog.findMany({ where: { action: 'quote.update', entityId: quote.id }, orderBy: { at: 'asc' }, select: { summary: true } })).toMatchObject([
      { summary: expect.stringContaining('attached the file of quote v1') },
      { summary: expect.stringContaining('replaced the file of quote v1') },
    ]);

    // Only the people on the order, and only while the version is still theirs to change.
    await expect(attachQuoteFile(as(w.alex, w.clock), { quoteId: quote.id, file: await staged(pdf('from Alex'), 'x.pdf') })).rejects.toMatchObject({ code: 'not_found' });
    await markQuoteSent(sam, { quoteId: quote.id });
    await expect(attachQuoteFile(sam, { quoteId: quote.id, file: await staged(pdf('too late'), 'late.pdf') })).rejects.toMatchObject({ code: 'conflict' });
    expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).documentId).toBe(second.documentId);
  });

  it('can still be added to a version that went to the customer without one, once', async () => {
    const { orderId } = await orderAt(w, 'OPENED');
    const sam = as(w.sam, w.clock);
    const quote = await createQuote(sam, { orderId, title: '6.6 kW', dcWatts: 6600, storageWh: null, totalCents: 900_000, depositCents: 90_000, notes: '' });
    // Sent as a link, or by a mail program outside the CRM: the version is on record, its file is not.
    await markQuoteSent(sam, { quoteId: quote.id });
    await acceptQuote(sam, { quoteId: quote.id });
    const checklist = async () => (await getHandoffChecklist(db, orderId)).items.find((i) => i.key === 'quote');
    expect(await checklist()).toMatchObject({ ok: false, detail: expect.stringContaining('has no file yet') });

    // Operations need the proposal with the order, so the gap can be filled.
    await attachQuoteFile(sam, { quoteId: quote.id, file: await staged(pdf('what the customer got'), 'Proposal.pdf') });
    const filed = await db.quote.findUniqueOrThrow({ where: { id: quote.id }, include: { document: true } });
    expect(filed.document).toMatchObject({ fileName: 'Proposal.pdf', note: 'Quote v1 as sent', replacesId: null });
    expect(await checklist()).toMatchObject({ ok: true });

    // From then on the file is the record of what the customer saw.
    await expect(attachQuoteFile(sam, { quoteId: quote.id, file: await staged(pdf('a different one'), 'Other.pdf') })).rejects.toMatchObject({ code: 'conflict' });
    expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).documentId).toBe(filed.documentId);
  });
});

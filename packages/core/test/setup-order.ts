import { archiveContract, assignOrders, createQuote, decideDeposit, ingestLeads, markQuoteSent, parseDateOnly, submitDeposit, systemCtx, uploadDocument } from '../src';
import { Clock, as, docType, lead, makeUser, pdf, png, source, staged, stream, testDb, type TestUser } from './helpers';

export interface World {
  clock: Clock;
  manager: TestUser;
  sam: TestUser;
  alex: TestUser;
  fin: TestUser;
  ops: TestUser;
}

export async function makeWorld(): Promise<World> {
  return {
    clock: new Clock(),
    manager: await makeUser(['MANAGER'], 'Morgan Manager'),
    sam: await makeUser(['SALES'], 'Sam Sales'),
    alex: await makeUser(['SALES'], 'Alex Sales'),
    fin: await makeUser(['FINANCE'], 'Fay Finance'),
    ops: await makeUser(['OPS'], 'Olly Ops'),
  };
}

export type Upto = 'NEW' | 'ASSIGNED' | 'QUOTED' | 'SIGNED' | 'DEPOSIT_PENDING' | 'DEPOSIT_CONFIRMED' | 'READY';

/** Creates an order owned by Sam and advances it to the requested point. */
export async function orderAt(w: World, upto: Upto, over: Record<string, unknown> = {}): Promise<{ orderId: string; quoteId?: string; depositId?: string }> {
  const db = testDb();
  const res = await ingestLeads(systemCtx(db, 'Bluven website', w.clock.now), [lead(over)], { sourceId: (await source('bluven-website')).id, requireExternalId: true });
  const orderId = res.results[0]!.id!;
  if (upto === 'NEW') return { orderId };
  await assignOrders(as(w.manager, w.clock), { orderIds: [orderId], ownerId: w.sam.id });
  if (upto === 'ASSIGNED') return { orderId };
  const sam = as(w.sam, w.clock);
  const quote = await createQuote(sam, { orderId, title: '6.6 kW', dcWatts: 6600, storageWh: null, totalCents: 900_000, depositCents: 90_000, notes: '' });
  await markQuoteSent(sam, { quoteId: quote.id });
  if (upto === 'QUOTED') return { orderId, quoteId: quote.id };
  await archiveContract(sam, { orderId, quoteId: quote.id, signedOn: parseDateOnly('2026-11-09'), files: [await staged(pdf(`contract ${orderId}`), 'signed.pdf')] });
  if (upto === 'SIGNED') return { orderId, quoteId: quote.id };
  const deposit = await submitDeposit(sam, { orderId, amountCents: 90_000, method: 'BANK_TRANSFER', files: [await staged(pdf(`proof ${orderId}`), 'transfer.pdf')] });
  if (upto === 'DEPOSIT_PENDING') return { orderId, quoteId: quote.id, depositId: deposit.id };
  await decideDeposit(as(w.fin, w.clock), { depositId: deposit.id, decision: 'CONFIRM', receivedAmountCents: 90_000, receivedOn: parseDateOnly('2026-11-10') });
  if (upto === 'DEPOSIT_CONFIRMED') return { orderId, quoteId: quote.id, depositId: deposit.id };
  let n = 0;
  for (const key of ['electricity_bill', 'install_location', 'meter_box']) {
    n++;
    await uploadDocument(sam, { orderId, typeId: (await docType(key)).id, fileName: `${key}.png`, body: stream(await png(n * 17 + orderId.length)) });
  }
  return { orderId, quoteId: quote.id, depositId: deposit.id };
}

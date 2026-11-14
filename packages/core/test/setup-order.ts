import { acceptHandoff, assignOrders, createQuote, ingestLeads, markJobDone, markQuoteSent, openJob, pushOrder, submitDeposit, systemCtx, uploadDocument } from '../src';
import { Clock, as, docType, lead, leadOrigin, makeUser, pdf, png, source, staged, stream, testDb, type TestUser } from './helpers';

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

/**
 * How far an order is taken: in the pool, assigned to Sam, opened by him, with a proposal sent,
 * with the deposit on record, with its folder complete, pushed, accepted by operations, installed.
 */
export type Upto = 'NEW' | 'ASSIGNED' | 'OPENED' | 'QUOTED' | 'DEPOSIT_PAID' | 'READY' | 'PUSHED' | 'ACCEPTED' | 'INSTALLED';

/** Creates an order owned by Sam and advances it to the requested point. */
export async function orderAt(w: World, upto: Upto, over: Record<string, unknown> = {}): Promise<{ orderId: string; quoteId?: string; depositId?: string }> {
  const db = testDb();
  const res = await ingestLeads(systemCtx(db, 'Bluven website', w.clock.now), [lead(over)], { sourceId: (await source('bluven-website')).id, requireExternalId: true });
  const orderId = res.results[0]!.id!;
  if (upto === 'NEW') return { orderId };
  await assignOrders(as(w.manager, w.clock), { orderIds: [orderId], ownerId: w.sam.id });
  if (upto === 'ASSIGNED') return { orderId };
  const sam = as(w.sam, w.clock);
  await openJob(sam, { orderId, leadOriginId: (await leadOrigin('bluven_website')).id });
  if (upto === 'OPENED') return { orderId };
  const quote = await createQuote(sam, { orderId, title: '6.6 kW', dcWatts: 6600, storageWh: null, totalCents: 900_000, depositCents: 90_000, file: await staged(pdf(`proposal ${orderId}`), 'proposal.pdf'), notes: '' });
  await markQuoteSent(sam, { quoteId: quote.id });
  if (upto === 'QUOTED') return { orderId, quoteId: quote.id };
  const deposit = await submitDeposit(sam, { orderId, amountCents: 90_000, method: 'BANK_TRANSFER', files: [await staged(pdf(`proof ${orderId}`), 'transfer.pdf')] });
  if (upto === 'DEPOSIT_PAID') return { orderId, quoteId: quote.id, depositId: deposit.id };
  let n = 0;
  for (const key of ['electricity_bill', 'install_location', 'meter_box']) {
    n++;
    await uploadDocument(sam, { orderId, typeId: (await docType(key)).id, fileName: `${key}.png`, body: stream(await png(n * 17 + orderId.length)) });
  }
  const ids = { orderId, quoteId: quote.id, depositId: deposit.id };
  if (upto === 'READY') return ids;
  await pushOrder(sam, { orderId });
  if (upto === 'PUSHED') return ids;
  await acceptHandoff(as(w.ops, w.clock), { orderId, depositReceived: true });
  if (upto === 'ACCEPTED') return ids;
  await markJobDone(as(w.ops, w.clock), { orderId });
  return ids;
}

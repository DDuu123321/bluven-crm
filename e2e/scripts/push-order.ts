// Takes an order from "assigned" to "pushed to operations" through the application's own
// services: quote, contract, deposit confirmed by finance, the required files, the push. The
// browser journey of all of that is told in journey.spec.ts; a test that is about something
// else gets there with one call.
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { archiveContract, createQuote, decideDeposit, getHandoffChecklist, markQuoteSent, parseDateOnly, pushOrder, stageUpload, submitDeposit, uploadDocument, userCtx } from '@bluven/core';
import { createDb } from '@bluven/db';
import { E2E, type E2EState } from '../env';

const orderId = process.argv[2];
if (!orderId) throw new Error('Usage: push-order.ts <orderId>');
const pdf = (label: string): Buffer => Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`);

const db = createDb(E2E.databaseUrl);
const state = JSON.parse(readFileSync(E2E.stateFile, 'utf8')) as E2EState;
const as = async (who: 'sam' | 'fin') => {
  const u = await db.user.findUniqueOrThrow({ where: { email: state.users[who].email } });
  return userCtx(db, { id: u.id, name: u.name, email: u.email, roles: u.roles });
};
const staged = (data: Buffer, name: string) => stageUpload(Readable.from([data]), name);

const sam = await as('sam');
const quote = await createQuote(sam, { orderId, title: '6.6 kW', dcWatts: 6600, storageWh: null, totalCents: 900_000, depositCents: 90_000, notes: '' });
await markQuoteSent(sam, { quoteId: quote.id });
await archiveContract(sam, { orderId, quoteId: quote.id, signedOn: parseDateOnly(new Date().toISOString().slice(0, 10)), files: [await staged(pdf(`contract ${orderId}`), 'signed-contract.pdf')] });
const deposit = await submitDeposit(sam, { orderId, amountCents: 90_000, method: 'BANK_TRANSFER', files: [await staged(pdf(`proof ${orderId}`), 'transfer.pdf')] });
await decideDeposit(await as('fin'), { depositId: deposit.id, decision: 'CONFIRM', receivedAmountCents: 90_000, receivedOn: parseDateOnly(new Date().toISOString().slice(0, 10)) });
// Whatever the checklist still asks for gets a file.
for (const item of (await getHandoffChecklist(db, orderId)).items.filter((i) => !i.ok && i.typeId)) {
  const name = item.key.replace('doc:', '');
  await uploadDocument(sam, { orderId, typeId: item.typeId!, fileName: `${name}.pdf`, body: Readable.from([pdf(`${name} ${orderId}`)]) });
}
const pushed = await pushOrder(sam, { orderId, notes: 'Dog in the yard. Please call before coming.' });
console.log(JSON.stringify(pushed));
await db.$disconnect();

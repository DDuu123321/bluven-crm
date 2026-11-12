// Gives an order one document, marks it as lost, and moves the day it was lost into the past, so
// that a test can look at what happens when a retention period is about to end without waiting
// two years for it.
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { markLost, uploadDocument, userCtx } from '@bluven/core';
import { createDb } from '@bluven/db';
import { E2E, type E2EState } from '../env';

const [orderId, days] = [process.argv[2], Number(process.argv[3])];
if (!orderId || !Number.isFinite(days)) throw new Error('Usage: lose-and-age.ts <orderId> <days ago>');

const db = createDb(E2E.databaseUrl);
const state = JSON.parse(readFileSync(E2E.stateFile, 'utf8')) as E2EState;
const u = await db.user.findUniqueOrThrow({ where: { email: state.users.sam.email } });
const sam = userCtx(db, { id: u.id, name: u.name, email: u.email, roles: u.roles });

const bill = await db.documentType.findUniqueOrThrow({ where: { key: 'electricity_bill' } });
await uploadDocument(sam, { orderId, typeId: bill.id, fileName: 'old-bill.pdf', body: Readable.from([Buffer.from(`%PDF-1.4\n% old bill ${orderId}\n%%EOF\n`)]) });
const reason = await db.lostReason.findFirstOrThrow({ where: { key: 'price' } });
await markLost(sam, { orderId, reasonId: reason.id, note: 'Went with a cheaper quote.' });
await db.order.update({ where: { id: orderId }, data: { lostAt: new Date(Date.now() - days * 86_400_000) } });
console.log(JSON.stringify({ ok: true }));
await db.$disconnect();

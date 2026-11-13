// Sample data for looking around on your own computer: one account per role and a dozen orders
// at different points of the sale. It goes through the same services the screens use, so what
// it leaves behind is what real work would have left. Never for the real system: it only fills
// a database that has no users and no orders yet.
import { Readable } from 'node:stream';
import sharp from 'sharp';
import type { Db, Role } from '@bluven/db';
import { systemCtx, userCtx, type Ctx } from '../context';
import { parseDateOnly } from '../domain';
import { newId } from '../ids';
import { assignOrders } from './assignment';
import { hashPassword } from './auth';
import { archiveContract } from './contracts';
import { decideDeposit, submitDeposit } from './deposits';
import { stageUpload, uploadDocument } from './documents';
import { acceptHandoff, pushOrder } from './handoff';
import { ingestLeads } from './intake';
import { createQuote, markQuoteSent } from './quotes';
import { BILL_DOC_TYPE, SOURCE_KEY, ensureReferenceData } from './reference';
import { holdOrder, markLost } from './sidestate';
import { createTask, logActivity } from './timeline';

/** Every demo account signs in with this. It is written in the README, so it protects nothing. */
export const DEMO_PASSWORD = 'Bluven-demo-1';

export const DEMO_USERS = [
  { key: 'admin', email: 'admin@bluven.demo', name: 'Ada Admin', roles: ['ADMIN'] },
  { key: 'manager', email: 'manager@bluven.demo', name: 'Morgan Manager', roles: ['MANAGER'] },
  { key: 'sam', email: 'sam@bluven.demo', name: 'Sam Sales', roles: ['SALES'] },
  { key: 'alex', email: 'alex@bluven.demo', name: 'Alex Sales', roles: ['SALES'] },
  { key: 'finance', email: 'finance@bluven.demo', name: 'Fay Finance', roles: ['FINANCE'] },
  { key: 'ops', email: 'ops@bluven.demo', name: 'Olly Ops', roles: ['OPS'] },
] as const satisfies readonly { key: string; email: string; name: string; roles: Role[] }[];

type DemoUserKey = (typeof DEMO_USERS)[number]['key'];

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A one-page PDF that says what it stands in for. */
export function samplePdf(lines: string[]): Buffer {
  const escaped = lines.map((l) => l.replace(/[\\()]/g, '\\$&'));
  const content = `BT /F1 16 Tf 72 760 Td 24 TL ${escaped.map((l) => `(${l}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A picture the size of a phone photo's preview: a plain two-colour gradient, different for each seed. */
export async function samplePhoto(seed: number): Promise<Buffer> {
  const width = 960;
  const height = 720;
  const raw = Buffer.alloc(width * height * 3);
  const top = [90 + ((seed * 37) % 120), 140 + ((seed * 53) % 90), 200 + ((seed * 11) % 55)];
  const bottom = [150 + ((seed * 29) % 90), 110 + ((seed * 17) % 60), 80 + ((seed * 43) % 60)];
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) raw[i + c] = Math.round(top[c]! * (1 - t) + bottom[c]! * t);
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

const stream = (content: Buffer): Readable => Readable.from([content]);

export interface DemoSummary {
  users: number;
  orders: number;
}

/**
 * Fills an empty database with the demo accounts and orders. Returns null, and changes nothing,
 * when the database already has a user or an order. `today` is the moment the newest entries
 * carry; everything else is dated back from it.
 */
export async function createDemoData(db: Db, today: Date = new Date()): Promise<DemoSummary | null> {
  if ((await db.user.count()) > 0 || (await db.order.count()) > 0) return null;
  await ensureReferenceData(db);

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const people = {} as Record<DemoUserKey, { id: string; name: string; email: string; roles: Role[] }>;
  for (const u of DEMO_USERS) {
    const person = { id: newId('usr'), name: u.name, email: u.email, roles: [...u.roles] as Role[] };
    await db.user.create({ data: { ...person, passwordHash, mustChangePassword: false } });
    people[u.key] = person;
  }

  const website = await db.leadSource.findUniqueOrThrow({ where: { key: SOURCE_KEY.bluven } });
  const typeId = async (key: string): Promise<string> => (await db.documentType.findUniqueOrThrow({ where: { key } })).id;
  const types = { bill: await typeId(BILL_DOC_TYPE), location: await typeId('install_location'), meter: await typeId('meter_box') };
  const lostReason = await db.lostReason.findUniqueOrThrow({ where: { key: 'competitor' } });

  /** So many days, and hours, before `today`. */
  const ago = (days: number, hours = 0): Date => new Date(today.getTime() - days * DAY_MS - hours * HOUR_MS);
  const as = (who: DemoUserKey, when: Date): Ctx => userCtx(db, people[who], { now: () => when });
  const dateOnly = (when: Date): Date => parseDateOnly(when.toISOString().slice(0, 10))!;

  let received = 0;
  let photos = 0;
  const enquiry = async (when: Date, lead: Record<string, unknown>): Promise<string> => {
    received++;
    const res = await ingestLeads(systemCtx(db, 'Bluven website', () => when), [{ externalId: `demo-${received}`, state: 'NSW', propertyType: 'House', ...lead }], { sourceId: website.id, requireExternalId: true });
    const item = res.results[0];
    if (!item?.ok || !item.id) throw new Error(`The demo enquiry for ${String(lead.firstName)} was not accepted: ${item?.error ?? 'no result'}`);
    return item.id;
  };
  const assign = (orderId: string, to: 'sam' | 'alex', when: Date) => assignOrders(as('manager', when), { orderIds: [orderId], ownerId: people[to].id });
  const call = (orderId: string, who: 'sam' | 'alex', when: Date, body: string) => logActivity(as(who, when), { orderId, type: 'CALL', body, outcome: 'connected', direction: 'outbound', occurredAt: when });
  const quote = async (orderId: string, who: 'sam' | 'alex', when: Date, q: { title: string; kw: number; kwh: number | null; total: number }, send = true): Promise<string> => {
    const created = await createQuote(as(who, when), { orderId, title: q.title, dcWatts: Math.round(q.kw * 1000), storageWh: q.kwh === null ? null : Math.round(q.kwh * 1000), totalCents: q.total * 100, depositCents: q.total * 10, notes: '' });
    if (send) await markQuoteSent(as(who, new Date(when.getTime() + HOUR_MS)), { quoteId: created.id });
    return created.id;
  };
  const sign = async (orderId: string, who: 'sam' | 'alex', when: Date, quoteId: string, customer: string) =>
    archiveContract(as(who, when), { orderId, quoteId, signedOn: dateOnly(when), files: [await stageUpload(stream(samplePdf(['Signed contract', customer, 'Sample file from the demo data.'])), 'signed-contract.pdf')] });
  const deposit = async (orderId: string, who: 'sam' | 'alex', when: Date, dollars: number, customer: string): Promise<string> =>
    (await submitDeposit(as(who, when), { orderId, amountCents: dollars * 100, method: 'BANK_TRANSFER', files: [await stageUpload(stream(samplePdf(['Bank transfer receipt', customer, `$${dollars}.00`, 'Sample file from the demo data.'])), 'transfer-receipt.pdf')] })).id;
  const confirm = (depositId: string, when: Date, dollars: number) => decideDeposit(as('finance', when), { depositId, decision: 'CONFIRM', receivedAmountCents: dollars * 100, receivedOn: dateOnly(when), bankReference: 'DEMO' });
  const siteFiles = async (orderId: string, who: 'sam' | 'alex', when: Date): Promise<void> => {
    const ctx = as(who, when);
    await uploadDocument(ctx, { orderId, typeId: types.bill, fileName: 'electricity-bill.pdf', body: stream(samplePdf(['Electricity bill', 'Sample file from the demo data.'])) });
    await uploadDocument(ctx, { orderId, typeId: types.location, fileName: 'roof-north-side.jpg', body: stream(await samplePhoto(++photos)) });
    await uploadDocument(ctx, { orderId, typeId: types.meter, fileName: 'meter-box.jpg', body: stream(await samplePhoto(++photos)) });
  };

  // In the pool, nobody's yet.
  await enquiry(ago(0, 2), { firstName: 'Olivia', lastName: 'Brown', phone: '0491 570 006', email: 'olivia.brown@example.com', address: '4 Wattle Ave', suburb: 'Blacktown', postcode: '2148', components: ['Solar', 'Battery'], monthlyBill: 420, timeline: 'asap', notes: 'Bills have doubled since we got an EV.' });
  await enquiry(ago(1, 3), { firstName: 'Liam', lastName: 'Nguyen', phone: '0491 570 156', email: 'liam.nguyen@example.com', address: '27 Banksia Rd', suburb: 'Liverpool', postcode: '2170', components: ['Solar'], monthlyBill: 260, timeline: '1-3-months' });

  // Just assigned, not contacted.
  const noah = await enquiry(ago(0, 6), { firstName: 'Noah', lastName: 'Williams', phone: '0491 570 157', email: 'noah.williams@example.com', address: '9 Harbour Rd', suburb: 'Manly', postcode: '2095', components: ['Battery'], batteryKwh: 13.5, bestTime: 'evening', notes: 'Already have 5 kW of solar from 2019.' });
  await assign(noah, 'sam', ago(0, 5));

  // Contacted, with a task for tomorrow.
  const emma = await enquiry(ago(3, 4), { firstName: 'Emma', lastName: 'Wilson', phone: '0491 570 158', email: 'emma.wilson@example.com', address: '15 Jacaranda St', suburb: 'Parramatta', postcode: '2150', components: ['Solar', 'Battery'], monthlyBill: 350, timeline: '1-month' });
  await assign(emma, 'sam', ago(3, 3));
  await call(emma, 'sam', ago(2, 2), 'Talked through a 6.6 kW system with a battery. She wants the quote by e-mail and will talk it over with her partner.');
  await createTask(as('sam', ago(2, 2)), { orderId: emma, title: 'Send the quote', dueAt: new Date(today.getTime() + DAY_MS) });

  // Quoted six days ago and quiet since: this is what the idle reminders are for.
  const jack = await enquiry(ago(9, 5), { firstName: 'Jack', lastName: 'Taylor', phone: '0491 570 159', email: 'jack.taylor@example.com', address: '62 Ironbark Cres', suburb: 'Penrith', postcode: '2750', components: ['Solar', 'Battery'], monthlyBill: 510, timeline: '1-3-months' });
  await assign(jack, 'sam', ago(9, 4));
  await call(jack, 'sam', ago(8, 3), 'Wants to compare two or three quotes before deciding. Roof faces north, single storey, tile.');
  await quote(jack, 'sam', ago(6, 6), { title: '10 kW solar with 13.5 kWh battery', kw: 10, kwh: 13.5, total: 21_900 });

  // Quoted, with a second version being prepared.
  const mia = await enquiry(ago(5, 2), { firstName: 'Mia', lastName: 'Chen', phone: '0491 570 110', email: 'mia.chen@example.com', address: '3 Lilly Pilly Ct', suburb: 'Castle Hill', postcode: '2154', components: ['Solar'], monthlyBill: 300, timeline: '1-month' });
  await assign(mia, 'alex', ago(5, 1));
  await call(mia, 'alex', ago(4, 4), 'Asked for solar only for now, with room to add a battery next year.');
  await quote(mia, 'alex', ago(2, 5), { title: '8 kW solar', kw: 8, kwh: null, total: 8_400 });
  await logActivity(as('alex', ago(1, 3)), { orderId: mia, type: 'NOTE', body: 'She asked what a 10 kWh battery would add. Preparing a second version.' });
  await quote(mia, 'alex', ago(0, 4), { title: '8 kW solar with 10 kWh battery', kw: 8, kwh: 10, total: 17_200 }, false);

  // Signed yesterday; the deposit is still to come.
  const lucas = await enquiry(ago(8, 1), { firstName: 'Lucas', lastName: 'Martin', phone: '0491 570 313', email: 'lucas.martin@example.com', address: '88 Kookaburra Dr', suburb: 'Campbelltown', postcode: '2560', components: ['Solar', 'Battery'], monthlyBill: 380 });
  await assign(lucas, 'alex', ago(8, 0));
  await call(lucas, 'alex', ago(7, 3), 'Ready to go ahead if the install can happen before Christmas.');
  const lucasQuote = await quote(lucas, 'alex', ago(5, 5), { title: '6.6 kW solar with 10 kWh battery', kw: 6.6, kwh: 10, total: 15_600 });
  await sign(lucas, 'alex', ago(1, 2), lucasQuote, 'Lucas Martin');

  // Deposit sent in this morning: waiting for finance.
  const sophie = await enquiry(ago(10, 3), { firstName: 'Sophie', lastName: 'Anderson', phone: '0491 570 737', email: 'sophie.anderson@example.com', address: '21 Bottlebrush Way', suburb: 'Hornsby', postcode: '2077', components: ['Solar', 'Battery'], monthlyBill: 450 });
  await assign(sophie, 'sam', ago(10, 2));
  await call(sophie, 'sam', ago(9, 1), 'Site visit booked for Thursday. Two storeys, tin roof.');
  const sophieQuote = await quote(sophie, 'sam', ago(7, 4), { title: '10 kW solar with 13.5 kWh battery', kw: 10, kwh: 13.5, total: 22_400 });
  await sign(sophie, 'sam', ago(2, 3), sophieQuote, 'Sophie Anderson');
  await deposit(sophie, 'sam', ago(0, 3), 2240, 'Sophie Anderson');

  // Deposit confirmed and the site files are in: ready to be pushed to operations.
  const ethan = await enquiry(ago(12, 2), { firstName: 'Ethan', lastName: 'Thompson', phone: '0491 571 266', email: 'ethan.thompson@example.com', address: '5 Waratah Pl', suburb: 'Ryde', postcode: '2112', components: ['Solar'], monthlyBill: 280 });
  await assign(ethan, 'sam', ago(12, 1));
  await call(ethan, 'sam', ago(11, 2), 'Solar only. Wants black panels to match the roof.');
  const ethanQuote = await quote(ethan, 'sam', ago(9, 3), { title: '6.6 kW solar', kw: 6.6, kwh: null, total: 6_900 });
  await sign(ethan, 'sam', ago(5, 2), ethanQuote, 'Ethan Thompson');
  const ethanDeposit = await deposit(ethan, 'sam', ago(4, 4), 690, 'Ethan Thompson');
  await confirm(ethanDeposit, ago(3, 2), 690);
  await siteFiles(ethan, 'sam', ago(1, 5));

  // Pushed yesterday: operations have it to check.
  const chloe = await enquiry(ago(14, 2), { firstName: 'Chloe', lastName: 'White', phone: '0491 571 491', email: 'chloe.white@example.com', address: '40 Grevillea St', suburb: 'Sutherland', postcode: '2232', components: ['Solar', 'Battery'], monthlyBill: 400 });
  await assign(chloe, 'alex', ago(14, 1));
  await call(chloe, 'alex', ago(13, 3), 'Wants the battery in the garage, away from the bedrooms.');
  const chloeQuote = await quote(chloe, 'alex', ago(11, 4), { title: '8 kW solar with 13.5 kWh battery', kw: 8, kwh: 13.5, total: 19_800 });
  await sign(chloe, 'alex', ago(7, 2), chloeQuote, 'Chloe White');
  const chloeDeposit = await deposit(chloe, 'alex', ago(6, 3), 1980, 'Chloe White');
  await confirm(chloeDeposit, ago(5, 4), 1980);
  await siteFiles(chloe, 'alex', ago(2, 2));
  await pushOrder(as('alex', ago(1, 4)), { orderId: chloe, notes: 'Battery goes in the garage on the east wall. The customer works from home; call before coming.' });

  // All the way through: accepted by operations.
  const william = await enquiry(ago(20, 2), { firstName: 'William', lastName: 'Harris', phone: '0491 571 804', email: 'william.harris@example.com', address: '17 Bluegum Cl', suburb: 'Kellyville', postcode: '2155', components: ['Solar', 'Battery'], monthlyBill: 520 });
  await assign(william, 'sam', ago(20, 1));
  await call(william, 'sam', ago(19, 2), 'Decided quickly: a neighbour already has a Bluven system.');
  const williamQuote = await quote(william, 'sam', ago(17, 3), { title: '13 kW solar with 13.5 kWh battery', kw: 13, kwh: 13.5, total: 25_300 });
  await sign(william, 'sam', ago(13, 2), williamQuote, 'William Harris');
  const williamDeposit = await deposit(william, 'sam', ago(12, 3), 2530, 'William Harris');
  await confirm(williamDeposit, ago(11, 2), 2530);
  await siteFiles(william, 'sam', ago(8, 3));
  await pushOrder(as('sam', ago(6, 4)), { orderId: william, notes: 'Three-phase supply. Access through the side gate.' });
  await acceptHandoff(as('ops', ago(5, 2)), { orderId: william });

  // Lost to a competitor after the quote.
  const grace = await enquiry(ago(11, 5), { firstName: 'Grace', lastName: 'Lee', phone: '0491 572 549', email: 'grace.lee@example.com', address: '2 Paperbark Lane', suburb: 'Bankstown', postcode: '2200', components: ['Solar'], monthlyBill: 240 });
  await assign(grace, 'alex', ago(11, 4));
  await call(grace, 'alex', ago(10, 2), 'Price is the main thing for her. Has two other quotes already.');
  await quote(grace, 'alex', ago(8, 3), { title: '6.6 kW solar', kw: 6.6, kwh: null, total: 6_700 });
  await markLost(as('alex', ago(4, 2)), { orderId: grace, reasonId: lostReason.id, note: 'Went with a cheaper quote from another installer.' });

  // On hold while the customer waits for an approval.
  const henry = await enquiry(ago(6, 3), { firstName: 'Henry', lastName: 'Clark', phone: '0491 572 665', email: 'henry.clark@example.com', address: '11/30 Fig Tree Rd', suburb: 'Chatswood', postcode: '2067', propertyType: 'Townhouse / Unit', components: ['Solar', 'Battery'], monthlyBill: 310 });
  await assign(henry, 'sam', ago(6, 2));
  await call(henry, 'sam', ago(5, 3), 'Townhouse: he needs the strata committee to approve panels on the shared roof first. Meeting is in two weeks.');
  await holdOrder(as('sam', ago(5, 2)), { orderId: henry, until: dateOnly(new Date(today.getTime() + 14 * DAY_MS)), note: 'Waiting for strata approval.' });

  return { users: DEMO_USERS.length, orders: received };
}

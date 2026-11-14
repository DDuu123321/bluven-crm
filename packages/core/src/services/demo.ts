// Sample data for looking around on your own computer: one account per role and sixteen orders
// at different points, from a lead in the pool to a job that is installed, paid and closed. It goes through the same services the screens use, so what
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
import { submitDeposit } from './deposits';
import { stageUpload, uploadDocument } from './documents';
import { acceptHandoff, pushOrder } from './handoff';
import { ingestLeads } from './intake';
import { addOpsNote, confirmFinalPayment, markJobDone, setRebateApplied, updateOpsJob } from './operations';
import { openJob, setIntent } from './pipeline';
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
  const originId = async (key: string): Promise<string> => (await db.leadOrigin.findUniqueOrThrow({ where: { key } })).id;
  const origins = { website: await originId('bluven_website'), partner: await originId('partner'), referral: await originId('customer_referral'), advertising: await originId('advertising') };

  /** So many days, and hours, before `today`. */
  const ago = (days: number, hours = 0): Date => new Date(today.getTime() - days * DAY_MS - hours * HOUR_MS);
  const as = (who: DemoUserKey, when: Date): Ctx => userCtx(db, people[who], { now: () => when });
  const dateOnly = (when: Date): Date => parseDateOnly(when.toISOString().slice(0, 10))!;
  type Seller = 'sam' | 'alex';

  let received = 0;
  let photos = 0;
  const enquiry = async (when: Date, lead: Record<string, unknown>): Promise<string> => {
    received++;
    const res = await ingestLeads(systemCtx(db, 'Bluven website', () => when), [{ externalId: `demo-${received}`, state: 'NSW', propertyType: 'House', ...lead }], { sourceId: website.id, requireExternalId: true });
    const item = res.results[0];
    if (!item?.ok || !item.id) throw new Error(`The demo enquiry for ${String(lead.firstName)} was not accepted: ${item?.error ?? 'no result'}`);
    return item.id;
  };
  const assign = (orderId: string, to: Seller, when: Date) => assignOrders(as('manager', when), { orderIds: [orderId], ownerId: people[to].id });
  /** Assigned by the manager and opened by the salesperson an hour later, with where the customer came from. */
  const take = async (orderId: string, who: Seller, when: Date, origin: keyof typeof origins = 'website', note = ''): Promise<void> => {
    await assign(orderId, who, when);
    await openJob(as(who, new Date(when.getTime() + HOUR_MS)), { orderId, leadOriginId: origins[origin], note });
  };
  const call = (orderId: string, who: Seller, when: Date, body: string) => logActivity(as(who, when), { orderId, type: 'CALL', body, outcome: 'connected', direction: 'outbound', occurredAt: when });
  const quote = async (orderId: string, who: Seller, when: Date, q: { title: string; kw: number; kwh: number | null; total: number }, send = true): Promise<string> => {
    const file = await stageUpload(stream(samplePdf(['Proposal', q.title, `$${q.total}.00 including GST`, 'Terms and conditions apply.', 'Sample file from the demo data.'])), 'proposal.pdf');
    const created = await createQuote(as(who, when), { orderId, title: q.title, dcWatts: Math.round(q.kw * 1000), storageWh: q.kwh === null ? null : Math.round(q.kwh * 1000), totalCents: q.total * 100, depositCents: q.total * 10, notes: '', file });
    if (send) await markQuoteSent(as(who, new Date(when.getTime() + HOUR_MS)), { quoteId: created.id });
    return created.id;
  };
  const deposit = async (orderId: string, who: Seller, when: Date, dollars: number, customer: string, quoteId?: string): Promise<string> =>
    (await submitDeposit(as(who, when), { orderId, amountCents: dollars * 100, method: 'BANK_TRANSFER', quoteId, files: [await stageUpload(stream(samplePdf(['Bank transfer receipt', customer, `$${dollars}.00`, 'Sample file from the demo data.'])), 'transfer-receipt.pdf')] })).id;
  const siteFiles = async (orderId: string, who: Seller, when: Date): Promise<void> => {
    const ctx = as(who, when);
    await uploadDocument(ctx, { orderId, typeId: types.bill, fileName: 'electricity-bill.pdf', body: stream(samplePdf(['Electricity bill', 'Sample file from the demo data.'])) });
    await uploadDocument(ctx, { orderId, typeId: types.location, fileName: 'roof-north-side.jpg', body: stream(await samplePhoto(++photos)) });
    await uploadDocument(ctx, { orderId, typeId: types.meter, fileName: 'meter-box.jpg', body: stream(await samplePhoto(++photos)) });
  };
  /** A whole sale up to the push: proposal, deposit, the folder, and the push with its notes. */
  const sell = async (orderId: string, who: Seller, customer: string, q: { title: string; kw: number; kwh: number | null; total: number }, days: { quoted: number; paid: number; files: number; pushed: number }, notes: string): Promise<void> => {
    await quote(orderId, who, ago(days.quoted, 3), q);
    await deposit(orderId, who, ago(days.paid, 3), q.total / 10, customer);
    await siteFiles(orderId, who, ago(days.files, 3));
    await pushOrder(as(who, ago(days.pushed, 4)), { orderId, notes });
  };

  // In the pool, nobody's yet.
  await enquiry(ago(0, 2), { firstName: 'Olivia', lastName: 'Brown', phone: '0491 570 006', email: 'olivia.brown@example.com', address: '4 Wattle Ave', suburb: 'Blacktown', postcode: '2148', components: ['Solar', 'Battery'], monthlyBill: 420, timeline: 'asap', notes: 'Bills have doubled since we got an EV.' });
  await enquiry(ago(1, 3), { firstName: 'Liam', lastName: 'Nguyen', phone: '0491 570 156', email: 'liam.nguyen@example.com', address: '27 Banksia Rd', suburb: 'Liverpool', postcode: '2170', components: ['Solar'], monthlyBill: 260, timeline: '1-3-months' });

  // Assigned this morning. The salesperson has not opened the job yet.
  const noah = await enquiry(ago(0, 6), { firstName: 'Noah', lastName: 'Williams', phone: '0491 570 157', email: 'noah.williams@example.com', address: '9 Harbour Rd', suburb: 'Manly', postcode: '2095', components: ['Battery'], batteryKwh: 13.5, bestTime: 'evening', notes: 'Already have 5 kW of solar from 2019.' });
  await assign(noah, 'sam', ago(0, 5));

  // Opened and being followed up, with a task for tomorrow.
  const emma = await enquiry(ago(3, 4), { firstName: 'Emma', lastName: 'Wilson', phone: '0491 570 158', email: 'emma.wilson@example.com', address: '15 Jacaranda St', suburb: 'Parramatta', postcode: '2150', components: ['Solar', 'Battery'], monthlyBill: 350, timeline: '1-month' });
  await take(emma, 'sam', ago(3, 3));
  await call(emma, 'sam', ago(2, 2), 'Talked through a 6.6 kW system with a battery. She is comparing a few installers and will talk it over with her partner.');
  await createTask(as('sam', ago(2, 2)), { orderId: emma, title: 'Call Emma back', dueAt: new Date(today.getTime() + DAY_MS) });

  // The customer wants a proposal: the system is being designed.
  const isla = await enquiry(ago(4, 2), { firstName: 'Isla', lastName: 'Roberts', phone: '0491 570 222', email: 'isla.roberts@example.com', address: '6 Coachwood Cl', suburb: 'Epping', postcode: '2121', components: ['Solar', 'Battery'], monthlyBill: 460, timeline: 'asap' });
  await take(isla, 'alex', ago(4, 1), 'partner', 'Sent by Northside Electrical');
  await call(isla, 'alex', ago(3, 3), 'Knows what she wants: 10 kW and a battery, installed before summer. Photos of the roof and the switchboard are coming by e-mail.');
  await setIntent(as('alex', ago(3, 2)), { orderId: isla, intent: 'DESIGN' });

  // Proposal sent six days ago and quiet since: this is what the idle reminders are for.
  const jack = await enquiry(ago(9, 5), { firstName: 'Jack', lastName: 'Taylor', phone: '0491 570 159', email: 'jack.taylor@example.com', address: '62 Ironbark Cres', suburb: 'Penrith', postcode: '2750', components: ['Solar', 'Battery'], monthlyBill: 510, timeline: '1-3-months' });
  await take(jack, 'sam', ago(9, 4), 'advertising');
  await call(jack, 'sam', ago(8, 3), 'Wants to compare two or three quotes before deciding. Roof faces north, single storey, tile.');
  await quote(jack, 'sam', ago(6, 6), { title: '10 kW solar with 13.5 kWh battery', kw: 10, kwh: 13.5, total: 21_900 });

  // Proposal sent, with a second version being prepared.
  const mia = await enquiry(ago(5, 2), { firstName: 'Mia', lastName: 'Chen', phone: '0491 570 110', email: 'mia.chen@example.com', address: '3 Lilly Pilly Ct', suburb: 'Castle Hill', postcode: '2154', components: ['Solar'], monthlyBill: 300, timeline: '1-month' });
  await take(mia, 'alex', ago(5, 1));
  await call(mia, 'alex', ago(4, 4), 'Asked for solar only for now, with room to add a battery next year.');
  await quote(mia, 'alex', ago(2, 5), { title: '8 kW solar', kw: 8, kwh: null, total: 8_400 });
  await logActivity(as('alex', ago(1, 3)), { orderId: mia, type: 'NOTE', body: 'She asked what a 10 kWh battery would add. Preparing a second version.' });
  await quote(mia, 'alex', ago(0, 4), { title: '8 kW solar with 10 kWh battery', kw: 8, kwh: 10, total: 17_200 }, false);

  // Said yes yesterday; the deposit is still to come.
  const lucas = await enquiry(ago(8, 1), { firstName: 'Lucas', lastName: 'Martin', phone: '0491 570 313', email: 'lucas.martin@example.com', address: '88 Kookaburra Dr', suburb: 'Campbelltown', postcode: '2560', components: ['Solar', 'Battery'], monthlyBill: 380 });
  await take(lucas, 'alex', ago(8, 0), 'referral', 'His neighbour, William Harris');
  await call(lucas, 'alex', ago(7, 3), 'Ready to go ahead if the install can happen before Christmas.');
  await quote(lucas, 'alex', ago(5, 5), { title: '6.6 kW solar with 10 kWh battery', kw: 6.6, kwh: 10, total: 15_600 });
  await call(lucas, 'alex', ago(1, 2), 'He accepts the proposal and will transfer the deposit this week.');

  // Deposit paid this morning. The folder is not complete yet.
  const sophie = await enquiry(ago(10, 3), { firstName: 'Sophie', lastName: 'Anderson', phone: '0491 570 737', email: 'sophie.anderson@example.com', address: '21 Bottlebrush Way', suburb: 'Hornsby', postcode: '2077', components: ['Solar', 'Battery'], monthlyBill: 450 });
  await take(sophie, 'sam', ago(10, 2));
  await call(sophie, 'sam', ago(9, 1), 'Site visit booked for Thursday. Two storeys, tin roof.');
  await quote(sophie, 'sam', ago(7, 4), { title: '10 kW solar with 13.5 kWh battery', kw: 10, kwh: 13.5, total: 22_400 });
  await deposit(sophie, 'sam', ago(0, 3), 2240, 'Sophie Anderson');

  // Deposit paid and the folder complete: ready to be pushed to operations.
  const ethan = await enquiry(ago(12, 2), { firstName: 'Ethan', lastName: 'Thompson', phone: '0491 571 266', email: 'ethan.thompson@example.com', address: '5 Waratah Pl', suburb: 'Ryde', postcode: '2112', components: ['Solar'], monthlyBill: 280 });
  await take(ethan, 'sam', ago(12, 1));
  await call(ethan, 'sam', ago(11, 2), 'Solar only. Wants black panels to match the roof.');
  await quote(ethan, 'sam', ago(9, 3), { title: '6.6 kW solar', kw: 6.6, kwh: null, total: 6_900 });
  await deposit(ethan, 'sam', ago(4, 4), 690, 'Ethan Thompson');
  await siteFiles(ethan, 'sam', ago(1, 5));

  // Pushed yesterday: operations has it to accept.
  const chloe = await enquiry(ago(14, 2), { firstName: 'Chloe', lastName: 'White', phone: '0491 571 491', email: 'chloe.white@example.com', address: '40 Grevillea St', suburb: 'Sutherland', postcode: '2232', components: ['Solar', 'Battery'], monthlyBill: 400 });
  await take(chloe, 'alex', ago(14, 1), 'partner', 'Sent by Northside Electrical');
  await call(chloe, 'alex', ago(13, 3), 'Wants the battery in the garage, away from the bedrooms.');
  await sell(chloe, 'alex', 'Chloe White', { title: '8 kW solar with 13.5 kWh battery', kw: 8, kwh: 13.5, total: 19_800 }, { quoted: 11, paid: 6, files: 2, pushed: 1 }, 'Battery goes in the garage on the east wall. The customer works from home; call before coming.');

  // Accepted by operations, who are arranging the installation.
  const william = await enquiry(ago(20, 2), { firstName: 'William', lastName: 'Harris', phone: '0491 571 804', email: 'william.harris@example.com', address: '17 Bluegum Cl', suburb: 'Kellyville', postcode: '2155', components: ['Solar', 'Battery'], monthlyBill: 520 });
  await take(william, 'sam', ago(20, 1));
  await call(william, 'sam', ago(19, 2), 'Decided quickly: a neighbour already has a Bluven system.');
  await sell(william, 'sam', 'William Harris', { title: '13 kW solar with 13.5 kWh battery', kw: 13, kwh: 13.5, total: 25_300 }, { quoted: 17, paid: 12, files: 8, pushed: 6 }, 'Three-phase supply. Access through the side gate.');
  await acceptHandoff(as('ops', ago(5, 2)), { orderId: william, depositReceived: true });
  await updateOpsJob(as('ops', ago(3, 2)), {
    orderId: william,
    caStatus: 'APPLIED',
    caReference: 'Endeavour Energy 2026-118833',
    stcPlatform: 'greendeal',
    stcReference: '',
    installerName: 'Voltline Electrical',
    electricianLicence: '318552C',
    installDate: dateOnly(new Date(today.getTime() + 9 * DAY_MS)),
    deliveryMode: 'DELIVERY',
    deliveryEta: dateOnly(new Date(today.getTime() + 6 * DAY_MS)),
    purchaseStatus: 'ORDERED',
  });
  await addOpsNote(as('ops', ago(3, 1)), { orderId: william, body: 'Battery is on back order with the supplier: confirmed for the delivery date, check again two days before.' });

  // Installed last week. The balance was due and has not come in.
  const ava = await enquiry(ago(40, 2), { firstName: 'Ava', lastName: 'Mitchell', phone: '0491 573 118', email: 'ava.mitchell@example.com', address: '52 Stringybark Rd', suburb: 'Hornsby Heights', postcode: '2077', components: ['Solar'], monthlyBill: 310 });
  await take(ava, 'alex', ago(40, 1), 'advertising');
  await call(ava, 'alex', ago(39, 2), 'Straightforward single-storey job. Wants it done before the school holidays.');
  await sell(ava, 'alex', 'Ava Mitchell', { title: '8 kW solar', kw: 8, kwh: null, total: 8_900 }, { quoted: 37, paid: 33, files: 31, pushed: 30 }, 'Dog in the back yard. Park on the street.');
  await acceptHandoff(as('ops', ago(29, 2)), { orderId: ava, depositReceived: true });
  await updateOpsJob(as('ops', ago(25, 2)), { orderId: ava, caStatus: 'NOT_REQUIRED', caReference: '', stcPlatform: 'formbay', stcReference: 'FB-204471', installerName: 'Voltline Electrical', electricianLicence: '318552C', installDate: dateOnly(ago(9)), deliveryMode: 'PICKUP', deliveryEta: null, purchaseStatus: 'IN_STOCK' });
  await markJobDone(as('ops', ago(9, 1)), { orderId: ava });
  await setRebateApplied(as('ops', ago(7, 3)), { orderId: ava, applied: true });

  // All the way through: installed, paid, closed.
  const oliver = await enquiry(ago(60, 2), { firstName: 'Oliver', lastName: 'King', phone: '0491 574 902', email: 'oliver.king@example.com', address: '8 Scribbly Gum Pl', suburb: 'Baulkham Hills', postcode: '2153', components: ['Solar', 'Battery'], monthlyBill: 480 });
  await take(oliver, 'sam', ago(60, 1), 'partner', 'Sent by Northside Electrical');
  await call(oliver, 'sam', ago(59, 2), 'Wants backup power for the home office.');
  await sell(oliver, 'sam', 'Oliver King', { title: '10 kW solar with 13.5 kWh battery', kw: 10, kwh: 13.5, total: 22_900 }, { quoted: 56, paid: 52, files: 50, pushed: 49 }, 'Backup circuit for the study and the fridge.');
  await acceptHandoff(as('ops', ago(48, 2)), { orderId: oliver, depositReceived: true });
  await updateOpsJob(as('ops', ago(45, 2)), { orderId: oliver, caStatus: 'APPROVED', caReference: 'Endeavour Energy 2026-101207', stcPlatform: 'bridgeselect', stcReference: '', installerName: 'Sunrise Solar Installs', electricianLicence: '274410C', installDate: dateOnly(ago(25)), deliveryMode: 'DELIVERY', deliveryEta: dateOnly(ago(27)), purchaseStatus: 'ORDERED' });
  await markJobDone(as('ops', ago(25, 1)), { orderId: oliver });
  await setRebateApplied(as('ops', ago(24, 3)), { orderId: oliver, applied: true });
  await confirmFinalPayment(as('finance', ago(21, 2)), { orderId: oliver, amountCents: 2_061_000, receivedOn: dateOnly(ago(21)), note: 'DEMO' });

  // Lost to a competitor after the proposal.
  const grace = await enquiry(ago(11, 5), { firstName: 'Grace', lastName: 'Lee', phone: '0491 572 549', email: 'grace.lee@example.com', address: '2 Paperbark Lane', suburb: 'Bankstown', postcode: '2200', components: ['Solar'], monthlyBill: 240 });
  await take(grace, 'alex', ago(11, 4));
  await call(grace, 'alex', ago(10, 2), 'Price is the main thing for her. Has two other quotes already.');
  await quote(grace, 'alex', ago(8, 3), { title: '6.6 kW solar', kw: 6.6, kwh: null, total: 6_700 });
  await markLost(as('alex', ago(4, 2)), { orderId: grace, reasonId: lostReason.id, note: 'Went with a cheaper quote from another installer.' });

  // On hold while the customer waits for an approval.
  const henry = await enquiry(ago(6, 3), { firstName: 'Henry', lastName: 'Clark', phone: '0491 572 665', email: 'henry.clark@example.com', address: '11/30 Fig Tree Rd', suburb: 'Chatswood', postcode: '2067', propertyType: 'Townhouse / Unit', components: ['Solar', 'Battery'], monthlyBill: 310 });
  await take(henry, 'sam', ago(6, 2));
  await call(henry, 'sam', ago(5, 3), 'Townhouse: he needs the strata committee to approve panels on the shared roof first. Meeting is in two weeks.');
  await holdOrder(as('sam', ago(5, 2)), { orderId: henry, until: dateOnly(new Date(today.getTime() + 14 * DAY_MS)), note: 'Waiting for strata approval.' });

  return { users: DEMO_USERS.length, orders: received };
}

// Turns one order into the text the model reads. Only this order's own customer, property and
// history go in: nothing about any other customer ever does.
import type { Db } from '@bluven/db';
import {
  BEST_TIME_LABEL,
  CURRENT_DOCUMENT,
  SIDE_STATE_LABEL,
  STAGE_LABEL,
  opsItems,
  TIMELINE_LABEL,
  formatAddress,
  formatCents,
  formatDate,
  formatDateOnly,
  formatDateTime,
  formatKw,
  formatKwh,
  fullName,
  getConfig,
  readFieldSources,
  type LeadDetails,
  type SourcedPropertyField,
} from '@bluven/core';

/** One timeline entry is cut at this length; a note this long is a pasted document, not a note. */
const MAX_ENTRY_CHARS = 6_000;
/** The history is cut at about this length, oldest entries first. Far more than a normal order ever has. */
const MAX_HISTORY_CHARS = 200_000;

export interface OrderContext {
  orderId: string;
  orderNo: string;
  customerId: string;
  customerName: string;
  ownerName: string | null;
  /** The whole description, ready to be given to the model. */
  text: string;
  /** How many of the oldest timeline entries were left out to stay within the length limit. */
  omittedEntries: number;
}

const ACTIVITY_WORD: Record<string, string> = {
  NOTE: 'Note',
  CALL: 'Call',
  MEETING: 'Meeting or site visit',
  MESSAGE: 'Message',
  EMAIL_IN: 'E-mail received',
  EMAIL_OUT: 'E-mail sent',
};

/**
 * Takes the fence's own marks out of a text, so that nothing inside a fence can close it.
 * Taking one mark out can bring the two halves of another together (">><<<>" turns into ">>>"),
 * so this goes on until none is left. Characters that do not show on the page are dropped where
 * they sit between angle brackets: they would keep a mark from being found here and leave it
 * looking like one.
 */
function withoutFenceMarks(text: string): string {
  let clean = text;
  for (let before = ''; before !== clean; ) {
    before = clean;
    clean = clean.replace(/(?<=[<>])\p{Cf}+(?=[<>])/gu, '').replace(/<<<|>>>/g, '');
  }
  return clean;
}

/**
 * What the system prompts say the fence holds. It is kept here, next to the code that puts the
 * fence up, so that the two do not drift apart when another field is fenced.
 */
export const FENCED_TEXT =
  'Text between <<< and >>> came from outside the company: what the customer wrote, their name and address as they gave them, the subjects of e-mails, the names of files, and what was read from their electricity bill.';

/** Text that came from outside the company is fenced, so the model treats it as material and not as instructions. */
export function quoted(text: string): string {
  return `<<<\n${withoutFenceMarks(text).trim()}\n>>>`;
}

/**
 * The same fence for a short value that stays on its line: a name, a subject, the name of a file.
 * Line breaks become spaces, so the value cannot pass for further lines of the record, and no
 * angle bracket of its own is left touching the fence.
 */
export function quotedLine(text: string): string {
  return `<<<${withoutFenceMarks(text)
    .replace(/\s+/g, ' ')
    .replace(/^[\s<]+|[\s>]+$/g, '')}>>>`;
}

const line = (label: string, value: string | null | undefined): string | null => (value && value.trim() ? `${label}: ${value.trim()}` : null);

/** A line whose value came from outside the company. */
const outsideLine = (label: string, value: string | null | undefined): string | null => (value && value.trim() ? `${label}: ${quotedLine(value)}` : null);

function block(title: string, lines: (string | null | undefined)[]): string | null {
  const kept = lines.filter((l): l is string => !!l);
  return kept.length ? `## ${title}\n${kept.join('\n')}` : null;
}

export function describeLeadDetails(details: LeadDetails): (string | null)[] {
  return [
    line('Interested in', details.components?.join(', ')),
    details.systemKw !== undefined ? `Solar size asked for: ${details.systemKw} kW` : null,
    details.batteryKwh !== undefined ? `Battery size asked for: ${details.batteryKwh} kWh` : null,
    details.monthlyBill !== undefined ? `Monthly electricity bill as stated in the enquiry: $${details.monthlyBill}` : null,
    line('When they want it', details.timeline ? (TIMELINE_LABEL[details.timeline as keyof typeof TIMELINE_LABEL] ?? details.timeline) : null),
    line('Best time to contact', details.bestTime ? (BEST_TIME_LABEL[details.bestTime as keyof typeof BEST_TIME_LABEL] ?? details.bestTime) : null),
    outsideLine('Household', details.householdSize),
    outsideLine('Goals', details.goals),
    outsideLine('Product preference', details.productPreference),
    details.notes ? `What they wrote in the enquiry form:\n${quoted(details.notes)}` : null,
  ];
}

export interface BillFacts {
  fileName: string;
  retailer: string;
  nmi: string;
  periodFrom: Date | null;
  periodTo: Date | null;
  usageKwh: number | null;
  dailyKwh: number | null;
  amountCents: number | null;
  tariff: string;
  exportKwh: number | null;
  notes: string;
  addressMatch: string;
}

/**
 * One bill on file. What it says in words was read from the customer's document, or is the
 * name of the file, and is fenced. Figures and dates are not: they cannot say anything but
 * what they are.
 */
export function describeBill(b: BillFacts): string {
  const parts = [
    b.retailer && `retailer ${quotedLine(b.retailer)}`,
    b.nmi && `NMI ${quotedLine(b.nmi)}`,
    b.periodFrom && b.periodTo && `billing period ${formatDateOnly(b.periodFrom)} to ${formatDateOnly(b.periodTo)}`,
    b.usageKwh !== null && `${b.usageKwh} kWh used in the period`,
    b.dailyKwh !== null && `${b.dailyKwh} kWh a day on average`,
    b.amountCents !== null && `${formatCents(b.amountCents)} for the period`,
    b.tariff && `tariff: ${quotedLine(b.tariff)}`,
    b.exportKwh !== null && `${b.exportKwh} kWh exported to the grid (they already have solar)`,
    b.addressMatch === 'no' && 'the supply address on the bill is NOT the address of this order',
    b.notes && `also noted: ${quotedLine(b.notes)}`,
  ].filter(Boolean);
  return `From the file ${quotedLine(b.fileName)}: ${parts.join('; ')}.`;
}

/**
 * Which parts of a timeline entry hold text from outside the company. Everything else on the
 * timeline was written by staff or by the system itself.
 */
function outsideParts(a: { type: string; payload: unknown }): { summary: 'all' | 'name' | null; body: boolean } {
  switch (a.type) {
    // The summary line names the sender and gives the subject, and the text is the customer's.
    case 'EMAIL_IN':
      return { summary: 'all', body: true };
    // The text is ours. The summary line still carries the customer's name and, in a reply, the customer's subject.
    case 'EMAIL_OUT':
      return { summary: 'all', body: false };
    case 'LEAD':
      return { summary: null, body: true };
    // "Uploaded Electricity bill: scan.pdf", or a list of files below the line. The name of a file is whatever its sender called it.
    case 'DOCUMENT':
      return { summary: 'name', body: true };
    // What was read from a bill: the name of the file, and below it what the bill says.
    case 'SYSTEM': {
      const fromBill = typeof a.payload === 'object' && a.payload !== null && 'billReadingId' in a.payload;
      return { summary: fromBill ? 'name' : null, body: fromBill };
    }
    default:
      return { summary: null, body: false };
  }
}

/** The summary line of a timeline entry, with what came from outside fenced: all of it, or the name after the colon. */
function summaryLine(summary: string, outside: 'all' | 'name' | null): string {
  if (outside === 'all') return quotedLine(summary);
  const colon = summary.indexOf(': ');
  return outside === 'name' && colon >= 0 ? `${summary.slice(0, colon + 2)}${quotedLine(summary.slice(colon + 2))}` : summary;
}

/** Everything on record about one order, as plain text: the facts first, then the timeline oldest first. */
export async function buildOrderContext(db: Db, orderId: string): Promise<OrderContext> {
  const tz = getConfig().timeZone;
  const o = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      owner: { select: { name: true } },
      source: { select: { name: true } },
      leadOrigin: { select: { label: true } },
      lostReason: { select: { label: true } },
      opsJob: true,
      customer: true,
      property: true,
      quotes: { orderBy: { version: 'asc' } },
      contracts: { where: { voidedAt: null }, take: 1 },
      deposits: { orderBy: { submittedAt: 'asc' } },
      tasks: { where: { status: 'OPEN' }, orderBy: { dueAt: 'asc' }, take: 20 },
      documents: { where: CURRENT_DOCUMENT, select: { type: { select: { label: true, sortOrder: true } } } },
      billReadings: { where: { isBill: true, document: { deletedAt: null } }, include: { document: { select: { fileName: true } } }, orderBy: { createdAt: 'asc' } },
      handoffs: { orderBy: { version: 'desc' }, take: 1, select: { version: true, decision: true, returnReason: true, pushedAt: true } },
    },
  });
  const activities = await db.activity.findMany({
    where: { orderId },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    include: { actor: { select: { name: true } } },
  });

  const p = o.property;
  // A property detail that nobody typed was read from a bill or picked out of the correspondence: it is fenced like its source.
  const sources = readFieldSources(p.fieldSources);
  const detail = (label: string, field: SourcedPropertyField): string | null => (sources[field] ? outsideLine(label, p[field]) : line(label, p[field]));
  const state = o.sideState === 'NONE' ? STAGE_LABEL[o.stage] : `${SIDE_STATE_LABEL[o.sideState]} (was at stage ${STAGE_LABEL[o.stage]})`;
  const docCounts = new Map<string, { n: number; sort: number }>();
  for (const d of o.documents) docCounts.set(d.type.label, { n: (docCounts.get(d.type.label)?.n ?? 0) + 1, sort: d.type.sortOrder });
  const lastHandoff = o.handoffs[0];

  const sections = [
    block('Order', [
      `Number: ${o.orderNo}`,
      `Stage: ${state}`,
      line('Salesperson', o.owner?.name ?? 'not assigned yet'),
      `Enquiry received: ${formatDateTime(o.leadCreatedAt, tz)} through ${o.source.name}`,
      // Chosen from our own list by the salesperson; only the remark next to it is free text.
      o.leadOrigin ? `Lead source: ${o.leadOrigin.label}${o.leadOriginNote ? ` (${o.leadOriginNote})` : ''}` : null,
      o.sideState === 'LOST' ? line('Marked as lost because', [o.lostReason?.label, o.lostNote].filter(Boolean).join(': ')) : null,
      o.sideState === 'ON_HOLD' ? `On hold until ${formatDateOnly(o.onHoldUntil)}${o.onHoldNote ? `: ${o.onHoldNote}` : ''}` : null,
      o.sideState === 'CANCELLED' ? line('Cancelled because', o.cancelNote) : null,
      lastHandoff?.decision === 'RETURNED' ? `Operations returned the order: ${lastHandoff.returnReason}` : null,
    ]),
    block('What the customer asked for', describeLeadDetails(o.leadDetails as LeadDetails)),
    // The name and the address are as the customer gave them, on the website's form as likely as not.
    block('Customer', [outsideLine('Name', fullName(o.customer)), line('Staff notes about the customer', o.customer.notes)]),
    block('Property', [
      outsideLine('Address', formatAddress(p)) ?? 'Address: not known yet',
      detail('Type', 'propertyType'),
      detail('NMI', 'nmi'),
      detail('Electricity retailer', 'retailer'),
      detail('Supply', 'phase'),
      detail('Roof', 'roofType'),
      detail('Storeys', 'storeys'),
      line('Site notes', p.notes),
    ]),
    block(
      'Electricity bills on file',
      o.billReadings.map((b) => describeBill({ ...b, fileName: b.document.fileName })),
    ),
    block(
      'Quote versions',
      o.quotes.map((q) => {
        const facts = [
          q.dcWatts ? `${formatKw(q.dcWatts)} solar` : null,
          q.storageWh ? `${formatKwh(q.storageWh)} battery` : null,
          q.totalCents !== null ? `${formatCents(q.totalCents, q.currency)} in total` : null,
          q.depositCents !== null ? `${formatCents(q.depositCents, q.currency)} deposit` : null,
          q.sentAt ? `sent to the customer on ${formatDate(q.sentAt, tz)}` : 'not sent to the customer yet',
          q.isAccepted ? 'this is the version the customer accepted' : null,
          q.notes ? `note: ${q.notes}` : null,
        ].filter(Boolean);
        return `Version ${q.version}${q.title ? ` “${q.title}”` : ''}: ${facts.join(', ')}.`;
      }),
    ),
    block('Deposit', [
      // A signed contract is not required. Where one was filed, it is worth knowing.
      o.contracts[0] ? `A contract signed on ${formatDateOnly(o.contracts[0].signedOn)} is on file.` : null,
      ...o.deposits.map((d) => {
        const amount = formatCents(d.receivedAmountCents ?? d.amountCents, d.currency);
        if (d.status === 'CONFIRMED') return `Deposit of ${amount} received${d.receivedOn ? ` (confirmed by operations on ${formatDateOnly(d.receivedOn)})` : ''}.`;
        if (d.status === 'PENDING') return `Deposit of ${amount} recorded by sales on ${formatDate(d.submittedAt, tz)}, with proof of payment. Operations confirms that it arrived when they accept the order.`;
        if (d.status === 'REJECTED') return `A deposit record of ${amount} was rejected${d.decisionNote ? `: ${d.decisionNote}` : ''}.`;
        return null;
      }),
    ]),
    block(
      'What operations has arranged',
      o.opsJob
        ? [
            ...opsItems(o.opsJob).map((i) => `${i.label}: ${i.detail}`),
            o.jobDoneAt ? `Job done on ${formatDate(o.jobDoneAt, tz)}.` : null,
            o.opsJob.rebateAppliedAt ? `Rebate applied for on ${formatDate(o.opsJob.rebateAppliedAt, tz)}.` : null,
            o.completedAt ? `Final payment received${o.opsJob.finalAmountCents !== null ? ` (${formatCents(o.opsJob.finalAmountCents)})` : ''}: job closed on ${formatDate(o.completedAt, tz)}.` : null,
          ]
        : [],
    ),
    block(
      'Documents on file',
      [...docCounts.entries()].sort((a, b) => a[1].sort - b[1].sort).map(([label, { n }]) => `${label}: ${n} file${n === 1 ? '' : 's'}`),
    ),
    block(
      'Open tasks',
      o.tasks.map((t) => `Due ${formatDateTime(t.dueAt, tz)}: ${t.title}${t.notes ? ` (${t.notes})` : ''}`),
    ),
    block('Notes from the salesperson for operations', [o.handoffNotes || null]),
  ].filter((s): s is string => !!s);

  // The timeline, oldest first. When it is too long the oldest entries go, and the text says so.
  const entries = activities.map((a) => {
    const who = a.actor?.name ?? a.actorLabel ?? '';
    const kind = ACTIVITY_WORD[a.type];
    const outside = outsideParts(a);
    let body = a.body.trim();
    if (body.length > MAX_ENTRY_CHARS) body = `${body.slice(0, MAX_ENTRY_CHARS)}\n[the rest of this entry is not shown]`;
    // An e-mail's summary says "Email from…" itself. Once it is inside the fence, the word in front of it is what says, in our own words, which way the e-mail went.
    const head = `[${formatDateTime(a.occurredAt, tz)}] ${kind && (outside.summary === 'all' || !a.summary.startsWith('Email')) ? `${kind} · ` : ''}${summaryLine(a.summary, outside.summary)}${who && a.type !== 'EMAIL_IN' ? ` · by ${who}` : ''}`;
    return body ? `${head}\n${outside.body ? quoted(body) : body}` : head;
  });
  let omitted = 0;
  let size = entries.reduce((sum, e) => sum + e.length + 2, 0);
  while (size > MAX_HISTORY_CHARS && entries.length - omitted > 1) {
    size -= entries[omitted]!.length + 2;
    omitted++;
  }
  const history = entries.slice(omitted);
  sections.push(`## Timeline, oldest first\n${omitted > 0 ? `[${omitted} older entries are not shown]\n\n` : ''}${history.length ? history.join('\n\n') : 'Nothing has been recorded yet.'}`);

  return { orderId: o.id, orderNo: o.orderNo, customerId: o.customerId, customerName: fullName(o.customer), ownerName: o.owner?.name ?? null, text: sections.join('\n\n'), omittedEntries: omitted };
}

/** The newest moment at which anything was recorded on the order, for telling whether a summary is out of date. */
export async function latestRecordedAt(db: Db, orderId: string): Promise<Date | null> {
  const last = await db.activity.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return last?.createdAt ?? null;
}

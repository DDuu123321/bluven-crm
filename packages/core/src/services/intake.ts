// Lead intake: validation, duplicate detection and order creation.
// Rules: docs/sales-crm-design.md section 5.4.
import { parse as parseCsv } from 'csv-parse/sync';
import { Prisma, type DbOrTx, type LeadSource, type Tx } from '@bluven/db';
import { inTx, nowOf, type Ctx } from '../context';
import {
  addressKey,
  can,
  fullName,
  isManager,
  isOpenOrder,
  leadDetailsOf,
  normalizeAddressLine,
  normalizePhone,
  parseLead,
  sameCustomerProperty,
  type LeadInput,
} from '../domain';
import { ConflictError, ForbiddenError, ValidationError } from '../errors';
import { newId } from '../ids';
import { addActivity } from './activity';
import { audit } from './audit';
import { managerIds, notifyUsers } from './notify';
import { nextOrderNo, orderHref } from './orders';
import { SOURCE_KEY } from './reference';

/** Serialises lead intake so two concurrent leads for the same person cannot both create a customer. */
const INTAKE_LOCK = Prisma.sql`SELECT pg_advisory_xact_lock(760001::bigint)::text AS locked`;

export interface IngestOptions {
  sourceId: string;
  /** API callers must send externalId; CSV and manual entry need not. */
  requireExternalId: boolean;
  /** Historical import: no notifications, flagged as backfill, never auto-assigned. */
  backfill?: boolean;
  /** Validate and predict the outcome without writing anything. */
  dryRun?: boolean;
  /** Owner for newly created orders (manual entry). Overrides the default-owner rule. */
  ownerId?: string | null;
}

export type IngestStatus = 'created' | 'already_received' | 'duplicate';

export interface IngestItem {
  index: number;
  ok: boolean;
  status?: IngestStatus;
  /** CRM order id. Null for a dry run that would create a new order. */
  id?: string | null;
  orderNo?: string | null;
  error?: string;
}

export interface IngestSummary {
  received: number;
  created: number;
  alreadyReceived: number;
  duplicates: number;
  failed: number;
  results: IngestItem[];
}

interface Outcome {
  status: IngestStatus;
  id: string | null;
  orderNo: string | null;
  /** A new order was created and nobody owns it yet. */
  pooled: boolean;
}

/**
 * Processes a batch of raw leads from one source. Each lead is validated and handled in its own
 * transaction, so a bad row never affects its neighbours. Returns one result per input row.
 */
export async function ingestLeads(ctx: Ctx, rawLeads: unknown[], opts: IngestOptions): Promise<IngestSummary> {
  const source = await ctx.db.leadSource.findUnique({ where: { id: opts.sourceId } });
  if (!source || !source.isActive) throw new ValidationError('This lead source does not exist or is switched off.');

  const now = nowOf(ctx);
  const summary: IngestSummary = { received: rawLeads.length, created: 0, alreadyReceived: 0, duplicates: 0, failed: 0, results: [] };
  let pooled = 0;

  for (const [index, raw] of rawLeads.entries()) {
    const parsed = parseLead(raw, { requireExternalId: opts.requireExternalId, now });
    if (!parsed.ok) {
      summary.failed++;
      summary.results.push({ index, ok: false, error: parsed.error });
      continue;
    }
    const outcome = await inTx(ctx.db, async (tx) => {
      await tx.$queryRaw(INTAKE_LOCK);
      return ingestOne(tx, ctx, parsed.lead, source, opts);
    });
    if (outcome.status === 'created') summary.created++;
    else if (outcome.status === 'duplicate') summary.duplicates++;
    else summary.alreadyReceived++;
    if (outcome.pooled) pooled++;
    summary.results.push({ index, ok: true, status: outcome.status, id: outcome.id, orderNo: outcome.orderNo });
  }

  if (pooled > 0 && !opts.dryRun && !opts.backfill) {
    await notifyUsers(ctx.db, ctx, await managerIds(ctx.db), {
      type: 'pool.new_leads',
      title: pooled === 1 ? 'A new lead is waiting to be assigned' : `${pooled} new leads are waiting to be assigned`,
      body: `Source: ${source.name}`,
      href: '/orders/unassigned',
    });
  }
  return summary;
}

interface CustomerMatch {
  customerId: string | null;
  /** A different customer matched by the other identifier (phone and email disagree). */
  otherCustomerId: string | null;
}

/** Identifies the customer by phone or email. Phone wins when the two point at different people. */
export async function matchCustomer(db: DbOrTx, phoneNormalized: string, email: string | undefined): Promise<CustomerMatch> {
  const byPhone = await db.customerPhone.findMany({
    where: { normalized: phoneNormalized },
    select: { customerId: true },
    orderBy: { customer: { createdAt: 'desc' } },
    take: 20,
  });
  const byEmail = email
    ? await db.customerEmail.findMany({
        where: { email },
        select: { customerId: true },
        orderBy: { customer: { createdAt: 'desc' } },
        take: 20,
      })
    : [];
  const phoneIds = byPhone.map((r) => r.customerId);
  const emailIds = byEmail.map((r) => r.customerId);
  const both = phoneIds.find((id) => emailIds.includes(id));
  if (both) return { customerId: both, otherCustomerId: null };
  if (phoneIds[0]) return { customerId: phoneIds[0], otherCustomerId: emailIds[0] ?? null };
  return { customerId: emailIds[0] ?? null, otherCustomerId: null };
}

function leadAddress(lead: LeadInput) {
  return { line1: lead.address ?? '', suburb: lead.suburb ?? '', postcode: lead.postcode ?? '' };
}

async function ingestOne(tx: Tx, ctx: Ctx, lead: LeadInput, source: LeadSource, opts: IngestOptions): Promise<Outcome> {
  const now = nowOf(ctx);
  const dryRun = !!opts.dryRun;

  // 1. Idempotency: the same external id from the same source is never processed twice.
  if (lead.externalId) {
    const receipt = await tx.leadReceipt.findUnique({
      where: { sourceId_externalId: { sourceId: source.id, externalId: lead.externalId } },
      select: { order: { select: { id: true, orderNo: true } } },
    });
    if (receipt) return { status: 'already_received', id: receipt.order.id, orderNo: receipt.order.orderNo, pooled: false };
  }

  // 2. Who is this?
  const phone = normalizePhone(lead.phone);
  const match = await matchCustomer(tx, phone.normalized, lead.email);
  const address = leadAddress(lead);
  const hasAddress = normalizeAddressLine(address.line1) !== '';
  const name = fullName({ firstName: lead.firstName, lastName: lead.lastName });

  let customerId = match.customerId;
  let propertyId: string | null = null;
  let fillAddressOnPropertyId: string | null = null;
  let defaultOwnerId: string | null = null;
  let possibleDuplicateOfId: string | null = null;

  if (customerId) {
    const properties = await tx.property.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' } });
    const orders = await tx.order.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        orderNo: true,
        propertyId: true,
        stage: true,
        sideState: true,
        ownerId: true,
        owner: { select: { id: true, isActive: true, roles: true } },
      },
    });

    // 3. Which property?
    if (hasAddress) {
      const same = properties.find((p) => sameCustomerProperty({ line1: p.addressLine1, suburb: p.suburb, postcode: p.postcode }, address));
      if (same) propertyId = same.id;
      else if (properties.length === 1 && normalizeAddressLine(properties[0]!.addressLine1) === '') {
        // The only property on file has no address yet: this enquiry tells us what it is.
        propertyId = properties[0]!.id;
        fillAddressOnPropertyId = propertyId;
      }
    } else if (properties.length === 1) {
      propertyId = properties[0]!.id;
    }

    // 4. Is there an order in progress this enquiry belongs to?
    const open = orders.filter(isOpenOrder);
    const duplicateOf = hasAddress ? (propertyId ? open.find((o) => o.propertyId === propertyId) : undefined) : open[0];
    if (duplicateOf) {
      if (!dryRun) {
        await mergeContactInfo(tx, customerId, lead, phone.normalized);
        if (fillAddressOnPropertyId) await fillPropertyAddress(tx, fillAddressOnPropertyId, lead);
        await addActivity(tx, ctx, {
          customerId,
          orderId: duplicateOf.id,
          type: 'LEAD',
          summary: `Repeat enquiry received via ${source.name}`,
          payload: { lead, sourceKey: source.key },
          occurredAt: opts.backfill ? (lead.createdAt ?? now) : now,
        });
        await audit(tx, ctx, {
          action: 'lead.duplicate',
          entityType: 'Order',
          entityId: duplicateOf.id,
          orderId: duplicateOf.id,
          customerId,
          summary: `Repeat enquiry via ${source.name} merged into ${duplicateOf.orderNo}`,
          meta: { externalId: lead.externalId ?? null, sourceKey: source.key },
        });
        if (lead.externalId) {
          await tx.leadReceipt.create({
            data: {
              id: newId('rcp'),
              sourceId: source.id,
              externalId: lead.externalId,
              orderId: duplicateOf.id,
              status: 'DUPLICATE',
              payload: JSON.parse(JSON.stringify(lead)) as Prisma.InputJsonValue,
              receivedAt: now,
            },
          });
        }
        if (!opts.backfill) {
          const recipients = duplicateOf.ownerId ? [duplicateOf.ownerId] : await managerIds(tx);
          await notifyUsers(tx, ctx, recipients, {
            type: 'lead.duplicate',
            title: `Repeat enquiry from ${name}`,
            body: `${source.name} sent another enquiry for ${duplicateOf.orderNo}, which is already open. It has been added to the timeline.`,
            href: orderHref(duplicateOf.id),
            orderId: duplicateOf.id,
          });
        }
      }
      return { status: 'duplicate', id: duplicateOf.id, orderNo: duplicateOf.orderNo, pooled: false };
    }

    // 5. A new order for a known customer goes to whoever looked after them last, if still around.
    const last = orders[0];
    if (last?.owner && last.owner.isActive && last.owner.roles.includes('SALES')) defaultOwnerId = last.owner.id;

    // Phone and email pointed at two different customers: let a manager look at it.
    if (match.otherCustomerId) {
      const other = await tx.order.findFirst({ where: { customerId: match.otherCustomerId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
      possibleDuplicateOfId = other?.id ?? null;
    }
  } else {
    // 6. Nobody we know. Same address as someone else's property is flagged, never merged.
    const key = addressKey(address);
    if (key) {
      const sameAddress = await tx.order.findFirst({
        where: { property: { addressKey: key } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      possibleDuplicateOfId = sameAddress?.id ?? null;
    }
  }

  if (dryRun) return { status: 'created', id: null, orderNo: null, pooled: false };

  // 7. Create whatever is missing.
  if (!customerId) {
    customerId = newId('cus');
    await tx.customer.create({ data: { id: customerId, firstName: lead.firstName, lastName: lead.lastName ?? '', createdAt: now } });
    await tx.customerPhone.create({
      data: { id: newId('cph'), customerId, raw: lead.phone, normalized: phone.normalized, isPrimary: true, createdAt: now },
    });
    if (lead.email) {
      await tx.customerEmail.create({ data: { id: newId('cem'), customerId, email: lead.email, isPrimary: true, createdAt: now } });
    }
  } else {
    await mergeContactInfo(tx, customerId, lead, phone.normalized);
  }

  if (!propertyId) {
    propertyId = newId('prp');
    await tx.property.create({
      data: {
        id: propertyId,
        customerId,
        addressLine1: lead.address ?? '',
        suburb: lead.suburb ?? '',
        state: lead.state ?? '',
        postcode: lead.postcode ?? '',
        addressKey: addressKey(address),
        propertyType: lead.propertyType ?? '',
        createdAt: now,
      },
    });
  } else if (fillAddressOnPropertyId) {
    await fillPropertyAddress(tx, fillAddressOnPropertyId, lead);
  }

  const ownerId = opts.backfill ? null : opts.ownerId !== undefined ? opts.ownerId : defaultOwnerId;
  const orderId = newId('ord');
  const orderNo = await nextOrderNo(tx, now);
  const leadCreatedAt = lead.createdAt ?? now;
  await tx.order.create({
    data: {
      id: orderId,
      orderNo,
      customerId,
      propertyId,
      ownerId,
      assignedAt: ownerId ? now : null,
      sourceId: source.id,
      sourceDetail: lead.sourceDetail ?? '',
      externalLeadId: lead.externalId ?? null,
      leadDetails: leadDetailsOf(lead) as Prisma.InputJsonValue,
      attribution: (lead.attribution ?? {}) as Prisma.InputJsonValue,
      leadCreatedAt,
      isBackfill: !!opts.backfill,
      possibleDuplicateOfId,
      lastStaffActivityAt: now,
      createdAt: now,
    },
  });
  await addActivity(tx, ctx, {
    customerId,
    orderId,
    type: 'LEAD',
    summary: `Lead received via ${source.name}`,
    payload: { lead, sourceKey: source.key },
    occurredAt: opts.backfill ? leadCreatedAt : now,
  });
  await audit(tx, ctx, {
    action: 'order.create',
    entityType: 'Order',
    entityId: orderId,
    orderId,
    customerId,
    summary: `Created ${orderNo} for ${name} via ${source.name}`,
    after: { orderNo, customerId, propertyId, ownerId, source: source.key, externalId: lead.externalId ?? null, backfill: !!opts.backfill, possibleDuplicateOfId },
  });
  if (lead.externalId) {
    await tx.leadReceipt.create({
      data: {
        id: newId('rcp'),
        sourceId: source.id,
        externalId: lead.externalId,
        orderId,
        status: 'CREATED',
        payload: JSON.parse(JSON.stringify(lead)) as Prisma.InputJsonValue,
        receivedAt: now,
      },
    });
  }
  if (ownerId && !opts.backfill) {
    await notifyUsers(tx, ctx, [ownerId], {
      type: 'order.assigned',
      title: match.customerId ? `New enquiry from a returning customer: ${name}` : `New lead assigned to you: ${name}`,
      body: `${orderNo} via ${source.name}`,
      href: orderHref(orderId),
      orderId,
    });
  }
  return { status: 'created', id: orderId, orderNo, pooled: !ownerId && !opts.backfill };
}

/** Adds a phone number or email the customer has not used with us before. */
async function mergeContactInfo(tx: Tx, customerId: string, lead: LeadInput, phoneNormalized: string): Promise<void> {
  const hasPhone = await tx.customerPhone.findFirst({ where: { customerId, normalized: phoneNormalized }, select: { id: true } });
  if (!hasPhone) {
    const any = await tx.customerPhone.count({ where: { customerId } });
    await tx.customerPhone.create({
      data: { id: newId('cph'), customerId, raw: lead.phone, normalized: phoneNormalized, isPrimary: any === 0 },
    });
  }
  if (lead.email) {
    const hasEmail = await tx.customerEmail.findFirst({ where: { customerId, email: lead.email }, select: { id: true } });
    if (!hasEmail) {
      const any = await tx.customerEmail.count({ where: { customerId } });
      await tx.customerEmail.create({ data: { id: newId('cem'), customerId, email: lead.email, isPrimary: any === 0 } });
    }
  }
}

async function fillPropertyAddress(tx: Tx, propertyId: string, lead: LeadInput): Promise<void> {
  const p = await tx.property.findUniqueOrThrow({ where: { id: propertyId } });
  await tx.property.update({
    where: { id: propertyId },
    data: {
      addressLine1: lead.address ?? '',
      suburb: lead.suburb || p.suburb,
      state: lead.state || p.state,
      postcode: lead.postcode || p.postcode,
      propertyType: p.propertyType || lead.propertyType || '',
      addressKey: addressKey({ line1: lead.address ?? '', suburb: lead.suburb || p.suburb, postcode: lead.postcode || p.postcode }),
    },
  });
}

// ---------------------------------------------------------------------------
// Manual entry
// ---------------------------------------------------------------------------

export type DuplicateHint =
  /** Nobody we know. */
  | { level: 'none' }
  /** The actor already has an open order for this contact. */
  | { level: 'own'; orderId: string; orderNo: string }
  /** A customer of the actor's without an open order: a new order will be added under them. */
  | { level: 'returning'; customerName: string }
  /** The contact exists but is not the actor's. Deliberately carries no details. */
  | { level: 'other' }
  /** Full details, for managers only. */
  | {
      level: 'match';
      customerName: string;
      orders: { id: string; orderNo: string; stage: string; sideState: string; ownerName: string | null; address: string; open: boolean }[];
    };

export interface DuplicateProbe {
  phone?: string;
  email?: string;
}

/**
 * Looks up whether a contact already exists, for the "possible duplicate" hint while typing.
 * A salesperson never learns anything about a customer who is not theirs.
 */
export async function checkLeadDuplicate(ctx: Ctx, probe: DuplicateProbe): Promise<DuplicateHint> {
  if (ctx.actor.kind !== 'user' || !can(ctx.actor, 'orders.create')) throw new ForbiddenError();
  const actor = ctx.actor;
  const phone = probe.phone && normalizePhone(probe.phone).valid ? normalizePhone(probe.phone).normalized : null;
  const email = probe.email?.trim().toLowerCase() || undefined;
  if (!phone && !email) return { level: 'none' };

  const match = phone ? await matchCustomer(ctx.db, phone, email) : { customerId: (await ctx.db.customerEmail.findFirst({ where: { email }, select: { customerId: true }, orderBy: { customer: { createdAt: 'desc' } } }))?.customerId ?? null, otherCustomerId: null };
  if (!match.customerId) return { level: 'none' };

  const customer = await ctx.db.customer.findUniqueOrThrow({
    where: { id: match.customerId },
    select: {
      firstName: true,
      lastName: true,
      orders: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderNo: true,
          stage: true,
          sideState: true,
          ownerId: true,
          owner: { select: { name: true } },
          property: { select: { addressLine1: true, suburb: true, state: true, postcode: true } },
        },
      },
    },
  });

  if (isManager(actor)) {
    return {
      level: 'match',
      customerName: fullName(customer),
      orders: customer.orders.map((o) => ({
        id: o.id,
        orderNo: o.orderNo,
        stage: o.stage,
        sideState: o.sideState,
        ownerName: o.owner?.name ?? null,
        address: [o.property.addressLine1, o.property.suburb, o.property.state, o.property.postcode].filter(Boolean).join(' '),
        open: isOpenOrder(o),
      })),
    };
  }

  // The most recent order decides whose customer this is.
  const latest = customer.orders[0];
  if (!latest || latest.ownerId !== actor.id) return { level: 'other' };
  const ownOpen = customer.orders.find((o) => o.ownerId === actor.id && isOpenOrder(o));
  if (ownOpen) return { level: 'own', orderId: ownOpen.id, orderNo: ownOpen.orderNo };
  return { level: 'returning', customerName: fullName(customer) };
}

/** Raised when manual entry is refused because the contact already exists. */
export class DuplicateLeadError extends ConflictError {
  constructor(
    message: string,
    /** Only set when the existing order belongs to the actor. */
    readonly orderId?: string,
  ) {
    super(message);
  }
}

export interface ManualLeadResult {
  status: IngestStatus;
  orderId: string;
  orderNo: string;
}

/**
 * Creates a lead typed in by a salesperson or manager. A salesperson becomes the owner of what
 * they enter; a manager may pick an owner or leave it to the default rules.
 */
export async function createLeadManually(ctx: Ctx, raw: Record<string, unknown>, opts: { ownerId?: string | null } = {}): Promise<ManualLeadResult> {
  if (ctx.actor.kind !== 'user' || !can(ctx.actor, 'orders.create')) throw new ForbiddenError();
  const actor = ctx.actor;
  const parsed = parseLead(raw, { requireExternalId: false, now: nowOf(ctx) });
  if (!parsed.ok) {
    const [field, ...rest] = parsed.error.split(': ');
    const message = rest.join(': ');
    throw new ValidationError('Please correct the highlighted fields.', { [field!]: message.charAt(0).toUpperCase() + message.slice(1) });
  }

  let ownerId: string | null | undefined;
  if (isManager(actor)) {
    ownerId = opts.ownerId === undefined ? undefined : opts.ownerId;
    if (ownerId) await requireAssignableUser(ctx.db, ownerId);
  } else {
    const hint = await checkLeadDuplicate(ctx, { phone: parsed.lead.phone, email: parsed.lead.email });
    if (hint.level === 'other') {
      throw new DuplicateLeadError('This contact already exists in the CRM and is not assigned to you. Please ask your manager.');
    }
    if (hint.level === 'own') {
      throw new DuplicateLeadError(`You already have an open order for this contact: ${hint.orderNo}.`, hint.orderId);
    }
    ownerId = actor.id;
  }

  const source = await ctx.db.leadSource.findUniqueOrThrow({ where: { key: SOURCE_KEY.manual } });
  const summary = await ingestLeads(ctx, [raw], { sourceId: source.id, requireExternalId: false, ownerId });
  const item = summary.results[0]!;
  if (!item.ok || !item.id || !item.orderNo) throw new ValidationError(item.error ?? 'The lead could not be saved.');
  return { status: item.status!, orderId: item.id, orderNo: item.orderNo };
}

/** Orders can only be given to active users who hold the sales role. */
export async function requireAssignableUser(db: DbOrTx, userId: string): Promise<{ id: string; name: string }> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, isActive: true, roles: true } });
  if (!user || !user.isActive || !user.roles.includes('SALES')) {
    throw new ValidationError('Orders can only be assigned to an active salesperson.', { ownerId: 'Choose an active salesperson.' });
  }
  return { id: user.id, name: user.name };
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

const CSV_HEADERS: Record<string, string> = {
  externalid: 'externalId',
  id: 'externalId',
  leadid: 'externalId',
  createdat: 'createdAt',
  created: 'createdAt',
  date: 'createdAt',
  sourcedetail: 'sourceDetail',
  firstname: 'firstName',
  first: 'firstName',
  name: 'firstName',
  lastname: 'lastName',
  surname: 'lastName',
  last: 'lastName',
  phone: 'phone',
  mobile: 'phone',
  phonenumber: 'phone',
  email: 'email',
  emailaddress: 'email',
  address: 'address',
  street: 'address',
  streetaddress: 'address',
  suburb: 'suburb',
  city: 'suburb',
  state: 'state',
  postcode: 'postcode',
  zip: 'postcode',
  postalcode: 'postcode',
  propertytype: 'propertyType',
  components: 'components',
  interestedin: 'components',
  systemkw: 'systemKw',
  batterykwh: 'batteryKwh',
  monthlybill: 'monthlyBill',
  timeline: 'timeline',
  besttime: 'bestTime',
  notes: 'notes',
  comments: 'notes',
  householdsize: 'householdSize',
  goals: 'goals',
  productpreference: 'productPreference',
};

export const CSV_MAX_ROWS = 2000;

/** Column names accepted in an import file, for the downloadable template. */
export const CSV_TEMPLATE_HEADERS = [
  'externalId',
  'createdAt',
  'firstName',
  'lastName',
  'phone',
  'email',
  'address',
  'suburb',
  'state',
  'postcode',
  'propertyType',
  'components',
  'systemKw',
  'batteryKwh',
  'monthlyBill',
  'timeline',
  'bestTime',
  'notes',
];

export interface ParsedCsv {
  /** One raw lead object per data row, ready for ingestLeads. */
  leads: Record<string, unknown>[];
  /** Header cells that were not recognised and are therefore ignored. */
  ignoredColumns: string[];
}

/** Parses an uploaded CSV into raw lead objects. Header names are matched loosely. */
export function parseLeadCsv(text: string): ParsedCsv {
  let records: Record<string, string>[];
  try {
    records = parseCsv(text, { columns: true, bom: true, skip_empty_lines: true, trim: true, relax_column_count: true }) as Record<string, string>[];
  } catch (e) {
    throw new ValidationError(`The file could not be read as CSV: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
  if (records.length === 0) throw new ValidationError('The file has no data rows.');
  if (records.length > CSV_MAX_ROWS) throw new ValidationError(`The file has more than ${CSV_MAX_ROWS} rows. Split it into smaller files.`);

  const headers = Object.keys(records[0]!);
  const mapping = new Map<string, string>();
  const ignored: string[] = [];
  for (const h of headers) {
    const field = CSV_HEADERS[h.toLowerCase().replace(/[^a-z]/g, '')];
    if (field && ![...mapping.values()].includes(field)) mapping.set(h, field);
    else ignored.push(h);
  }
  if (![...mapping.values()].includes('firstName') || ![...mapping.values()].includes('phone')) {
    throw new ValidationError('The file needs at least a "firstName" column and a "phone" column.');
  }

  const leads = records.map((record) => {
    const lead: Record<string, unknown> = {};
    for (const [header, field] of mapping) {
      const value = (record[header] ?? '').trim();
      if (!value) continue;
      lead[field] = field === 'components' ? value.split(/[;|,]/).map((s) => s.trim()).filter(Boolean) : value;
    }
    return lead;
  });
  return { leads, ignoredColumns: ignored };
}

export interface CsvImportOptions {
  sourceId: string;
  dryRun: boolean;
  backfill: boolean;
}

/** Imports (or previews) a parsed CSV. Managers only. */
export async function importLeadCsv(ctx: Ctx, text: string, opts: CsvImportOptions): Promise<IngestSummary & { ignoredColumns: string[] }> {
  if (ctx.actor.kind !== 'user' || !can(ctx.actor, 'leads.import')) throw new ForbiddenError();
  const parsed = parseLeadCsv(text);
  const summary = await ingestLeads(ctx, parsed.leads, {
    sourceId: opts.sourceId,
    requireExternalId: false,
    dryRun: opts.dryRun,
    backfill: opts.backfill,
  });
  if (!opts.dryRun) {
    await audit(ctx.db, ctx, {
      action: 'lead.import',
      entityType: 'LeadSource',
      entityId: opts.sourceId,
      summary: `Imported CSV: ${summary.created} created, ${summary.duplicates} merged, ${summary.alreadyReceived} already received, ${summary.failed} failed`,
      meta: { rows: summary.received, backfill: opts.backfill, ignoredColumns: parsed.ignoredColumns },
    });
  }
  return { ...summary, ignoredColumns: parsed.ignoredColumns };
}

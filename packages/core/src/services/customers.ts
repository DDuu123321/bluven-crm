// Editing the customer and the property behind an order.
import type { Tx } from '@bluven/db';
import { inTx, nowOf, type Ctx } from '../context';
import { AU_STATES, PROPERTY_TYPES, addressKey, formatAddress, isManager, normalizeEmail, normalizePhone } from '../domain';
import { FieldErrors } from '../errors';
import { newId } from '../ids';
import { addActivity } from './activity';
import { audit, diff } from './audit';
import { lockOrderForEdit } from './orders';

export interface UpdateCustomerInput {
  orderId: string;
  firstName: string;
  lastName: string;
  notes: string;
  /** In order of preference: the first one is the primary contact. */
  phones: string[];
  emails: string[];
}

/** More than this is a data-entry accident, or an attempt to collect other people's numbers. */
const MAX_CONTACT_POINTS = 6;

export async function updateCustomer(ctx: Ctx, input: UpdateCustomerInput): Promise<void> {
  const errors = new FieldErrors();
  const firstName = input.firstName.trim();
  if (!firstName) errors.add('firstName', 'Enter the first name.');
  if (firstName.length > 100) errors.add('firstName', 'Use at most 100 characters.');
  const lastName = input.lastName.trim().slice(0, 100);

  const phones: { raw: string; normalized: string }[] = [];
  for (const [i, value] of input.phones.map((p) => p.trim()).filter(Boolean).entries()) {
    const n = normalizePhone(value);
    if (!n.valid) errors.add(`phones.${i}`, `“${value}” is not a valid phone number.`);
    else if (!phones.some((p) => p.normalized === n.normalized)) phones.push({ raw: value, normalized: n.normalized });
  }
  if (phones.length === 0 && !errors.any) errors.add('phones.0', 'At least one phone number is needed.');
  if (phones.length > MAX_CONTACT_POINTS) errors.add(`phones.${MAX_CONTACT_POINTS}`, `A customer can have at most ${MAX_CONTACT_POINTS} phone numbers.`);

  const emails: string[] = [];
  for (const [i, value] of input.emails.map((e) => e.trim()).filter(Boolean).entries()) {
    const n = normalizeEmail(value);
    if (!n) errors.add(`emails.${i}`, `“${value}” is not a valid email address.`);
    else if (!emails.includes(n)) emails.push(n);
  }
  if (emails.length > MAX_CONTACT_POINTS) errors.add(`emails.${MAX_CONTACT_POINTS}`, `A customer can have at most ${MAX_CONTACT_POINTS} email addresses.`);
  errors.throwIfAny();

  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForEdit(tx, ctx, input.orderId);
    const customer = await tx.customer.findUniqueOrThrow({
      where: { id: order.customerId },
      include: { phones: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] }, emails: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } },
    });

    // Enquiries are matched to customers by phone and email. A salesperson therefore cannot put
    // a number or address on their customer that is already on file for someone else: it would
    // be a way to draw that person's future enquiries to themselves. A manager, who sees both
    // customers, can decide that two records really share a contact.
    if (ctx.actor.kind === 'user' && !isManager(ctx.actor)) {
      const taken = new FieldErrors();
      const had = { phones: new Set(customer.phones.map((p) => p.normalized)), emails: new Set(customer.emails.map((e) => e.email)) };
      for (const [i, p] of phones.entries()) {
        if (had.phones.has(p.normalized)) continue;
        if (await tx.customerPhone.findFirst({ where: { normalized: p.normalized, customerId: { not: customer.id } }, select: { id: true } })) {
          taken.add(`phones.${i}`, 'This number is already on file for another customer. Ask a manager to add it if it really is shared.');
        }
      }
      for (const [i, e] of emails.entries()) {
        if (had.emails.has(e)) continue;
        if (await tx.customerEmail.findFirst({ where: { email: e, customerId: { not: customer.id } }, select: { id: true } })) {
          taken.add(`emails.${i}`, 'This address is already on file for another customer. Ask a manager to add it if it really is shared.');
        }
      }
      taken.throwIfAny();
    }
    const before = { firstName: customer.firstName, lastName: customer.lastName, notes: customer.notes, phones: customer.phones.map((p) => p.raw), emails: customer.emails.map((e) => e.email) };
    const after = { firstName, lastName, notes: input.notes.trim().slice(0, 5000), phones: phones.map((p) => p.raw), emails };
    const change = diff(before, after);
    if (!change) return;

    await tx.customer.update({ where: { id: customer.id }, data: { firstName, lastName, notes: after.notes } });
    await syncPhones(tx, customer.id, phones);
    await syncEmails(tx, customer.id, emails);
    await audit(tx, ctx, {
      action: 'customer.update',
      entityType: 'Customer',
      entityId: customer.id,
      orderId: order.id,
      customerId: customer.id,
      summary: `${order.orderNo}: updated customer details`,
      ...change,
    });
  });
}

async function syncPhones(tx: Tx, customerId: string, phones: { raw: string; normalized: string }[]): Promise<void> {
  const existing = await tx.customerPhone.findMany({ where: { customerId } });
  const keep = new Set(phones.map((p) => p.normalized));
  await tx.customerPhone.deleteMany({ where: { customerId, normalized: { notIn: [...keep] } } });
  for (const [i, p] of phones.entries()) {
    const row = existing.find((e) => e.normalized === p.normalized);
    if (row) await tx.customerPhone.update({ where: { id: row.id }, data: { raw: p.raw, isPrimary: i === 0 } });
    else await tx.customerPhone.create({ data: { id: newId('cph'), customerId, raw: p.raw, normalized: p.normalized, isPrimary: i === 0 } });
  }
}

async function syncEmails(tx: Tx, customerId: string, emails: string[]): Promise<void> {
  const existing = await tx.customerEmail.findMany({ where: { customerId } });
  await tx.customerEmail.deleteMany({ where: { customerId, email: { notIn: emails } } });
  for (const [i, email] of emails.entries()) {
    const row = existing.find((e) => e.email === email);
    if (row) await tx.customerEmail.update({ where: { id: row.id }, data: { isPrimary: i === 0 } });
    else await tx.customerEmail.create({ data: { id: newId('cem'), customerId, email, isPrimary: i === 0 } });
  }
}

export interface PropertyFields {
  addressLine1: string;
  addressLine2: string;
  suburb: string;
  state: string;
  postcode: string;
  propertyType: string;
  nmi: string;
  retailer: string;
  phase: string;
  roofType: string;
  storeys: string;
  notes: string;
}

export const PHASES = ['Single phase', 'Two phase', 'Three phase'] as const;

function cleanProperty(input: PropertyFields, errors: FieldErrors): PropertyFields {
  const f: PropertyFields = {
    addressLine1: input.addressLine1.trim().slice(0, 200),
    addressLine2: input.addressLine2.trim().slice(0, 200),
    suburb: input.suburb.trim().slice(0, 100),
    state: input.state.trim().toUpperCase(),
    postcode: input.postcode.trim(),
    propertyType: input.propertyType.trim(),
    nmi: input.nmi.replace(/\s+/g, '').toUpperCase().slice(0, 20),
    retailer: input.retailer.trim().slice(0, 100),
    phase: input.phase.trim(),
    roofType: input.roofType.trim().slice(0, 100),
    storeys: input.storeys.trim().slice(0, 50),
    notes: input.notes.trim().slice(0, 5000),
  };
  if (f.state && !(AU_STATES as readonly string[]).includes(f.state)) errors.add('state', 'Choose a state.');
  if (f.postcode && !/^\d{4}$/.test(f.postcode)) errors.add('postcode', 'Enter a 4-digit postcode.');
  if (f.propertyType && !(PROPERTY_TYPES as readonly string[]).includes(f.propertyType)) errors.add('propertyType', 'Choose a property type.');
  if (f.phase && !(PHASES as readonly string[]).includes(f.phase)) errors.add('phase', 'Choose the supply phase.');
  if (f.nmi && !/^[A-Z0-9]{10,11}$/.test(f.nmi)) errors.add('nmi', 'An NMI has 10 or 11 letters and digits.');
  return f;
}

/** Edits the property the order is for. The property is shared by every order at that address. */
export async function updateProperty(ctx: Ctx, input: { orderId: string } & PropertyFields): Promise<void> {
  const errors = new FieldErrors();
  const f = cleanProperty(input, errors);
  errors.throwIfAny();
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForEdit(tx, ctx, input.orderId);
    const property = await tx.property.findUniqueOrThrow({ where: { id: order.propertyId } });
    const change = diff(property as unknown as Record<string, unknown>, f as unknown as Record<string, unknown>);
    if (!change) return;
    await tx.property.update({
      where: { id: property.id },
      data: { ...f, addressKey: addressKey({ line1: f.addressLine1, suburb: f.suburb, postcode: f.postcode }) },
    });
    await audit(tx, ctx, {
      action: 'property.update',
      entityType: 'Property',
      entityId: property.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: updated property details`,
      ...change,
    });
  });
}

/**
 * Points the order at a different, newly entered property of the same customer. For the case
 * where an enquiry was attached to the customer's existing address but is really for another one.
 */
export async function moveOrderToNewProperty(ctx: Ctx, input: { orderId: string } & Pick<PropertyFields, 'addressLine1' | 'addressLine2' | 'suburb' | 'state' | 'postcode' | 'propertyType'>): Promise<void> {
  const errors = new FieldErrors();
  const f = cleanProperty({ ...input, nmi: '', retailer: '', phase: '', roofType: '', storeys: '', notes: '' }, errors);
  if (!f.addressLine1) errors.add('addressLine1', 'Enter the street address.');
  errors.throwIfAny();
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForEdit(tx, ctx, input.orderId);
    const old = await tx.property.findUniqueOrThrow({ where: { id: order.propertyId } });
    const propertyId = newId('prp');
    await tx.property.create({
      data: {
        id: propertyId,
        customerId: order.customerId,
        addressLine1: f.addressLine1,
        addressLine2: f.addressLine2,
        suburb: f.suburb,
        state: f.state,
        postcode: f.postcode,
        propertyType: f.propertyType,
        addressKey: addressKey({ line1: f.addressLine1, suburb: f.suburb, postcode: f.postcode }),
        createdAt: nowOf(ctx),
      },
    });
    await tx.order.update({ where: { id: order.id }, data: { propertyId } });
    // Site photos uploaded under this order show the address this order is really for, so they
    // move with it. Photos taken over from an earlier order show the old address: they are set
    // aside instead, or the checklist would count pictures of the wrong house.
    const now = nowOf(ctx);
    const reused = await tx.document.updateMany({
      where: { orderId: order.id, propertyId: old.id, deletedAt: null, copiedFromId: { not: null } },
      data: { deletedAt: now, deletedById: ctx.actor.kind === 'user' ? ctx.actor.id : null },
    });
    await tx.document.updateMany({ where: { orderId: order.id, propertyId: old.id, copiedFromId: null }, data: { propertyId } });
    const summary = `Order moved to a different property: ${formatAddress(f)}`;
    await addActivity(tx, ctx, {
      customerId: order.customerId,
      orderId: order.id,
      type: 'SYSTEM',
      summary,
      body: reused.count > 0 ? `${reused.count} site photo${reused.count === 1 ? '' : 's'} reused from an earlier order at the old address ${reused.count === 1 ? 'was' : 'were'} removed from this order.` : '',
      payload: { from: old.id, to: propertyId, reusedPhotosRemoved: reused.count },
    });
    await audit(tx, ctx, {
      action: 'order.move_property',
      entityType: 'Order',
      entityId: order.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`,
      before: { propertyId: old.id, address: formatAddress(old) },
      after: { propertyId, address: formatAddress(f) },
    });
  });
}

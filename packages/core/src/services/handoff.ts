// Handoff to operations: checklist, push, accept, return.
import type { DbOrTx, Prisma, Tx } from '@bluven/db';
import { inTx, nowOf, type Ctx } from '../context';
import { STAGE_LABEL, can, formatAddress, formatCents, formatDateOnly, fullName } from '../domain';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { newId } from '../ids';
import { addActivity } from './activity';
import { audit } from './audit';
import { managerIds, notifyRoles, notifyUsers } from './notify';
import { lockOrder, lockOrderForEdit, lockOrderForStaff, loadOrderState, orderHref, syncOrderStage, touchStaffActivity } from './orders';
import { CURRENT_DOCUMENT } from './reference';

export interface ChecklistItem {
  /** Stable key: "address", "contract", "deposit" or "doc:<type key>". */
  key: string;
  label: string;
  ok: boolean;
  /** What is there, or what is missing. */
  detail: string;
  /** Set for document items, so the page can link to the right folder. */
  typeId?: string;
}

export interface Checklist {
  items: ChecklistItem[];
  complete: boolean;
}

/** Everything operations needs before an order can be pushed. Document items come from the configurable types. */
export async function getHandoffChecklist(db: DbOrTx, orderId: string): Promise<Checklist> {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      property: true,
      contracts: { where: { voidedAt: null }, select: { signedOn: true }, take: 1 },
      deposits: { where: { status: { in: ['PENDING', 'CONFIRMED'] } }, select: { status: true, amountCents: true, receivedAmountCents: true, receivedOn: true, currency: true } },
    },
  });
  const items: ChecklistItem[] = [];

  const p = order.property;
  const addressOk = [p.addressLine1, p.suburb, p.state, p.postcode].every((s) => s.trim() !== '');
  items.push({
    key: 'address',
    label: 'Installation address',
    ok: addressOk,
    detail: addressOk ? formatAddress(p) : 'Street, suburb, state and postcode are all needed.',
  });

  const contract = order.contracts[0];
  items.push({
    key: 'contract',
    label: 'Signed contract',
    ok: !!contract,
    detail: contract ? `Signed ${formatDateOnly(contract.signedOn)}` : 'Not archived yet.',
  });

  const confirmed = order.deposits.find((d) => d.status === 'CONFIRMED');
  const pending = order.deposits.find((d) => d.status === 'PENDING');
  items.push({
    key: 'deposit',
    label: 'Deposit confirmed by finance',
    ok: !!confirmed,
    detail: confirmed
      ? `${formatCents(confirmed.receivedAmountCents ?? confirmed.amountCents, confirmed.currency)} received ${formatDateOnly(confirmed.receivedOn)}`
      : pending
        ? 'Submitted. Waiting for finance to confirm.'
        : 'Not submitted yet.',
  });

  const requiredTypes = await db.documentType.findMany({
    where: { isActive: true, isRequiredForHandoff: true, isSystem: false },
    orderBy: { sortOrder: 'asc' },
  });
  if (requiredTypes.length > 0) {
    const counts = await db.document.groupBy({
      by: ['typeId'],
      where: { orderId, ...CURRENT_DOCUMENT, typeId: { in: requiredTypes.map((t) => t.id) } },
      _count: { _all: true },
    });
    const byType = new Map(counts.map((c) => [c.typeId, c._count._all]));
    for (const t of requiredTypes) {
      const n = byType.get(t.id) ?? 0;
      items.push({ key: `doc:${t.key}`, label: t.label, ok: n > 0, detail: n > 0 ? `${n} file${n === 1 ? '' : 's'}` : 'No file yet.', typeId: t.id });
    }
  }
  return { items, complete: items.every((i) => i.ok) };
}

/** What operations receives. Stored with the package so later edits do not rewrite history. */
export interface HandoffSnapshot {
  generatedAt: string;
  order: { id: string; orderNo: string; source: string; leadDetails: unknown; notes: string };
  owner: { id: string; name: string; email: string } | null;
  customer: { name: string; emails: string[]; phones: string[]; notes: string };
  property: {
    address: string;
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
  };
  quote: { version: number; title: string; dcWatts: number | null; storageWh: number | null; totalCents: number | null; depositCents: number | null; currency: string; documentId: string | null } | null;
  contract: { signedOn: string; documentId: string; source: string } | null;
  deposit: { amountCents: number; receivedAmountCents: number | null; receivedOn: string | null; method: string; bankReference: string; confirmedBy: string | null; confirmedAt: string | null; currency: string } | null;
  documents: { id: string; typeKey: string; typeLabel: string; fileName: string; sizeBytes: number; takenAt: string | null; uploadedAt: string; reused: boolean }[];
  checklist: ChecklistItem[];
}

async function buildSnapshot(tx: Tx, orderId: string, notes: string, now: Date): Promise<HandoffSnapshot> {
  const o = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      owner: { select: { id: true, name: true, email: true } },
      source: { select: { name: true } },
      customer: { include: { emails: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] }, phones: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } } },
      property: true,
      quotes: { where: { isAccepted: true }, take: 1 },
      contracts: { where: { voidedAt: null }, take: 1 },
      deposits: { where: { status: 'CONFIRMED' }, take: 1, include: { decidedBy: { select: { name: true } } } },
      documents: { where: CURRENT_DOCUMENT, include: { type: true }, orderBy: [{ type: { sortOrder: 'asc' } }, { createdAt: 'asc' }] },
    },
  });
  const q = o.quotes[0];
  const c = o.contracts[0];
  const d = o.deposits[0];
  const p = o.property;
  return {
    generatedAt: now.toISOString(),
    order: { id: o.id, orderNo: o.orderNo, source: o.source.name, leadDetails: o.leadDetails, notes },
    owner: o.owner,
    customer: { name: fullName(o.customer), emails: o.customer.emails.map((e) => e.email), phones: o.customer.phones.map((ph) => ph.raw), notes: o.customer.notes },
    property: {
      address: formatAddress(p),
      addressLine1: p.addressLine1,
      addressLine2: p.addressLine2,
      suburb: p.suburb,
      state: p.state,
      postcode: p.postcode,
      propertyType: p.propertyType,
      nmi: p.nmi,
      retailer: p.retailer,
      phase: p.phase,
      roofType: p.roofType,
      storeys: p.storeys,
      notes: p.notes,
    },
    quote: q ? { version: q.version, title: q.title, dcWatts: q.dcWatts, storageWh: q.storageWh, totalCents: q.totalCents, depositCents: q.depositCents, currency: q.currency, documentId: q.documentId } : null,
    contract: c ? { signedOn: c.signedOn.toISOString().slice(0, 10), documentId: c.documentId, source: c.source } : null,
    deposit: d
      ? {
          amountCents: d.amountCents,
          receivedAmountCents: d.receivedAmountCents,
          receivedOn: d.receivedOn ? d.receivedOn.toISOString().slice(0, 10) : null,
          method: d.method,
          bankReference: d.bankReference,
          confirmedBy: d.decidedBy?.name ?? null,
          confirmedAt: d.decidedAt?.toISOString() ?? null,
          currency: d.currency,
        }
      : null,
    documents: o.documents.map((doc) => ({
      id: doc.id,
      typeKey: doc.type.key,
      typeLabel: doc.type.label,
      fileName: doc.fileName,
      sizeBytes: doc.sizeBytes,
      takenAt: doc.takenAt?.toISOString() ?? null,
      uploadedAt: doc.createdAt.toISOString(),
      reused: doc.source === 'REUSED',
    })),
    checklist: (await getHandoffChecklist(tx, orderId)).items,
  };
}

/** Saves the notes sales wants operations to read. They travel with the next push. */
export async function updateHandoffNotes(ctx: Ctx, input: { orderId: string; notes: string }): Promise<void> {
  const notes = input.notes.trim().slice(0, 5000);
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForEdit(tx, ctx, input.orderId);
    const current = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { handoffNotes: true } });
    if (current.handoffNotes === notes) return;
    await tx.order.update({ where: { id: order.id }, data: { handoffNotes: notes } });
    await audit(tx, ctx, {
      action: 'order.handoff_notes',
      entityType: 'Order',
      entityId: order.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: updated notes for operations`,
      before: { handoffNotes: current.handoffNotes },
      after: { handoffNotes: notes },
    });
  });
}

/** Sends the order to operations. Requires a confirmed deposit and a complete checklist. */
export async function pushOrder(ctx: Ctx, input: { orderId: string; notes?: string }): Promise<{ version: number }> {
  return inTx(ctx.db, async (tx) => {
    const order = await lockOrderForStaff(tx, ctx, input.orderId);
    if (order.sideState === 'ON_HOLD') throw new ConflictError('Take the order off hold before pushing it to operations.');
    if (order.sideState !== 'NONE') throw new ConflictError(`This order is ${order.sideState === 'LOST' ? 'marked as lost' : 'cancelled'}.`);
    if (order.stage === 'PUSHED') throw new ConflictError('This order is already with operations.');
    if (order.stage === 'HANDED_OVER') throw new ConflictError('This order has already been handed over.');
    const checklist = await getHandoffChecklist(tx, order.id);
    if (!checklist.complete) {
      const missing = checklist.items.filter((i) => !i.ok).map((i) => i.label);
      throw new ValidationError(`Not ready to push yet. Still missing: ${missing.join(', ')}.`);
    }
    if (order.stage !== 'DEPOSIT_CONFIRMED' && order.stage !== 'RETURNED') {
      throw new ConflictError(`An order in stage “${STAGE_LABEL[order.stage]}” cannot be pushed.`);
    }

    const now = nowOf(ctx);
    const current = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { handoffNotes: true } });
    const notes = input.notes === undefined ? current.handoffNotes : input.notes.trim().slice(0, 5000);
    const last = await tx.handoffPackage.findFirst({ where: { orderId: order.id }, orderBy: { version: 'desc' }, select: { version: true } });
    const version = (last?.version ?? 0) + 1;
    const snapshot = await buildSnapshot(tx, order.id, notes, now);
    const id = newId('hof');
    await tx.handoffPackage.create({
      data: {
        id,
        orderId: order.id,
        version,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        notes,
        pushedById: ctx.actor.kind === 'user' ? ctx.actor.id : null,
        pushedAt: now,
      },
    });
    await tx.order.update({
      where: { id: order.id },
      data: { handoffNotes: notes, pushedAt: now, firstPushedAt: order.firstPushedAt ?? now },
    });
    const summary = version === 1 ? 'Pushed to operations' : `Pushed to operations again (submission ${version})`;
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'HANDOFF', summary, body: notes, payload: { handoffId: id, version } });
    await touchStaffActivity(tx, ctx, order);
    await syncOrderStage(tx, ctx, order.id);
    await audit(tx, ctx, {
      action: 'handoff.push',
      entityType: 'HandoffPackage',
      entityId: id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`,
      after: { version, notes, documents: snapshot.documents.length },
    });
    await notifyRoles(tx, ctx, ['OPS'], {
      type: 'handoff.pushed',
      title: version === 1 ? `New order ready: ${order.orderNo}` : `${order.orderNo} has been resubmitted`,
      body: `${snapshot.customer.name}, ${snapshot.property.address}`,
      href: `/ops/orders/${order.id}`,
      orderId: order.id,
    });
    return { version };
  });
}

function requireOps(ctx: Ctx) {
  if (ctx.actor.kind !== 'user' || !can(ctx.actor, 'ops.handoffs')) throw new ForbiddenError('Only operations can accept or return an order.');
  return ctx.actor;
}

async function lockPendingPackage(tx: Tx, orderId: string) {
  await lockOrder(tx, orderId);
  const order = await loadOrderState(tx, orderId);
  if (!order || !order.firstPushedAt) throw new NotFoundError('Order not found.');
  const pkg = await tx.handoffPackage.findFirst({ where: { orderId, decision: 'PENDING' } });
  if (!pkg) throw new ConflictError('This order is not waiting for a decision from operations.');
  return { order, pkg };
}

/** Operations takes the order on. This is where the sales side ends. */
export async function acceptHandoff(ctx: Ctx, input: { orderId: string }): Promise<void> {
  const actor = requireOps(ctx);
  await inTx(ctx.db, async (tx) => {
    const { order, pkg } = await lockPendingPackage(tx, input.orderId);
    const now = nowOf(ctx);
    await tx.handoffPackage.update({ where: { id: pkg.id }, data: { decision: 'ACCEPTED', decidedById: actor.id, decidedAt: now } });
    await tx.order.update({ where: { id: order.id }, data: { handedOverAt: now } });
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'HANDOFF', summary: 'Accepted by operations', payload: { handoffId: pkg.id } });
    await syncOrderStage(tx, ctx, order.id);
    await audit(tx, ctx, {
      action: 'handoff.accept',
      entityType: 'HandoffPackage',
      entityId: pkg.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: accepted by operations`,
      before: { decision: 'PENDING' },
      after: { decision: 'ACCEPTED' },
    });
    await notifyUsers(tx, ctx, [order.ownerId, ...(await managerIds(tx))], {
      type: 'handoff.accepted',
      title: `${order.orderNo} was accepted by operations`,
      href: orderHref(order.id),
      orderId: order.id,
    });
  });
}

/** Operations sends the order back with a reason. Sales fixes it and pushes again. */
export async function returnHandoff(ctx: Ctx, input: { orderId: string; reason: string; missing?: string[] }): Promise<void> {
  const actor = requireOps(ctx);
  const reason = input.reason.trim().slice(0, 2000);
  if (!reason) throw new ValidationError('Say what needs to be fixed.', { reason: 'Give a reason.' });
  await inTx(ctx.db, async (tx) => {
    const { order, pkg } = await lockPendingPackage(tx, input.orderId);
    const now = nowOf(ctx);
    const known = new Set((pkg.snapshot as unknown as HandoffSnapshot).checklist?.map((i) => i.key) ?? []);
    const missing = [...new Set(input.missing ?? [])].filter((k) => known.has(k));
    await tx.handoffPackage.update({
      where: { id: pkg.id },
      data: { decision: 'RETURNED', decidedById: actor.id, decidedAt: now, returnReason: reason, returnMissing: missing },
    });
    // The ball is back with sales: the idle clock starts now.
    await tx.order.update({
      where: { id: order.id },
      data: { returnedAt: now, returnCount: { increment: 1 }, lastStaffActivityAt: now, idleLevel: 0 },
    });
    await tx.task.create({
      data: {
        id: newId('tsk'),
        orderId: order.id,
        assigneeId: order.ownerId,
        title: 'Returned by operations: fix and push again',
        notes: reason,
        dueAt: now,
        kind: 'RETURNED',
        remindedAt: now,
        createdAt: now,
      },
    });
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'HANDOFF', summary: 'Returned by operations', body: reason, payload: { handoffId: pkg.id, missing } });
    await syncOrderStage(tx, ctx, order.id);
    await audit(tx, ctx, {
      action: 'handoff.return',
      entityType: 'HandoffPackage',
      entityId: pkg.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: returned by operations`,
      before: { decision: 'PENDING' },
      after: { decision: 'RETURNED', reason, missing },
    });
    await notifyUsers(tx, ctx, [order.ownerId, ...(await managerIds(tx))], {
      type: 'handoff.returned',
      title: `${order.orderNo} was returned by operations`,
      body: reason,
      href: orderHref(order.id),
      orderId: order.id,
    });
  });
}

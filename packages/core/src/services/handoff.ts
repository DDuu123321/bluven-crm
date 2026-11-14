// Handoff to operations: what has to be in the folder, the push, and operations accepting the
// order or, as the exception, sending it back.
import type { DbOrTx, Prisma, Tx } from '@bluven/db';
import { inTx, nowOf, type Ctx } from '../context';
import { STAGE_LABEL, can, formatAddress, formatCents, fullName, isWithOperations } from '../domain';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { newId } from '../ids';
import { addActivity } from './activity';
import { audit } from './audit';
import { confirmDepositReceived } from './deposits';
import { queueNotice } from './notices';
import { managerIds, notifyRoles, notifyUsers } from './notify';
import { lockOrder, lockOrderForStaff, lockOrderForWork, loadOrderState, orderHref, syncOrderStage, touchStaffActivity } from './orders';
import { CURRENT_DOCUMENT } from './reference';
import { completeSystemTasks } from './timeline';

export interface ChecklistItem {
  /** Stable key: "address", "quote", "deposit" or "doc:<type key>". */
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

/**
 * Everything that has to be on file before an order can be pushed: the address, the proposal the
 * customer accepted, the proof of the deposit, and a file in each folder that is marked as
 * required (out of the box the electricity bill, the photos of where the system goes and the
 * photos of the switchboard). Which folders are required is the managers' to set.
 */
export async function getHandoffChecklist(db: DbOrTx, orderId: string): Promise<Checklist> {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      property: true,
      quotes: { orderBy: { version: 'desc' }, select: { version: true, isAccepted: true, totalCents: true, currency: true, documentId: true, webProposalUrl: true } },
      deposits: { where: { status: { in: ['PENDING', 'CONFIRMED'] } }, orderBy: { submittedAt: 'desc' }, select: { status: true, amountCents: true, method: true, currency: true } },
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

  const accepted = order.quotes.find((q) => q.isAccepted);
  const acceptedHasFile = !!accepted && (!!accepted.documentId || !!accepted.webProposalUrl);
  items.push({
    key: 'quote',
    label: 'Proposal the customer accepted',
    ok: acceptedHasFile,
    detail: accepted
      ? acceptedHasFile
        ? `Version ${accepted.version}${accepted.totalCents !== null ? `, ${formatCents(accepted.totalCents, accepted.currency)}` : ''}`
        : `Version ${accepted.version} has no file yet. Attach the proposal as it went to the customer.`
      : order.quotes.length > 0
        ? 'Say which version the customer accepted.'
        : 'No quote on record yet.',
  });

  const deposit = order.deposits[0];
  items.push({
    key: 'deposit',
    label: 'Proof of the deposit',
    ok: !!deposit,
    detail: deposit
      ? `${formatCents(deposit.amountCents, deposit.currency)}, ${deposit.method === 'GATEWAY' ? 'paid through Pylon' : deposit.method === 'FINANCE' ? 'finance approval on file' : 'payment proof on file'}`
      : 'Not recorded yet.',
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
  /** A signed contract, where one was filed. It is not required. */
  contract: { signedOn: string; documentId: string; source: string } | null;
  /** The deposit as sales recorded it. That the money has arrived is confirmed by operations when they accept. */
  deposit: { amountCents: number; receivedAmountCents: number | null; receivedOn: string | null; method: string; bankReference: string; confirmedBy: string | null; confirmedAt: string | null; currency: string; note?: string } | null;
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
      deposits: { where: { status: { in: ['PENDING', 'CONFIRMED'] } }, orderBy: { submittedAt: 'desc' }, take: 1, include: { decidedBy: { select: { name: true } } } },
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
          note: d.note,
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
    const order = await lockOrderForWork(tx, ctx, input.orderId);
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

/** Sends the order to operations. Requires the deposit to be on record and the folder to be complete. */
export async function pushOrder(ctx: Ctx, input: { orderId: string; notes?: string }): Promise<{ version: number }> {
  return inTx(ctx.db, async (tx) => {
    const order = await lockOrderForStaff(tx, ctx, input.orderId);
    if (order.sideState === 'ON_HOLD') throw new ConflictError('Take the order off hold before pushing it to operations.');
    if (order.sideState !== 'NONE') throw new ConflictError(`This order is ${order.sideState === 'LOST' ? 'marked as lost' : 'cancelled'}.`);
    if (order.stage === 'PUSHED') throw new ConflictError('This order is already with operations.');
    if (isWithOperations(order.stage)) throw new ConflictError('Operations has already accepted this order.');
    const checklist = await getHandoffChecklist(tx, order.id);
    if (!checklist.complete) {
      const missing = checklist.items.filter((i) => !i.ok).map((i) => i.label);
      throw new ValidationError(`Not ready to push yet. Still missing: ${missing.join(', ')}.`);
    }
    if (order.stage !== 'DEPOSIT_PAID' && order.stage !== 'RETURNED') {
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
    // Pushing again is what the "returned by operations" task asked for.
    await completeSystemTasks(tx, ctx, order.id, ['RETURNED']);
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

/**
 * Operations takes the order on, and in doing so confirms that the deposit has arrived: they
 * are the ones who can see the account. The first time an order is accepted the customer gets
 * the welcome e-mail and the record operations works in is made; finance is told about the
 * deposit. This is where the sale is made.
 */
export async function acceptHandoff(ctx: Ctx, input: { orderId: string; depositReceived: boolean }): Promise<void> {
  const actor = requireOps(ctx);
  if (!input.depositReceived) {
    throw new ValidationError('Confirm that the deposit has arrived before you accept. If it has not, the order waits here, or goes back to sales.', {
      depositReceived: 'Check the account first.',
    });
  }
  await inTx(ctx.db, async (tx) => {
    await lockOrder(tx, input.orderId);
    const order = await loadOrderState(tx, input.orderId);
    if (!order || !order.firstPushedAt) throw new NotFoundError('Order not found.');
    if (order.sideState !== 'NONE') throw new ConflictError(`This order is ${order.sideState === 'CANCELLED' ? 'cancelled' : 'not active'}.`);
    const pkg = await tx.handoffPackage.findFirst({ where: { orderId: order.id, decision: 'PENDING' } });
    if (!pkg) throw new ConflictError('This order is not waiting for a decision from operations.');
    const now = nowOf(ctx);
    await tx.handoffPackage.update({ where: { id: pkg.id }, data: { decision: 'ACCEPTED', decidedById: actor.id, decidedAt: now } });
    await tx.order.update({ where: { id: order.id }, data: { handedOverAt: now } });
    const first = !(await tx.opsJob.findUnique({ where: { orderId: order.id }, select: { orderId: true } }));
    if (first) await tx.opsJob.create({ data: { orderId: order.id, createdAt: now, updatedById: actor.id } });
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'HANDOFF', summary: 'Accepted by operations', payload: { handoffId: pkg.id } });
    await confirmDepositReceived(tx, ctx, order);
    await completeSystemTasks(tx, ctx, order.id, ['RETURNED']);
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
      body: 'The deposit is confirmed. You can follow the installation on the order’s page.',
      href: orderHref(order.id),
      orderId: order.id,
    });
    // Once per order: a customer whose order came back and was accepted again has been welcomed.
    if (first) await queueNotice(tx, ctx, order.id, 'WELCOME');
  });
}

/**
 * Operations sends the order back to sales with a reason. This is for the cases operations
 * cannot settle themselves: the customer cannot be reached, or something needs the salesperson.
 * A file that is missing is asked for by operations directly. An order can come back before it
 * is accepted and after, until the installation is done.
 */
export async function returnHandoff(ctx: Ctx, input: { orderId: string; reason: string; missing?: string[] }): Promise<void> {
  const actor = requireOps(ctx);
  const reason = input.reason.trim().slice(0, 2000);
  if (!reason) throw new ValidationError('Say why sales is needed.', { reason: 'Give a reason.' });
  await inTx(ctx.db, async (tx) => {
    await lockOrder(tx, input.orderId);
    const order = await loadOrderState(tx, input.orderId);
    if (!order || !order.firstPushedAt) throw new NotFoundError('Order not found.');
    if (order.sideState !== 'NONE') throw new ConflictError(`This order is ${order.sideState === 'CANCELLED' ? 'cancelled' : 'not active'}.`);
    const pkg = await tx.handoffPackage.findFirst({ where: { orderId: order.id }, orderBy: { version: 'desc' } });
    const accepted = pkg?.decision === 'ACCEPTED';
    if (accepted && order.stage !== 'IN_PROGRESS') throw new ConflictError('The installation is done. This order can no longer go back to sales.');
    if (!pkg || (pkg.decision !== 'PENDING' && !accepted)) throw new ConflictError('This order is not with operations.');
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
        title: 'Returned by operations: sort it out and push again',
        notes: reason,
        dueAt: now,
        kind: 'RETURNED',
        remindedAt: now,
        createdAt: now,
      },
    });
    const summary = accepted ? 'Returned by operations after they had accepted it' : 'Returned by operations';
    await addActivity(tx, ctx, { customerId: order.customerId, orderId: order.id, type: 'HANDOFF', summary, body: reason, payload: { handoffId: pkg.id, missing } });
    await syncOrderStage(tx, ctx, order.id);
    await audit(tx, ctx, {
      action: 'handoff.return',
      entityType: 'HandoffPackage',
      entityId: pkg.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`,
      before: { decision: pkg.decision },
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

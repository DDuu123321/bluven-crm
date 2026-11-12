// Read models for the pages. Every query here applies the caller's visibility rules.
import { Prisma, type Db, type OrderStage, type SideState } from '@bluven/db';
import { inTx, nowOf, type Ctx, type UserActor } from '../context';
import { getConfig } from '../config';
import {
  FINANCE_VISIBLE_DOC_TYPES,
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_RULES,
  ORDER_STAGES,
  can,
  endOfLocalDay,
  hasRole,
  isIdleTrackedStage,
  isManager,
  normalizePhone,
  notificationKind,
  zonedTimeToUtc,
  type NotificationKind,
  type OrderView,
} from '../domain';
import { ForbiddenError, NotFoundError } from '../errors';
import { audit } from './audit';
import { requireOrderView } from './orders';
import { getHandoffChecklist, type Checklist } from './handoff';
import { CURRENT_DOCUMENT } from './reference';
import { getSettings } from './settings';

function user(ctx: Ctx): UserActor {
  if (ctx.actor.kind !== 'user') throw new ForbiddenError();
  return ctx.actor;
}

/** Orders the actor may see at all, in any view. */
export function visibleOrdersWhere(actor: UserActor): Prisma.OrderWhereInput {
  if (isManager(actor)) return {};
  const or: Prisma.OrderWhereInput[] = [];
  if (hasRole(actor, 'SALES')) or.push({ ownerId: actor.id });
  if (hasRole(actor, 'OPS')) or.push({ firstPushedAt: { not: null } });
  if (hasRole(actor, 'FINANCE')) or.push({ deposits: { some: {} } });
  return or.length > 0 ? { OR: or } : { id: '__nothing__' };
}

/** Orders the actor works on as sales staff: their own, or everything for managers. */
function pipelineWhere(actor: UserActor): Prisma.OrderWhereInput {
  if (isManager(actor)) return {};
  if (hasRole(actor, 'SALES')) return { ownerId: actor.id };
  return { id: '__nothing__' };
}

// ---------------------------------------------------------------------------
// Order lists
// ---------------------------------------------------------------------------

export const ORDER_VIEWS = ['active', 'on_hold', 'handed_over', 'lost', 'cancelled', 'all'] as const;
export type OrderListView = (typeof ORDER_VIEWS)[number];

export interface OrderListFilters {
  view?: OrderListView;
  stage?: OrderStage | null;
  /** A user id, or "unassigned". Managers only. */
  owner?: string | null;
  sourceId?: string | null;
  q?: string | null;
  /** Only orders that have triggered an idle reminder. */
  idleOnly?: boolean;
  page?: number;
  pageSize?: number;
}

const listSelect = {
  id: true,
  orderNo: true,
  stage: true,
  sideState: true,
  ownerId: true,
  isBackfill: true,
  idleLevel: true,
  returnCount: true,
  onHoldUntil: true,
  lastStaffActivityAt: true,
  leadCreatedAt: true,
  createdAt: true,
  possibleDuplicateOfId: true,
  duplicateDismissedAt: true,
  leadDetails: true,
  owner: { select: { id: true, name: true } },
  source: { select: { id: true, name: true } },
  customer: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phones: { orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }], take: 1, select: { raw: true } },
      emails: { orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }], take: 1, select: { email: true } },
    },
  },
  property: { select: { addressLine1: true, suburb: true, state: true, postcode: true } },
  tasks: { where: { status: 'OPEN' as const }, orderBy: { dueAt: 'asc' as const }, take: 1, select: { id: true, title: true, dueAt: true } },
} satisfies Prisma.OrderSelect;

export type OrderListRow = Prisma.OrderGetPayload<{ select: typeof listSelect }>;

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

function viewWhere(view: OrderListView): Prisma.OrderWhereInput {
  switch (view) {
    case 'active':
      return { sideState: 'NONE', stage: { not: 'HANDED_OVER' } };
    case 'on_hold':
      return { sideState: 'ON_HOLD' };
    case 'handed_over':
      return { stage: 'HANDED_OVER', sideState: { in: ['NONE', 'ON_HOLD'] } };
    case 'lost':
      return { sideState: 'LOST' };
    case 'cancelled':
      return { sideState: 'CANCELLED' };
    case 'all':
      return {};
  }
}

/**
 * Free-text search across order number, names, phone numbers, emails and address. Every word must
 * match something. A phone number may be typed the way it is shown, in groups ("0412 345 678",
 * "+61 412 345 678", "(02) 9123 4567"): each group of three or more digits is looked for inside the
 * stored numbers, and a stray country or area code is left out of the search.
 */
export function searchWhere(q: string): Prisma.OrderWhereInput {
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  const digitsOf = (word: string) => word.replace(/\D/g, '');
  const numeric = (word: string) => /^[+()\-.\d]+$/.test(word);
  const hasNumberPart = tokens.some((t) => numeric(t) && digitsOf(t).length >= 3);
  // "+61" or "(02)" in front of a number says nothing on its own.
  const words = tokens.filter((t) => !(hasNumberPart && numeric(t) && digitsOf(t).length < 3)).slice(0, 6);
  if (words.length === 0) return {};
  return {
    AND: words.map((word): Prisma.OrderWhereInput => {
      const contains = { contains: word, mode: 'insensitive' as const };
      const or: Prisma.OrderWhereInput[] = [
        { orderNo: contains },
        { customer: { firstName: contains } },
        { customer: { lastName: contains } },
        { customer: { emails: { some: { email: contains } } } },
        { property: { addressLine1: contains } },
        { property: { suburb: contains } },
        { property: { postcode: { startsWith: word } } },
      ];
      const digits = digitsOf(word);
      if (digits.length >= 3) {
        // Match however the number was typed: "0412..." finds "+61412...".
        const normalized = normalizePhone(word).normalized.replace(/^\+/, '');
        or.push({ customer: { phones: { some: { normalized: { contains: digits.replace(/^0/, '') } } } } });
        if (normalized !== digits) or.push({ customer: { phones: { some: { normalized: { contains: normalized } } } } });
      }
      return { OR: or };
    }),
  };
}

async function page<T>(db: Db, where: Prisma.OrderWhereInput, filters: OrderListFilters, orderBy: Prisma.OrderOrderByWithRelationInput[], map: (rows: OrderListRow[]) => T[]): Promise<Paged<T>> {
  const pageSize = Math.min(Math.max(filters.pageSize ?? 25, 1), 100);
  const total = await db.order.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(filters.page ?? 1, 1), pageCount);
  const rows = await db.order.findMany({ where, select: listSelect, orderBy, skip: (current - 1) * pageSize, take: pageSize });
  return { rows: map(rows), total, page: current, pageSize, pageCount };
}

/** The pipeline list: a salesperson's own orders, or every order for a manager. */
export async function listPipelineOrders(ctx: Ctx, filters: OrderListFilters): Promise<Paged<OrderListRow>> {
  const actor = user(ctx);
  if (!can(actor, 'orders.work')) throw new ForbiddenError();
  const and: Prisma.OrderWhereInput[] = [pipelineWhere(actor), viewWhere(filters.view ?? 'active')];
  if (filters.stage) and.push({ stage: filters.stage });
  if (filters.sourceId) and.push({ sourceId: filters.sourceId });
  if (filters.idleOnly) and.push({ idleLevel: { gt: 0 } });
  if (isManager(actor)) {
    if (filters.owner === 'unassigned') and.push({ ownerId: null });
    else if (filters.owner) and.push({ ownerId: filters.owner });
    else if ((filters.view ?? 'active') === 'active' && !filters.q) and.push({ ownerId: { not: null } }); // the pool has its own page
  }
  if (filters.q) and.push(searchWhere(filters.q));
  return page(ctx.db, { AND: and }, filters, [{ lastStaffActivityAt: 'desc' }, { id: 'desc' }], (r) => r);
}

/** How many of the actor's active orders sit in each stage, for the filter chips. */
export async function pipelineStageCounts(ctx: Ctx, owner?: string | null): Promise<Record<OrderStage, number>> {
  const actor = user(ctx);
  const and: Prisma.OrderWhereInput[] = [pipelineWhere(actor), viewWhere('active')];
  if (isManager(actor)) and.push(owner === 'unassigned' ? { ownerId: null } : owner ? { ownerId: owner } : { ownerId: { not: null } });
  const groups = await ctx.db.order.groupBy({ by: ['stage'], where: { AND: and }, _count: { _all: true } });
  const out = Object.fromEntries(ORDER_STAGES.map((s) => [s, 0])) as Record<OrderStage, number>;
  for (const g of groups) out[g.stage] = g._count._all;
  return out;
}

/** The unassigned pool. `history` shows backfilled leads instead of live ones. */
export async function listUnassignedOrders(ctx: Ctx, filters: OrderListFilters & { history?: boolean }): Promise<Paged<OrderListRow>> {
  const actor = user(ctx);
  if (!can(actor, 'orders.assign')) throw new ForbiddenError();
  const and: Prisma.OrderWhereInput[] = [{ ownerId: null, isBackfill: !!filters.history, sideState: { in: ['NONE', 'ON_HOLD'] }, stage: { not: 'HANDED_OVER' } }];
  if (filters.sourceId) and.push({ sourceId: filters.sourceId });
  if (filters.q) and.push(searchWhere(filters.q));
  return page(ctx.db, { AND: and }, filters, [{ leadCreatedAt: filters.history ? 'desc' : 'asc' }, { id: 'asc' }], (r) => r);
}

export async function unassignedCount(db: Db): Promise<number> {
  return db.order.count({ where: { ownerId: null, isBackfill: false, sideState: { in: ['NONE', 'ON_HOLD'] }, stage: { not: 'HANDED_OVER' } } });
}

/** Active salespeople, for assignment pickers. */
export async function listSalespeople(db: Db): Promise<{ id: string; name: string; openOrders: number }[]> {
  const users = await db.user.findMany({ where: { isActive: true, roles: { has: 'SALES' } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  const counts = await db.order.groupBy({
    by: ['ownerId'],
    where: { ownerId: { in: users.map((u) => u.id) }, sideState: { in: ['NONE', 'ON_HOLD'] }, stage: { not: 'HANDED_OVER' } },
    _count: { _all: true },
  });
  const byOwner = new Map(counts.map((c) => [c.ownerId, c._count._all]));
  return users.map((u) => ({ ...u, openOrders: byOwner.get(u.id) ?? 0 }));
}

// ---------------------------------------------------------------------------
// Order detail
// ---------------------------------------------------------------------------

const detailInclude = {
  owner: { select: { id: true, name: true, email: true } },
  source: { select: { id: true, name: true, key: true } },
  lostReason: { select: { label: true } },
  customer: {
    include: {
      phones: { orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }] },
      emails: { orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }] },
    },
  },
  property: true,
  possibleDuplicateOf: { select: { id: true, orderNo: true, customer: { select: { firstName: true, lastName: true } }, owner: { select: { name: true } } } },
} satisfies Prisma.OrderInclude;

export type OrderDetail = Prisma.OrderGetPayload<{ include: typeof detailInclude }>;

export interface OrderHeader {
  order: OrderDetail;
  view: OrderView;
  deposit: 'NONE' | 'PENDING' | 'CONFIRMED';
  /** Other orders of the same customer the actor may see. */
  siblings: { id: string; orderNo: string; stage: OrderStage; sideState: SideState; address: string }[];
}

/** The order with customer and property, plus what the actor is allowed to see of it. */
export async function getOrderHeader(ctx: Ctx, orderId: string): Promise<OrderHeader> {
  const actor = user(ctx);
  const { order: state, view } = await requireOrderView(ctx.db, ctx, orderId);
  let order = await ctx.db.order.findUniqueOrThrow({ where: { id: orderId }, include: detailInclude });
  // What leaves this function is already what the view allows; pages do not have to remember to hide things.
  // A possible duplicate names another customer and their salesperson: managers only.
  if (!isManager(actor)) order = { ...order, possibleDuplicateOf: null };
  // Finance works from the deposit pages. Here it gets enough to recognise the order, nothing more.
  if (view === 'FINANCE') {
    order = {
      ...order,
      customer: { ...order.customer, phones: [], emails: [], notes: '' },
      property: { ...order.property, nmi: '', retailer: '', phase: '', roofType: '', storeys: '', notes: '', fieldSources: {} },
      leadDetails: {},
      attribution: {},
      handoffNotes: '',
      lostNote: '',
      onHoldNote: '',
    };
  }
  const siblings =
    view === 'FULL'
      ? await ctx.db.order.findMany({
          where: { AND: [{ customerId: order.customerId, id: { not: order.id } }, visibleOrdersWhere(actor)] },
          select: { id: true, orderNo: true, stage: true, sideState: true, property: { select: { addressLine1: true, suburb: true } } },
          orderBy: { createdAt: 'desc' },
        })
      : [];
  return {
    order,
    view,
    deposit: state.deposit,
    siblings: siblings.map((s) => ({ id: s.id, orderNo: s.orderNo, stage: s.stage, sideState: s.sideState, address: [s.property.addressLine1, s.property.suburb].filter(Boolean).join(', ') })),
  };
}

const activityInclude = { actor: { select: { name: true } } } satisfies Prisma.ActivityInclude;
export type TimelineEntry = Prisma.ActivityGetPayload<{ include: typeof activityInclude }>;

/** Timeline of an order, newest first. Finance does not see the timeline. */
export async function getOrderTimeline(ctx: Ctx, orderId: string, limit = 200): Promise<TimelineEntry[]> {
  const { view } = await requireOrderView(ctx.db, ctx, orderId);
  if (view === 'FINANCE') return [];
  return ctx.db.activity.findMany({ where: { orderId }, include: activityInclude, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: limit });
}

export async function getOrderTasks(ctx: Ctx, orderId: string) {
  const { view } = await requireOrderView(ctx.db, ctx, orderId);
  if (view !== 'FULL') return [];
  return ctx.db.task.findMany({
    where: { orderId, status: { in: ['OPEN', 'DONE'] } },
    include: { assignee: { select: { name: true } } },
    orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
    take: 50,
  });
}

const documentInclude = {
  type: true,
  uploadedBy: { select: { name: true } },
  replaces: { select: { id: true, fileName: true, createdAt: true } },
} satisfies Prisma.DocumentInclude;
export type DocumentRow = Prisma.DocumentGetPayload<{ include: typeof documentInclude }>;

export interface OrderDocuments {
  types: { id: string; key: string; label: string; description: string; scope: string; isRequiredForHandoff: boolean; isSystem: boolean }[];
  documents: DocumentRow[];
  /**
   * Files of a removed contract or of a rejected or withdrawn deposit submission: kept on record,
   * no longer current. Operations only gets what is current.
   */
  superseded: DocumentRow[];
}

/** Current documents of an order (latest versions, not deleted), limited to what the view allows. */
export async function getOrderDocuments(ctx: Ctx, orderId: string): Promise<OrderDocuments> {
  const { view } = await requireOrderView(ctx.db, ctx, orderId);
  const typeFilter: Prisma.DocumentTypeWhereInput = view === 'FINANCE' ? { key: { in: [...FINANCE_VISIBLE_DOC_TYPES] } } : {};
  const types = await ctx.db.documentType.findMany({
    where: { AND: [typeFilter, { OR: [{ isActive: true }, { documents: { some: { orderId, deletedAt: null } } }] }] },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, key: true, label: true, description: true, scope: true, isRequiredForHandoff: true, isSystem: true },
  });
  const [documents, superseded] = await Promise.all([
    ctx.db.document.findMany({
      where: { orderId, ...CURRENT_DOCUMENT, type: typeFilter },
      include: documentInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    view === 'OPS'
      ? Promise.resolve([])
      : ctx.db.document.findMany({
          where: { orderId, deletedAt: null, supersededAt: { not: null }, type: typeFilter },
          include: documentInclude,
          orderBy: [{ supersededAt: 'desc' }, { id: 'desc' }],
        }),
  ]);
  return { types, documents, superseded };
}

export async function getOrderDeal(ctx: Ctx, orderId: string) {
  const { view } = await requireOrderView(ctx.db, ctx, orderId);
  const [quotes, contract, deposits, settings] = await Promise.all([
    ctx.db.quote.findMany({ where: { orderId }, include: { document: { select: { id: true, fileName: true } }, createdBy: { select: { name: true } } }, orderBy: { version: 'desc' } }),
    ctx.db.contract.findFirst({
      where: { orderId, voidedAt: null },
      include: { document: { select: { id: true, fileName: true, mimeType: true } }, quote: { select: { version: true } }, createdBy: { select: { name: true } } },
    }),
    ctx.db.deposit.findMany({
      where: { orderId },
      include: { proofDocument: { select: { id: true, fileName: true, mimeType: true } }, submittedBy: { select: { name: true } }, decidedBy: { select: { name: true } } },
      orderBy: { submittedAt: 'desc' },
    }),
    getSettings(ctx.db),
  ]);
  return { view, quotes, contract, deposits, defaultDepositPercent: settings.defaultDepositPercent };
}

export async function getOrderHandoff(ctx: Ctx, orderId: string): Promise<{ checklist: Checklist; packages: Prisma.HandoffPackageGetPayload<{ include: { pushedBy: { select: { name: true } }; decidedBy: { select: { name: true } } } }>[] }> {
  const { view } = await requireOrderView(ctx.db, ctx, orderId);
  // The package holds the whole order as operations receives it; finance has no part in it.
  if (view === 'FINANCE') throw new NotFoundError('Order not found.');
  const [checklist, packages] = await Promise.all([
    getHandoffChecklist(ctx.db, orderId),
    ctx.db.handoffPackage.findMany({
      where: { orderId },
      include: { pushedBy: { select: { name: true } }, decidedBy: { select: { name: true } } },
      orderBy: { version: 'desc' },
    }),
  ]);
  return { checklist, packages };
}

// ---------------------------------------------------------------------------
// Tasks and notifications
// ---------------------------------------------------------------------------

/** A task counts as the actor's only while they can still see its order (managers see every order). */
function myTasksWhere(actor: UserActor): Prisma.TaskWhereInput {
  return { assigneeId: actor.id, ...(isManager(actor) ? {} : { order: { ownerId: actor.id } }) };
}

export async function listMyTasks(ctx: Ctx, opts: { includeDone?: boolean } = {}) {
  const actor = user(ctx);
  return ctx.db.task.findMany({
    where: { ...myTasksWhere(actor), status: opts.includeDone ? { in: ['OPEN', 'DONE'] } : 'OPEN' },
    include: { order: { select: { id: true, orderNo: true, customer: { select: { firstName: true, lastName: true } } } } },
    orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
    take: 200,
  });
}

export async function openTaskCount(ctx: Ctx): Promise<{ open: number; overdue: number }> {
  const actor = user(ctx);
  const now = nowOf(ctx);
  const [open, overdue] = await Promise.all([
    ctx.db.task.count({ where: { ...myTasksWhere(actor), status: 'OPEN' } }),
    ctx.db.task.count({ where: { ...myTasksWhere(actor), status: 'OPEN', dueAt: { lte: now } } }),
  ]);
  return { open, overdue };
}

/** The database form of notificationKind(): which notification types make up one kind. */
export function notificationKindWhere(kind: NotificationKind): Prisma.NotificationWhereInput {
  const rules = Object.entries(NOTIFICATION_KIND_RULES) as [Exclude<NotificationKind, 'other'>, (typeof NOTIFICATION_KIND_RULES)[Exclude<NotificationKind, 'other'>]][];
  const named = rules.flatMap(([, r]) => [...r.types]);
  if (kind === 'other') {
    return { NOT: { OR: [{ type: { in: named } }, ...rules.flatMap(([, r]) => r.prefixes.map((prefix) => ({ type: { startsWith: prefix } })))] } };
  }
  const rule = NOTIFICATION_KIND_RULES[kind];
  // A type that another kind lists by name is that kind's, whatever its prefix says.
  const elsewhere = named.filter((type) => !rule.types.includes(type));
  return { OR: [{ type: { in: [...rule.types] } }, ...rule.prefixes.map((prefix) => ({ AND: [{ type: { startsWith: prefix } }, { type: { notIn: elsewhere } }] }))] };
}

export async function listNotifications(ctx: Ctx, opts: { unreadOnly?: boolean; take?: number; kind?: NotificationKind | null } = {}) {
  const actor = user(ctx);
  return ctx.db.notification.findMany({
    where: { userId: actor.id, ...(opts.unreadOnly ? { readAt: null } : {}), ...(opts.kind ? notificationKindWhere(opts.kind) : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: opts.take ?? 100,
  });
}

/** How many notifications the actor has of each kind, and how many of those are unread. Kinds without any are left out. */
export async function notificationKindCounts(ctx: Ctx): Promise<{ kind: NotificationKind; total: number; unread: number }[]> {
  const actor = user(ctx);
  const [all, unread] = await Promise.all([
    ctx.db.notification.groupBy({ by: ['type'], where: { userId: actor.id }, _count: { _all: true } }),
    ctx.db.notification.groupBy({ by: ['type'], where: { userId: actor.id, readAt: null }, _count: { _all: true } }),
  ]);
  const counts = new Map<NotificationKind, { total: number; unread: number }>();
  const bump = (type: string, field: 'total' | 'unread', n: number) => {
    const kind = notificationKind(type);
    const row = counts.get(kind) ?? { total: 0, unread: 0 };
    row[field] += n;
    counts.set(kind, row);
  };
  for (const g of all) bump(g.type, 'total', g._count._all);
  for (const g of unread) bump(g.type, 'unread', g._count._all);
  return NOTIFICATION_KINDS.filter((kind) => counts.has(kind)).map((kind) => ({ kind, ...counts.get(kind)! }));
}

/** Whether the actor gets one summary e-mail a day instead of an e-mail for every notification. */
export async function getDailySummary(ctx: Ctx): Promise<boolean> {
  return (await ctx.db.user.findUniqueOrThrow({ where: { id: user(ctx).id }, select: { dailySummary: true } })).dailySummary;
}

/**
 * Switches the actor's own daily summary on or off. Switching it off does not release a day's
 * worth of e-mails at once: what was waiting for the next summary stays in the CRM only.
 */
export async function setDailySummary(ctx: Ctx, on: boolean): Promise<void> {
  const actor = user(ctx);
  await inTx(ctx.db, async (tx) => {
    const before = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { dailySummary: true } });
    if (before.dailySummary === on) return;
    await tx.user.update({ where: { id: actor.id }, data: { dailySummary: on } });
    if (!on) await tx.notification.updateMany({ where: { userId: actor.id, emailStatus: 'PENDING' }, data: { emailStatus: 'SKIPPED' } });
    await audit(tx, ctx, { action: 'user.preference', entityType: 'User', entityId: actor.id, summary: `${actor.name} switched the daily summary e-mail ${on ? 'on' : 'off'}`, before: { dailySummary: before.dailySummary }, after: { dailySummary: on } });
  });
}

export async function unreadNotificationCount(ctx: Ctx): Promise<number> {
  return ctx.db.notification.count({ where: { userId: user(ctx).id, readAt: null } });
}

export async function markNotificationsRead(ctx: Ctx, ids: string[] | 'all'): Promise<number> {
  const actor = user(ctx);
  const { count } = await ctx.db.notification.updateMany({
    where: { userId: actor.id, readAt: null, ...(ids === 'all' ? {} : { id: { in: ids } }) },
    data: { readAt: nowOf(ctx) },
  });
  return count;
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

const depositInclude = {
  order: {
    select: {
      id: true,
      orderNo: true,
      stage: true,
      sideState: true,
      refundStatus: true,
      customer: { select: { firstName: true, lastName: true } },
      owner: { select: { name: true } },
      property: { select: { addressLine1: true, suburb: true, state: true, postcode: true } },
    },
  },
  proofDocument: { select: { id: true, fileName: true, mimeType: true } },
  submittedBy: { select: { name: true } },
  decidedBy: { select: { name: true } },
} satisfies Prisma.DepositInclude;
export type DepositRow = Prisma.DepositGetPayload<{ include: typeof depositInclude }>;

export async function listDeposits(ctx: Ctx, status: 'PENDING' | 'DECIDED'): Promise<DepositRow[]> {
  if (!can(user(ctx), 'finance.deposits')) throw new ForbiddenError();
  return ctx.db.deposit.findMany({
    where: { status: status === 'PENDING' ? 'PENDING' : { in: ['CONFIRMED', 'REJECTED'] } },
    include: depositInclude,
    orderBy: status === 'PENDING' ? [{ submittedAt: 'asc' }] : [{ decidedAt: 'desc' }],
    take: status === 'PENDING' ? 500 : 100,
  });
}

export async function getDeposit(ctx: Ctx, depositId: string): Promise<DepositRow> {
  if (!can(user(ctx), 'finance.deposits')) throw new ForbiddenError();
  const deposit = await ctx.db.deposit.findUnique({ where: { id: depositId }, include: depositInclude });
  if (!deposit) throw new NotFoundError('Deposit not found.');
  return deposit;
}

export async function pendingDepositCount(db: Db): Promise<number> {
  return db.deposit.count({ where: { status: 'PENDING' } });
}

/** Cancelled orders whose refund is still to be paid. */
export async function listPendingRefunds(ctx: Ctx) {
  if (!can(user(ctx), 'finance.deposits')) throw new ForbiddenError();
  return ctx.db.order.findMany({
    where: { sideState: 'CANCELLED', refundStatus: 'PENDING' },
    select: {
      id: true,
      orderNo: true,
      cancelledAt: true,
      cancelNote: true,
      customer: { select: { firstName: true, lastName: true } },
      deposits: { where: { status: { in: ['PENDING', 'CONFIRMED'] } }, select: { amountCents: true, receivedAmountCents: true, currency: true, status: true } },
    },
    orderBy: { cancelledAt: 'asc' },
  });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function listHandoffs(ctx: Ctx, decision: 'PENDING' | 'RETURNED' | 'ACCEPTED') {
  if (!can(user(ctx), 'ops.handoffs')) throw new ForbiddenError();
  const rows = await ctx.db.handoffPackage.findMany({
    where:
      decision === 'RETURNED'
        ? { decision: 'RETURNED', order: { stage: 'RETURNED', sideState: { in: ['NONE', 'ON_HOLD'] } } } // still waiting on sales
        : { decision },
    include: {
      order: { select: { id: true, orderNo: true, stage: true, sideState: true, returnCount: true, customer: { select: { firstName: true, lastName: true } }, property: { select: { addressLine1: true, suburb: true, state: true, postcode: true } }, owner: { select: { name: true } } } },
      pushedBy: { select: { name: true } },
      decidedBy: { select: { name: true } },
    },
    orderBy: decision === 'PENDING' ? [{ pushedAt: 'asc' }] : [{ decidedAt: 'desc' }],
    take: 200,
  });
  if (decision !== 'RETURNED') return rows;
  // An order that came back more than once is one order waiting on sales, shown with its latest return.
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.orderId) ? false : (seen.add(r.orderId), true)));
}

export async function pendingHandoffCount(db: Db): Promise<number> {
  return db.handoffPackage.count({ where: { decision: 'PENDING' } });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardRange {
  /** Inclusive start, "YYYY-MM-DD" in the business time zone. */
  from: string;
  /** Inclusive end. */
  to: string;
}

export interface Dashboard {
  range: DashboardRange;
  totals: { leads: number; signed: number; handedOver: number; lost: number; unassigned: number; pendingDeposits: number; returned: number; idle5: number; idle10: number };
  bySource: { sourceId: string; name: string; leads: number; contacted: number; quoted: number; signed: number; lost: number }[];
  bySalesperson: { userId: string; name: string; open: number; stages: Partial<Record<OrderStage, number>>; signedInRange: number; avgFirstResponseHours: number | null; idle: number }[];
  lostReasons: { label: string; count: number }[];
  weekly: { weekStart: string; leads: number; signed: number }[];
}

/**
 * Figures for the manager dashboard. A salesperson gets the same shape limited to their own orders.
 * "Signed" counts orders whose signing date falls in the range.
 */
export async function getDashboard(ctx: Ctx, range: DashboardRange): Promise<Dashboard> {
  const actor = user(ctx);
  if (!can(actor, 'orders.work')) throw new ForbiddenError();
  const tz = getConfig().timeZone;
  const start = zonedTimeToUtc(range.from, tz);
  const end = endOfLocalDay(range.to, tz);
  if (!start || !end) throw new NotFoundError('Invalid date range.');
  // Signing dates are date-only values.
  const signedFrom = new Date(`${range.from}T00:00:00Z`);
  const signedTo = new Date(`${range.to}T00:00:00Z`);
  const mine = isManager(actor) ? Prisma.sql`TRUE` : Prisma.sql`o."ownerId" = ${actor.id}`;
  const scope = pipelineWhere(actor);
  const db = ctx.db;
  const now = nowOf(ctx);
  const thresholds = (await getSettings(db)).idle;
  const idleStages = ORDER_STAGES.filter(isIdleTrackedStage);
  const idleWhere = (days: number): Prisma.OrderWhereInput => ({
    AND: [scope, { ownerId: { not: null }, sideState: 'NONE', stage: { in: idleStages }, lastStaffActivityAt: { lte: new Date(now.getTime() - days * 86_400_000) } }],
  });

  const [leads, signed, handedOver, lost, unassigned, pendingDeposits, returned, idle5, idle10] = await Promise.all([
    db.order.count({ where: { AND: [scope, { leadCreatedAt: { gte: start, lt: end } }] } }),
    db.order.count({ where: { AND: [scope, { signedAt: { gte: signedFrom, lte: signedTo } }] } }),
    db.order.count({ where: { AND: [scope, { handedOverAt: { gte: start, lt: end } }] } }),
    db.order.count({ where: { AND: [scope, { sideState: 'LOST', lostAt: { gte: start, lt: end } }] } }),
    isManager(actor) ? unassignedCount(db) : Promise.resolve(0),
    db.order.count({ where: { AND: [scope, { stage: 'DEPOSIT_PENDING', sideState: { in: ['NONE', 'ON_HOLD'] } }] } }),
    db.order.count({ where: { AND: [scope, { stage: 'RETURNED', sideState: 'NONE' }] } }),
    db.order.count({ where: idleWhere(thresholds.remindOwnerDays) }),
    db.order.count({ where: idleWhere(thresholds.remindManagerDays) }),
  ]);

  const bySource = await db.$queryRaw<Dashboard['bySource']>(Prisma.sql`
    SELECT s."id" AS "sourceId", s."name",
           COUNT(*)::int AS "leads",
           -- A funnel only narrows: an order that was quoted counts as contacted even if nobody logged the call.
           COUNT(*) FILTER (WHERE o."firstContactedAt" IS NOT NULL OR o."quotedAt" IS NOT NULL OR o."signedAt" IS NOT NULL)::int AS "contacted",
           COUNT(*) FILTER (WHERE o."quotedAt" IS NOT NULL OR o."signedAt" IS NOT NULL)::int AS "quoted",
           COUNT(*) FILTER (WHERE o."signedAt" IS NOT NULL)::int AS "signed",
           COUNT(*) FILTER (WHERE o."sideState" = 'LOST')::int AS "lost"
    FROM "Order" o JOIN "LeadSource" s ON s."id" = o."sourceId"
    WHERE o."leadCreatedAt" >= ${start} AND o."leadCreatedAt" < ${end} AND ${mine}
    GROUP BY s."id", s."name"
    ORDER BY COUNT(*) DESC, s."name"`);

  const people = isManager(actor)
    ? await db.user.findMany({ where: { OR: [{ isActive: true, roles: { has: 'SALES' } }, { ownedOrders: { some: { sideState: { in: ['NONE', 'ON_HOLD'] }, stage: { not: 'HANDED_OVER' } } } }] }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
    : [{ id: actor.id, name: actor.name }];
  const ids = people.map((p) => p.id);
  const [stageGroups, signedGroups, responseRows, idleGroups] = await Promise.all([
    db.order.groupBy({ by: ['ownerId', 'stage'], where: { ownerId: { in: ids }, sideState: { in: ['NONE', 'ON_HOLD'] }, stage: { not: 'HANDED_OVER' } }, _count: { _all: true } }),
    db.order.groupBy({ by: ['ownerId'], where: { ownerId: { in: ids }, signedAt: { gte: signedFrom, lte: signedTo } }, _count: { _all: true } }),
    ids.length
      ? db.$queryRaw<{ ownerId: string; hours: number }[]>(Prisma.sql`
          SELECT o."ownerId", AVG(EXTRACT(EPOCH FROM (o."firstContactedAt" - o."assignedAt")) / 3600)::float AS "hours"
          FROM "Order" o
          WHERE o."ownerId" IN (${Prisma.join(ids)}) AND o."assignedAt" >= ${start} AND o."assignedAt" < ${end}
            AND o."firstContactedAt" IS NOT NULL AND o."firstContactedAt" >= o."assignedAt"
          GROUP BY o."ownerId"`)
      : Promise.resolve([]),
    db.order.groupBy({ by: ['ownerId'], where: { ownerId: { in: ids }, idleLevel: { gt: 0 }, sideState: 'NONE' }, _count: { _all: true } }),
  ]);
  const bySalesperson = people.map((p) => {
    const stages: Partial<Record<OrderStage, number>> = {};
    let open = 0;
    for (const g of stageGroups) {
      if (g.ownerId !== p.id) continue;
      stages[g.stage] = g._count._all;
      open += g._count._all;
    }
    return {
      userId: p.id,
      name: p.name,
      open,
      stages,
      signedInRange: signedGroups.find((g) => g.ownerId === p.id)?._count._all ?? 0,
      avgFirstResponseHours: responseRows.find((r) => r.ownerId === p.id)?.hours ?? null,
      idle: idleGroups.find((g) => g.ownerId === p.id)?._count._all ?? 0,
    };
  });

  const lostReasons = await db.$queryRaw<Dashboard['lostReasons']>(Prisma.sql`
    SELECT COALESCE(r."label", 'No reason recorded') AS "label", COUNT(*)::int AS "count"
    FROM "Order" o LEFT JOIN "LostReason" r ON r."id" = o."lostReasonId"
    WHERE o."sideState" = 'LOST' AND o."lostAt" >= ${start} AND o."lostAt" < ${end} AND ${mine}
    GROUP BY 1 ORDER BY 2 DESC, 1`);

  // As text with its zone spelled out: a bare date parameter would be read in whatever time zone
  // the database session happens to use.
  const nowIso = now.toISOString();
  const weekly = await db.$queryRaw<Dashboard['weekly']>(Prisma.sql`
    WITH weeks AS (
      SELECT generate_series(date_trunc('week', (${nowIso}::timestamptz AT TIME ZONE ${tz})) - interval '7 weeks', date_trunc('week', (${nowIso}::timestamptz AT TIME ZONE ${tz})), interval '1 week') AS w
    )
    SELECT to_char(weeks.w, 'YYYY-MM-DD') AS "weekStart",
           (SELECT COUNT(*)::int FROM "Order" o WHERE ${mine} AND date_trunc('week', (o."leadCreatedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})) = weeks.w) AS "leads",
           (SELECT COUNT(*)::int FROM "Order" o WHERE ${mine} AND o."signedAt" IS NOT NULL AND date_trunc('week', o."signedAt") = weeks.w) AS "signed"
    FROM weeks ORDER BY weeks.w`);

  return { range, totals: { leads, signed, handedOver, lost, unassigned, pendingDeposits, returned, idle5, idle10 }, bySource, bySalesperson, lostReasons, weekly };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditFilters {
  actorId?: string | null;
  action?: string | null;
  entityType?: string | null;
  orderNo?: string | null;
  orderId?: string | null;
  q?: string | null;
  from?: string | null;
  to?: string | null;
  page?: number;
  pageSize?: number;
}

function auditWhere(filters: AuditFilters, orderIds: string[] | null): Prisma.AuditLogWhereInput {
  const tz = getConfig().timeZone;
  const and: Prisma.AuditLogWhereInput[] = [];
  if (filters.actorId === 'system') and.push({ actorId: null });
  else if (filters.actorId) and.push({ actorId: filters.actorId });
  if (filters.action) and.push({ action: { startsWith: filters.action } });
  if (filters.entityType) and.push({ entityType: filters.entityType });
  if (filters.orderId) and.push({ orderId: filters.orderId });
  if (orderIds) and.push({ orderId: { in: orderIds } });
  if (filters.q) and.push({ summary: { contains: filters.q, mode: 'insensitive' } });
  const from = filters.from ? zonedTimeToUtc(filters.from, tz) : null;
  const to = filters.to ? endOfLocalDay(filters.to, tz) : null;
  if (from) and.push({ at: { gte: from } });
  if (to) and.push({ at: { lt: to } });
  return { AND: and };
}

async function auditScope(ctx: Ctx, filters: AuditFilters): Promise<Prisma.AuditLogWhereInput> {
  if (!can(user(ctx), 'audit.view')) throw new ForbiddenError();
  let orderIds: string[] | null = null;
  if (filters.orderNo?.trim()) {
    const orders = await ctx.db.order.findMany({ where: { orderNo: { contains: filters.orderNo.trim(), mode: 'insensitive' } }, select: { id: true }, take: 50 });
    orderIds = orders.map((o) => o.id);
  }
  return auditWhere(filters, orderIds);
}

async function withOrderNos<T extends { orderId: string | null }>(db: Ctx['db'], rows: T[]): Promise<(T & { orderNo: string | null })[]> {
  const ids = [...new Set(rows.map((r) => r.orderId).filter((x): x is string => !!x))];
  const orderNos = new Map((await db.order.findMany({ where: { id: { in: ids } }, select: { id: true, orderNo: true } })).map((o) => [o.id, o.orderNo]));
  return rows.map((r) => ({ ...r, orderNo: r.orderId ? (orderNos.get(r.orderId) ?? null) : null }));
}

/** Searches the audit log. Managers and admins only. */
export async function searchAudit(ctx: Ctx, filters: AuditFilters) {
  const where = await auditScope(ctx, filters);
  const pageSize = Math.min(Math.max(filters.pageSize ?? 50, 1), 500);
  const total = await ctx.db.auditLog.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(filters.page ?? 1, 1), pageCount);
  const rows = await ctx.db.auditLog.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], skip: (current - 1) * pageSize, take: pageSize });
  return { rows: await withOrderNos(ctx.db, rows), total, page: current, pageSize, pageCount };
}

/** How many entries match, for telling the reader what an export will contain. */
export async function countAudit(ctx: Ctx, filters: AuditFilters): Promise<number> {
  return ctx.db.auditLog.count({ where: await auditScope(ctx, filters) });
}

/**
 * Walks the matching entries newest first, one page at a time, for exports. Only one page is
 * ever held in memory, and entries written while the walk is under way are not picked up, so no
 * row appears twice.
 */
export async function* iterateAudit(ctx: Ctx, filters: AuditFilters, pageSize = 1000) {
  const base = await auditScope(ctx, filters);
  let cursor: { at: Date; id: string } | null = null;
  for (;;) {
    const where: Prisma.AuditLogWhereInput = cursor ? { AND: [base, { OR: [{ at: { lt: cursor.at } }, { at: cursor.at, id: { lt: cursor.id } }] }] } : base;
    const rows = await ctx.db.auditLog.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: pageSize });
    if (rows.length === 0) return;
    yield await withOrderNos(ctx.db, rows);
    if (rows.length < pageSize) return;
    const last = rows[rows.length - 1]!;
    cursor = { at: last.at, id: last.id };
  }
}

/** Audit entries of one order, for the order's History tab. Managers and admins only. */
export async function getOrderAudit(ctx: Ctx, orderId: string, take = 300) {
  if (!can(user(ctx), 'audit.view')) throw new ForbiddenError();
  return ctx.db.auditLog.findMany({ where: { orderId }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take });
}

/** Distinct actions and entity types present in the log, for filter dropdowns. */
export async function auditFacets(ctx: Ctx): Promise<{ actions: string[]; entityTypes: string[]; actors: { id: string; name: string }[] }> {
  if (!can(user(ctx), 'audit.view')) throw new ForbiddenError();
  const [actions, entityTypes, actors] = await Promise.all([
    ctx.db.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
    ctx.db.auditLog.findMany({ distinct: ['entityType'], select: { entityType: true }, orderBy: { entityType: 'asc' } }),
    ctx.db.user.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  return { actions: actions.map((a) => a.action), entityTypes: entityTypes.map((e) => e.entityType), actors };
}

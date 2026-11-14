import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Form from 'next/form';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ORDER_STAGES,
  ORDER_VIEWS,
  STAGE_LABEL,
  can,
  formatAddress,
  fullName,
  getSettings,
  idleTier,
  isManager,
  isWithOperations,
  listPipelineOrders,
  listSalespeople,
  pipelineStageCounts,
  relativeTime,
  type OrderListView,
  type OrderStage,
} from '@bluven/core';
import { Badge, Card, EmptyState, Input, LinkButton, PageHeader, Pagination, Select, StageBadge, Table, Td, buttonClass, cx } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/fmt';
import { one, withParams } from '@/lib/params';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Orders' };

const VIEW_LABEL: Record<OrderListView, string> = {
  active: 'With sales',
  on_hold: 'On hold',
  operations: 'With operations',
  completed: 'Completed',
  lost: 'Lost',
  cancelled: 'Cancelled',
  all: 'Everything',
};

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, ctx } = await requireSession();
  // Finance and operations have lists of their own; this one is for the people who sell.
  if (!can(user, 'orders.work')) notFound();
  const sp = await searchParams;
  const manager = isManager(user);
  const view = (ORDER_VIEWS as readonly string[]).includes(one(sp.view) ?? '') ? (one(sp.view) as OrderListView) : 'active';
  const stage = (ORDER_STAGES as readonly string[]).includes(one(sp.stage) ?? '') ? (one(sp.stage) as OrderStage) : null;
  const owner = manager ? (one(sp.owner) ?? null) : null;
  const sourceId = one(sp.source) ?? null;
  const originId = one(sp.origin) ?? null;
  const q = one(sp.q) ?? '';
  // 1: past the day the salesperson is reminded. 2: past the day the managers are told. 3: past the day an order without a deposit goes back to the pool.
  const idle = (['1', '2', '3'].includes(one(sp.idle) ?? '') ? Number(one(sp.idle)) : null) as 1 | 2 | 3 | null;
  const idleOnly = idle !== null;
  const page = Number(one(sp.page) ?? '1') || 1;

  const [result, counts, salespeople, sources, origins, settings] = await Promise.all([
    listPipelineOrders(ctx, { view, stage, owner, sourceId, leadOriginId: originId, q, idle, page }),
    pipelineStageCounts(ctx, owner),
    manager ? listSalespeople(ctx.db) : Promise.resolve([]),
    ctx.db.leadSource.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ctx.db.leadOrigin.findMany({ orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }], select: { id: true, label: true, isActive: true } }),
    getSettings(ctx.db),
  ]);
  const base = {
    view: view === 'active' ? undefined : view,
    stage: stage ?? undefined,
    owner: owner ?? undefined,
    source: sourceId ?? undefined,
    origin: originId ?? undefined,
    q: q || undefined,
    idle: idle ? String(idle) : undefined,
  };
  const now = new Date();
  const idleFrom = [settings.idle.remindOwnerDays, settings.idle.remindManagerDays, settings.idle.returnToPoolDays] as const;

  return (
    <>
      <PageHeader
        title={manager ? 'All orders' : 'My orders'}
        description={manager ? 'Every order that has a salesperson, from the lead to the closed job. New leads waiting for a salesperson are under Unassigned leads.' : 'The leads and orders assigned to you, from the lead to the closed job.'}
        actions={
          <LinkButton href="/orders/new" variant="primary">
            New lead
          </LinkButton>
        }
      />

      <Card className="mb-4">
        <Form action="/orders" className="flex flex-wrap items-end gap-3 px-4 py-3">
          <div className="min-w-56 flex-1">
            <label htmlFor="q" className="mb-1 block text-xs font-medium text-slate-600">
              Search
            </label>
            <Input id="q" name="q" type="search" defaultValue={q} placeholder="Name, phone, email, address or order number" />
          </div>
          <div>
            <label htmlFor="view" className="mb-1 block text-xs font-medium text-slate-600">
              Show
            </label>
            <Select id="view" name="view" defaultValue={view}>
              {ORDER_VIEWS.map((v) => (
                <option key={v} value={v}>
                  {VIEW_LABEL[v]}
                </option>
              ))}
            </Select>
          </div>
          {manager && (
            <div>
              <label htmlFor="owner" className="mb-1 block text-xs font-medium text-slate-600">
                Salesperson
              </label>
              <Select id="owner" name="owner" defaultValue={owner ?? ''}>
                <option value="">Everyone</option>
                {salespeople.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.openOrders})
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div>
            <label htmlFor="origin" className="mb-1 block text-xs font-medium text-slate-600">
              Lead source
            </label>
            <Select id="origin" name="origin" defaultValue={originId ?? ''}>
              <option value="">Any</option>
              {origins.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                  {o.isActive ? '' : ' (no longer offered)'}
                </option>
              ))}
              <option value="none">Not recorded</option>
            </Select>
          </div>
          <div>
            <label htmlFor="source" className="mb-1 block text-xs font-medium text-slate-600">
              Came in through
            </label>
            <Select id="source" name="source" defaultValue={sourceId ?? ''}>
              <option value="">Any channel</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
          {stage && <input type="hidden" name="stage" value={stage} />}
          <button type="submit" className={buttonClass('secondary')}>
            Apply
          </button>
          {(q || owner || sourceId || originId || stage || idleOnly || view !== 'active') && (
            <Link href="/orders" className="pb-2 text-xs text-slate-500 hover:text-slate-800">
              Clear filters
            </Link>
          )}
        </Form>
        {view === 'active' && (
          <div className="flex flex-wrap gap-1.5 border-t border-slate-100 px-4 py-2.5">
            <Chip href={withParams('/orders', { ...base, stage: undefined, page: undefined })} active={!stage && !idleOnly}>
              All stages
            </Chip>
            {ORDER_STAGES.filter((s) => !isWithOperations(s)).map((s) => (
              <Chip key={s} href={withParams('/orders', { ...base, stage: s, idle: undefined, page: undefined })} active={stage === s} count={counts[s]}>
                {STAGE_LABEL[s]}
              </Chip>
            ))}
            <Chip href={withParams('/orders', { ...base, stage: undefined, idle: '1', page: undefined })} active={idle === 1} warn>
              Idle {idleFrom[0]}+ days
            </Chip>
            {idle !== null && idle > 1 && (
              <Chip href={withParams('/orders', { ...base, stage: undefined, idle: String(idle), page: undefined })} active warn>
                Idle {idleFrom[idle - 1]}+ days
              </Chip>
            )}
          </div>
        )}
      </Card>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyState title={q ? 'No orders match your search' : 'No orders here'}>
            {q ? 'Try fewer words, or search by phone number or order number.' : manager ? 'Assign leads from the Unassigned leads page to get started.' : 'Leads your manager assigns to you will appear here.'}
          </EmptyState>
        ) : (
          <>
            <Table head={['Order', 'Contact', 'Address', 'Stage', ...(manager ? ['Salesperson'] : []), 'Lead source', 'Last activity', 'Next task']}>
              {result.rows.map((o) => (
                <tr key={o.id} className="hover:bg-slate-50/60">
                  <Td>
                    <Link href={`/orders/${o.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                      {fullName(o.customer)}
                    </Link>
                    <div className="text-xs text-slate-500">{o.orderNo}</div>
                  </Td>
                  <Td className="text-slate-600">
                    <div>{o.customer.phones[0]?.raw}</div>
                    <div className="text-xs text-slate-500">{o.customer.emails[0]?.email}</div>
                  </Td>
                  <Td className="max-w-56 text-slate-600">{formatAddress(o.property) || <span className="text-slate-300">—</span>}</Td>
                  <Td>
                    <StageBadge stage={o.stage} sideState={o.sideState} />
                    {o.returnCount > 0 && !isWithOperations(o.stage) && <div className="mt-1 text-xs text-slate-500">Returned {o.returnCount}×</div>}
                    {o.sideState === 'ON_HOLD' && o.onHoldUntil && <div className="mt-1 text-xs text-slate-500">until {fmtDate(o.onHoldUntil)}</div>}
                  </Td>
                  {manager && <Td className="text-slate-600">{o.owner?.name ?? <Badge tone="amber">Unassigned</Badge>}</Td>}
                  <Td className="text-slate-600">
                    {o.leadOrigin?.label ?? <span className="text-slate-400">Not recorded</span>}
                    <div className="text-xs text-slate-500">via {o.source.name}</div>
                  </Td>
                  <Td className="text-slate-600">
                    <span title={fmtDateTime(o.lastStaffActivityAt)}>{relativeTime(o.lastStaffActivityAt, now)}</span>
                    {idleTier(o, now, settings.idle) > 0 && (
                      <div className="mt-1">
                        <Badge tone={idleTier(o, now, settings.idle) > 1 ? 'red' : 'amber'}>Idle</Badge>
                      </div>
                    )}
                  </Td>
                  <Td className="max-w-48 text-slate-600">
                    {o.tasks[0] ? (
                      <>
                        <div className="truncate">{o.tasks[0].title}</div>
                        <div className={cx('text-xs', o.tasks[0].dueAt <= now ? 'font-medium text-red-600' : 'text-slate-500')}>
                          {o.tasks[0].dueAt <= now ? 'Overdue' : 'Due'} {fmtDate(o.tasks[0].dueAt)}
                        </div>
                      </>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination page={result.page} pageCount={result.pageCount} total={result.total} hrefFor={(p) => withParams('/orders', { ...base, page: p > 1 ? String(p) : undefined })} />
          </>
        )}
      </Card>
    </>
  );
}

function Chip({ href, active, count, warn, children }: { href: string; active: boolean; count?: number; warn?: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
        active ? 'bg-brand-600 text-white ring-brand-600' : warn ? 'bg-white text-amber-700 ring-amber-200 hover:bg-amber-50' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50',
      )}
    >
      {children}
      {count !== undefined && <span className={cx('tabular-nums', active ? 'text-white/80' : 'text-slate-400')}>{count}</span>}
    </Link>
  );
}

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can, formatAddress, formatDateOnly, fullName, listHandoffs, listOpsJobs, opsJobCounts, relativeTime } from '@bluven/core';
import { Badge, Card, EmptyState, LinkButton, PageHeader, Table, Tabs, Td } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/fmt';
import { one } from '@/lib/params';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Operations' };

const TABS = ['incoming', 'jobs', 'installed', 'returned', 'closed'] as const;
type Tab = (typeof TABS)[number];

export default async function OpsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, ctx } = await requireSession();
  if (!can(user, 'ops.handoffs')) notFound();
  const sp = await searchParams;
  const requested = one(sp.tab) as Tab | undefined;
  const tab: Tab = requested && TABS.includes(requested) ? requested : 'incoming';
  const [incoming, returned, counts] = await Promise.all([listHandoffs(ctx, 'PENDING'), listHandoffs(ctx, 'RETURNED'), opsJobCounts(ctx.db)]);
  const jobs = tab === 'jobs' ? await listOpsJobs(ctx, 'IN_PROGRESS') : tab === 'installed' ? await listOpsJobs(ctx, 'INSTALLED') : tab === 'closed' ? await listOpsJobs(ctx, 'COMPLETED') : [];
  const handoffs = tab === 'incoming' ? incoming : tab === 'returned' ? returned : [];
  const now = new Date();

  return (
    <>
      <PageHeader
        title="Operations"
        description="Orders arrive here when sales pushes them. Accepting one confirms that the deposit is in the account, welcomes the customer and makes the job yours until the final payment has arrived."
      />
      <Tabs
        current={tab}
        tabs={[
          { key: 'incoming', label: 'To accept', href: '/ops', count: incoming.length },
          { key: 'jobs', label: 'Being arranged', href: '/ops?tab=jobs', count: counts.inProgress },
          { key: 'installed', label: 'Installed, balance due', href: '/ops?tab=installed', count: counts.installed },
          { key: 'returned', label: 'Back with sales', href: '/ops?tab=returned', count: returned.length },
          { key: 'closed', label: 'Closed', href: '/ops?tab=closed' },
        ]}
      />

      {(tab === 'incoming' || tab === 'returned') && (
        <Card>
          {handoffs.length === 0 ? (
            <EmptyState title={tab === 'incoming' ? 'Nothing is waiting' : 'Nothing is with sales'}>{tab === 'incoming' && 'You are notified as soon as sales pushes an order.'}</EmptyState>
          ) : (
            <Table head={['Order', 'Customer', 'Address', 'Salesperson', tab === 'incoming' ? 'Pushed' : 'Sent back', '']}>
              {handoffs.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50/60">
                  <Td>
                    <span className="font-medium text-slate-900">{p.order.orderNo}</span>
                    {p.version > 1 && (
                      <div className="mt-0.5">
                        <Badge tone="blue">Submission {p.version}</Badge>
                      </div>
                    )}
                  </Td>
                  <Td className="text-slate-900">{fullName(p.order.customer)}</Td>
                  <Td className="max-w-64 text-slate-600">{formatAddress(p.order.property)}</Td>
                  <Td className="text-slate-600">{p.order.owner?.name ?? p.pushedBy?.name}</Td>
                  <Td className="text-slate-600">
                    <span title={fmtDateTime(tab === 'incoming' ? p.pushedAt : p.decidedAt)}>{relativeTime((tab === 'incoming' ? p.pushedAt : p.decidedAt) ?? p.pushedAt, now)}</span>
                    {tab === 'returned' && p.decidedBy && <div className="text-xs text-slate-500">by {p.decidedBy.name}</div>}
                  </Td>
                  <Td className="text-right">
                    <LinkButton href={`/ops/orders/${p.order.id}`} size="sm" variant={tab === 'incoming' ? 'primary' : 'secondary'}>
                      {tab === 'incoming' ? 'Review' : 'Open'}
                    </LinkButton>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'jobs' && (
        <Card>
          {jobs.length === 0 ? (
            <EmptyState title="No jobs are being arranged">Accepted orders stay here until the installation is done.</EmptyState>
          ) : (
            <Table head={['Order', 'Customer', 'Salesperson', 'Installation', 'Still open', '']}>
              {jobs.map((j) => (
                <tr key={j.orderId} className="hover:bg-slate-50/60">
                  <Td className="font-medium text-slate-900">{j.orderNo}</Td>
                  <Td>
                    <div className="text-slate-900">{j.customerName}</div>
                    <div className="max-w-64 text-xs text-slate-500">{j.address}</div>
                  </Td>
                  <Td className="text-slate-600">{j.salesperson}</Td>
                  <Td className="text-slate-700">{j.installDate ? formatDateOnly(j.installDate) : <span className="text-slate-400">Not booked</span>}</Td>
                  <Td className="max-w-72 text-slate-600">
                    {j.openItems.length === 0 ? (
                      <Badge tone="green">All settled</Badge>
                    ) : (
                      <>
                        <span className="tabular-nums text-slate-900">
                          {j.itemsDone} of {j.itemsTotal} settled
                        </span>
                        <div className="text-xs text-slate-500">{j.openItems.join(', ')}</div>
                      </>
                    )}
                  </Td>
                  <Td className="text-right">
                    <LinkButton href={`/ops/orders/${j.orderId}`} size="sm">
                      Open
                    </LinkButton>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'installed' && (
        <Card>
          {jobs.length === 0 ? (
            <EmptyState title="No job is waiting for its balance">A job comes here when you mark it as done, and leaves when the final payment has arrived.</EmptyState>
          ) : (
            <Table head={['Order', 'Customer', 'Salesperson', 'Job done', 'Balance asked for by', 'Rebate', '']}>
              {jobs.map((j) => (
                <tr key={j.orderId} className="hover:bg-slate-50/60">
                  <Td className="font-medium text-slate-900">{j.orderNo}</Td>
                  <Td>
                    <div className="text-slate-900">{j.customerName}</div>
                    <div className="max-w-64 text-xs text-slate-500">{j.address}</div>
                  </Td>
                  <Td className="text-slate-600">{j.salesperson}</Td>
                  <Td className="text-slate-700">{fmtDate(j.jobDoneAt)}</Td>
                  <Td className="text-slate-700">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {formatDateOnly(j.balanceDueOn)}
                      {j.balanceOverdue && <Badge tone="red">Overdue</Badge>}
                    </div>
                    {j.chaseAskedAt && <div className="text-xs text-slate-500">Sales asked to chase {fmtDate(j.chaseAskedAt)}</div>}
                  </Td>
                  <Td>{j.rebateApplied ? <Badge tone="green">Applied for</Badge> : j.rebateOverdue ? <Badge tone="amber">Apply now</Badge> : <Badge>Not yet</Badge>}</Td>
                  <Td className="text-right">
                    <LinkButton href={`/ops/orders/${j.orderId}`} size="sm">
                      Open
                    </LinkButton>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'closed' && (
        <Card>
          {jobs.length === 0 ? (
            <EmptyState title="No closed jobs yet" />
          ) : (
            <Table head={['Order', 'Customer', 'Salesperson', 'Job done', 'Closed', 'Rebate', '']}>
              {jobs.map((j) => (
                <tr key={j.orderId} className="hover:bg-slate-50/60">
                  <Td className="font-medium text-slate-900">{j.orderNo}</Td>
                  <Td>
                    <div className="text-slate-900">{j.customerName}</div>
                    <div className="max-w-64 text-xs text-slate-500">{j.address}</div>
                  </Td>
                  <Td className="text-slate-600">{j.salesperson}</Td>
                  <Td className="text-slate-700">{fmtDate(j.jobDoneAt)}</Td>
                  <Td className="text-slate-700">{fmtDate(j.completedAt)}</Td>
                  <Td>{j.rebateApplied ? <Badge tone="green">Applied for</Badge> : <Badge tone="amber">Not applied for</Badge>}</Td>
                  <Td className="text-right">
                    <LinkButton href={`/ops/orders/${j.orderId}`} size="sm">
                      Open
                    </LinkButton>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
    </>
  );
}

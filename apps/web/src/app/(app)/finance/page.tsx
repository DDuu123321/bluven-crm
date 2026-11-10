import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DEPOSIT_METHOD_LABEL, can, formatAddress, formatCents, formatDateOnly, fullName, listDeposits, listPendingRefunds, relativeTime } from '@bluven/core';
import { ActionButton } from '@/components/client';
import { Badge, Card, EmptyState, LinkButton, PageHeader, Table, Tabs, Td } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/fmt';
import { one } from '@/lib/params';
import { requireSession } from '@/lib/session';
import { markRefundedAction } from './actions';

export const metadata: Metadata = { title: 'Deposits' };

export default async function FinancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, ctx } = await requireSession();
  if (!can(user, 'finance.deposits')) notFound();
  const sp = await searchParams;
  const tab = one(sp.tab) === 'decided' ? 'decided' : one(sp.tab) === 'refunds' ? 'refunds' : 'waiting';
  const [pending, refunds] = await Promise.all([listDeposits(ctx, 'PENDING'), listPendingRefunds(ctx)]);
  const decided = tab === 'decided' ? await listDeposits(ctx, 'DECIDED') : [];
  const now = new Date();

  return (
    <>
      <PageHeader title="Deposits" description="Sales submits proof that a deposit was paid. Confirm it once the money is in the account, or reject it with a reason. An order cannot go to operations until its deposit is confirmed." />
      <Tabs
        current={tab}
        tabs={[
          { key: 'waiting', label: 'Waiting for you', href: '/finance', count: pending.length },
          { key: 'decided', label: 'Decided', href: '/finance?tab=decided' },
          { key: 'refunds', label: 'Refunds to pay', href: '/finance?tab=refunds', count: refunds.length },
        ]}
      />

      {tab === 'waiting' && (
        <Card>
          {pending.length === 0 ? (
            <EmptyState title="Nothing is waiting">New submissions appear here and you are notified.</EmptyState>
          ) : (
            <Table head={['Order', 'Customer', 'Amount', 'Paid by', 'Submitted', '']}>
              {pending.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50/60">
                  <Td className="font-medium text-slate-900">{d.order.orderNo}</Td>
                  <Td>
                    <div className="text-slate-900">{fullName(d.order.customer)}</div>
                    <div className="text-xs text-slate-500">{formatAddress(d.order.property)}</div>
                  </Td>
                  <Td className="font-medium tabular-nums text-slate-900">{formatCents(d.amountCents, d.currency)}</Td>
                  <Td className="text-slate-600">{DEPOSIT_METHOD_LABEL[d.method]}</Td>
                  <Td className="text-slate-600">
                    <span title={fmtDateTime(d.submittedAt)}>{relativeTime(d.submittedAt, now)}</span>
                    <div className="text-xs text-slate-500">{d.submittedBy?.name ?? (d.method === 'GATEWAY' ? 'Pylon' : '')}</div>
                  </Td>
                  <Td className="text-right">
                    <LinkButton href={`/finance/deposits/${d.id}`} size="sm" variant="primary">
                      Review
                    </LinkButton>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'decided' && (
        <Card>
          {decided.length === 0 ? (
            <EmptyState title="No decisions yet" />
          ) : (
            <Table head={['Order', 'Customer', 'Submitted', 'Decision', 'Received', 'Decided', '']}>
              {decided.map((d) => (
                <tr key={d.id}>
                  <Td className="font-medium text-slate-900">{d.order.orderNo}</Td>
                  <Td className="text-slate-700">{fullName(d.order.customer)}</Td>
                  <Td className="tabular-nums text-slate-700">{formatCents(d.amountCents, d.currency)}</Td>
                  <Td>{d.status === 'CONFIRMED' ? <Badge tone="green">Confirmed</Badge> : <Badge tone="red">Rejected</Badge>}</Td>
                  <Td className="tabular-nums text-slate-700">
                    {d.status === 'CONFIRMED' ? (
                      <>
                        {formatCents(d.receivedAmountCents, d.currency)}
                        <div className="text-xs text-slate-500">{formatDateOnly(d.receivedOn)}</div>
                      </>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </Td>
                  <Td className="text-slate-600">
                    {fmtDate(d.decidedAt)}
                    <div className="text-xs text-slate-500">{d.decidedBy?.name}</div>
                  </Td>
                  <Td className="text-right">
                    <Link href={`/finance/deposits/${d.id}`} className="text-sm font-medium text-brand-700 hover:underline">
                      Open
                    </Link>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'refunds' && (
        <Card>
          {refunds.length === 0 ? (
            <EmptyState title="No refunds to pay">Orders cancelled after a deposit, where sales marked the refund as still to be paid, appear here.</EmptyState>
          ) : (
            <Table head={['Order', 'Customer', 'Deposit', 'Cancelled', 'Reason', '']}>
              {refunds.map((o) => {
                const dep = o.deposits[0];
                return (
                  <tr key={o.id}>
                    <Td className="font-medium text-slate-900">{o.orderNo}</Td>
                    <Td className="text-slate-700">{fullName(o.customer)}</Td>
                    <Td className="tabular-nums text-slate-700">
                      {dep ? formatCents(dep.receivedAmountCents ?? dep.amountCents, dep.currency) : <span className="text-slate-300">—</span>}
                      {dep?.status === 'PENDING' && <div className="text-xs text-amber-700">never confirmed</div>}
                    </Td>
                    <Td className="text-slate-600">{fmtDate(o.cancelledAt)}</Td>
                    <Td className="max-w-sm whitespace-pre-wrap text-slate-600">{o.cancelNote}</Td>
                    <Td className="text-right">
                      <ActionButton action={markRefundedAction.bind(null, o.id)} size="sm" confirm={`Mark the refund for ${o.orderNo} as paid?`}>
                        Mark as refunded
                      </ActionButton>
                    </Td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>
      )}
    </>
  );
}

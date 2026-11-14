import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DEPOSIT_METHOD_LABEL, can, formatAddress, formatCents, formatDateOnly, fullName, listDeposits, listFinalPayments, listPendingRefunds, relativeTime } from '@bluven/core';
import { ActionButton, ActionForm, CancelButton, FieldError, FormMessage, Modal, SubmitButton } from '@/components/client';
import { Badge, Card, CardHeader, EmptyState, Input, Label, PageHeader, Table, Tabs, Td, Textarea } from '@/components/ui';
import { fmtDate, fmtDateTime, inputDate } from '@/lib/fmt';
import { one } from '@/lib/params';
import { requireSession } from '@/lib/session';
import { finalPaymentAction } from '../ops/actions';
import { markRefundedAction } from './actions';

export const metadata: Metadata = { title: 'Payments' };

const TABS = ['deposits', 'final', 'closed', 'refunds'] as const;
type Tab = (typeof TABS)[number];

export default async function FinancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, ctx } = await requireSession();
  if (!can(user, 'finance.deposits')) notFound();
  const sp = await searchParams;
  const requested = one(sp.tab) as Tab | undefined;
  const tab: Tab = requested && TABS.includes(requested) ? requested : 'deposits';
  const [due, refunds] = await Promise.all([listFinalPayments(ctx, 'DUE'), listPendingRefunds(ctx)]);
  const [received, recorded] = tab === 'deposits' ? await Promise.all([listDeposits(ctx, 'RECEIVED'), listDeposits(ctx, 'PENDING')]) : [[], []];
  const closed = tab === 'closed' ? await listFinalPayments(ctx, 'RECEIVED') : [];
  const now = new Date();
  const today = inputDate(now);

  return (
    <>
      <PageHeader
        title="Payments"
        description="The money of each order: the deposit, which operations confirms when it accepts the order, and the final payment after the installation. You are told when either has arrived. A final payment can be confirmed here or by operations, and that closes the job."
      />
      <Tabs
        current={tab}
        tabs={[
          { key: 'deposits', label: 'Deposits', href: '/finance' },
          { key: 'final', label: 'Balances due', href: '/finance?tab=final', count: due.length },
          { key: 'closed', label: 'Final payments received', href: '/finance?tab=closed' },
          { key: 'refunds', label: 'Refunds to pay', href: '/finance?tab=refunds', count: refunds.length },
        ]}
      />

      {tab === 'deposits' && (
        <div className="space-y-4">
          <Card>
            <CardHeader title="Received" description="Confirmed by operations when they accepted the order. Newest first." />
            {received.length === 0 ? (
              <EmptyState title="No deposit has been confirmed yet" />
            ) : (
              <Table head={['Order', 'Customer', 'Amount', 'Paid by', 'Confirmed', '']}>
                {received.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50/60">
                    <Td className="font-medium text-slate-900">{d.order.orderNo}</Td>
                    <Td>
                      <div className="text-slate-900">{fullName(d.order.customer)}</div>
                      <div className="text-xs text-slate-500">{formatAddress(d.order.property)}</div>
                    </Td>
                    <Td className="font-medium tabular-nums text-slate-900">{formatCents(d.receivedAmountCents ?? d.amountCents, d.currency)}</Td>
                    <Td className="text-slate-600">{DEPOSIT_METHOD_LABEL[d.method]}</Td>
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
          <Card>
            <CardHeader title="Recorded by sales, not confirmed yet" description="The salesperson has filed the proof of payment. Operations confirms that the money has arrived when they accept the order." />
            {recorded.length === 0 ? (
              <EmptyState title="Nothing is waiting to be confirmed" />
            ) : (
              <Table head={['Order', 'Customer', 'Amount', 'Paid by', 'Recorded', '']}>
                {recorded.map((d) => (
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
                      <Link href={`/finance/deposits/${d.id}`} className="text-sm font-medium text-brand-700 hover:underline">
                        Open
                      </Link>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      )}

      {tab === 'final' && (
        <Card>
          {due.length === 0 ? (
            <EmptyState title="No balance is due">A job appears here when operations marks the installation as done, and leaves when its final payment has arrived.</EmptyState>
          ) : (
            <Table head={['Order', 'Customer', 'Salesperson', 'Balance', 'Job done', 'Asked for by', '']}>
              {due.map((p) => (
                <tr key={p.orderId} className="hover:bg-slate-50/60">
                  <Td className="font-medium text-slate-900">{p.orderNo}</Td>
                  <Td className="text-slate-900">{p.customerName}</Td>
                  <Td className="text-slate-600">{p.salesperson}</Td>
                  <Td className="tabular-nums text-slate-900">
                    {p.balanceCents !== null ? formatCents(p.balanceCents) : <span className="text-slate-400">Not known</span>}
                    {p.totalCents !== null && p.depositCents !== null && (
                      <div className="text-xs text-slate-500">
                        {formatCents(p.totalCents)} less {formatCents(p.depositCents)} deposit
                      </div>
                    )}
                  </Td>
                  <Td className="text-slate-600">{fmtDate(p.jobDoneAt)}</Td>
                  <Td className="text-slate-700">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {formatDateOnly(p.balanceDueOn)}
                      {p.overdue && <Badge tone="red">Overdue</Badge>}
                    </div>
                  </Td>
                  <Td className="text-right">
                    <Modal trigger="Final payment received" title={`Final payment for ${p.orderNo}`} size="sm" description="Say this once the balance is in the account. The job is closed, and operations, the salesperson and the managers can see it.">
                      <ActionForm action={finalPaymentAction.bind(null, p.orderId)} className="space-y-4">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div>
                            <Label htmlFor={`amount-${p.orderId}`} optional>
                              Amount received ($)
                            </Label>
                            <Input id={`amount-${p.orderId}`} name="amount" inputMode="decimal" />
                            <FieldError name="amount" />
                          </div>
                          <div>
                            <Label htmlFor={`on-${p.orderId}`}>Received on</Label>
                            <Input id={`on-${p.orderId}`} name="receivedOn" type="date" required defaultValue={today} max={today} />
                            <FieldError name="receivedOn" />
                          </div>
                        </div>
                        <div>
                          <Label htmlFor={`note-${p.orderId}`} optional>
                            Note
                          </Label>
                          <Textarea id={`note-${p.orderId}`} name="note" rows={2} placeholder="Bank reference, or anything unusual about the payment" />
                        </div>
                        <FormMessage />
                        <div className="flex justify-end gap-2">
                          <CancelButton />
                          <SubmitButton pendingLabel="Closing…">Close the job</SubmitButton>
                        </div>
                      </ActionForm>
                    </Modal>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'closed' && (
        <Card>
          {closed.length === 0 ? (
            <EmptyState title="No final payment has been received yet" />
          ) : (
            <Table head={['Order', 'Customer', 'Salesperson', 'Received', 'On', 'Note']}>
              {closed.map((p) => (
                <tr key={p.orderId}>
                  <Td className="font-medium text-slate-900">{p.orderNo}</Td>
                  <Td className="text-slate-900">{p.customerName}</Td>
                  <Td className="text-slate-600">{p.salesperson}</Td>
                  <Td className="tabular-nums text-slate-900">{p.receivedCents !== null ? formatCents(p.receivedCents) : <span className="text-slate-400">Amount not recorded</span>}</Td>
                  <Td className="text-slate-600">{formatDateOnly(p.receivedOn)}</Td>
                  <Td className="max-w-sm whitespace-pre-wrap text-slate-600">{p.note}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {tab === 'refunds' && (
        <Card>
          {refunds.length === 0 ? (
            <EmptyState title="No refunds to pay">Orders cancelled after a deposit, where the refund was marked as still to be paid, appear here.</EmptyState>
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
                      {dep?.status === 'PENDING' && <div className="text-xs text-amber-700">never confirmed as received</div>}
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

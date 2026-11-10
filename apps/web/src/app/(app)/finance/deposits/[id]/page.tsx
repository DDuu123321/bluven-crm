import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import {
  DEPOSIT_METHOD_LABEL,
  NotFoundError,
  STAGE_LABEL,
  can,
  centsToInput,
  formatAddress,
  formatCents,
  formatDateOnly,
  formatKw,
  formatKwh,
  fullName,
  getDeposit,
  getOrderDeal,
  getOrderDocuments,
  type DepositRow,
} from '@bluven/core';
import { ActionForm, CancelButton, FieldError, FormMessage, Modal, SubmitButton } from '@/components/client';
import { DocTile } from '@/components/doc-tile';
import { Alert, Badge, Card, CardBody, CardHeader, Dl, Input, Label, PageHeader, Textarea } from '@/components/ui';
import { fmtDateTime, inputDate } from '@/lib/fmt';
import { requireSession } from '@/lib/session';
import { confirmDepositAction, rejectDepositAction, reopenDepositAction } from '../../actions';

export const metadata: Metadata = { title: 'Deposit' };

export default async function DepositPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, ctx } = await requireSession();
  if (!can(user, 'finance.deposits')) notFound();
  const { id } = await params;
  let deposit: DepositRow;
  try {
    deposit = await getDeposit(ctx, id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const [{ quotes, contract }, { documents }] = await Promise.all([getOrderDeal(ctx, deposit.orderId), getOrderDocuments(ctx, deposit.orderId)]);
  const quote = quotes.find((q) => q.isAccepted) ?? null;
  const proofs = documents.filter((d) => d.type.key === 'deposit_proof');
  const today = inputDate(new Date());
  const cancelled = deposit.order.sideState === 'CANCELLED';
  const withOps = ['PUSHED', 'RETURNED', 'HANDED_OVER'].includes(deposit.order.stage);

  return (
    <>
      <PageHeader
        back={{ href: '/finance', label: 'Deposits' }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            Deposit for {deposit.order.orderNo}
            {deposit.status === 'PENDING' && <Badge tone="amber">Waiting for you</Badge>}
            {deposit.status === 'CONFIRMED' && <Badge tone="green">Confirmed</Badge>}
            {deposit.status === 'REJECTED' && <Badge tone="red">Rejected</Badge>}
            {deposit.status === 'WITHDRAWN' && <Badge>Withdrawn by sales</Badge>}
          </span>
        }
        description={`${fullName(deposit.order.customer)} · ${formatAddress(deposit.order.property) || 'no address'} · Salesperson: ${deposit.order.owner?.name ?? 'unassigned'}`}
      />
      {cancelled && <Alert tone="red">This order has been cancelled.</Alert>}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="What sales submitted" />
            <CardBody className="space-y-4">
              <Dl
                rows={[
                  ['Amount', <span key="a" className="text-base font-semibold tabular-nums">{formatCents(deposit.amountCents, deposit.currency)}</span>],
                  ['Paid by', DEPOSIT_METHOD_LABEL[deposit.method]],
                  ['Submitted', `${fmtDateTime(deposit.submittedAt)}${deposit.submittedBy ? ` by ${deposit.submittedBy.name}` : ''}`],
                  ['Note', deposit.note ? <span key="n" className="whitespace-pre-wrap">{deposit.note}</span> : null],
                  ...(deposit.receiptUrl
                    ? [
                        [
                          'Gateway receipt',
                          <a key="r" href={deposit.receiptUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                            Open receipt
                          </a>,
                        ] as [string, ReactNode],
                      ]
                    : []),
                ]}
              />
              {proofs.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-slate-500">Proof of payment</p>
                  <ul className="space-y-2">
                    {proofs.map((d) => (
                      <DocTile key={d.id} doc={{ id: d.id, fileName: d.fileName, mimeType: d.mimeType, sizeBytes: d.sizeBytes, hasThumb: !!d.thumbKey, createdAt: d.createdAt, takenAt: null, uploadedBy: d.uploadedBy?.name }} />
                    ))}
                  </ul>
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="The sale" />
            <CardBody>
              <Dl
                rows={[
                  ['Order stage', STAGE_LABEL[deposit.order.stage]],
                  ['System', quote ? [formatKw(quote.dcWatts), quote.storageWh ? `${formatKwh(quote.storageWh)} battery` : ''].filter(Boolean).join(' + ') : null],
                  ['Total price', quote ? formatCents(quote.totalCents, quote.currency) : null],
                  ['Deposit on the quote', quote ? formatCents(quote.depositCents, quote.currency) : null],
                  [
                    'Signed contract',
                    contract ? (
                      <a key="c" href={`/api/documents/${contract.document.id}`} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                        {contract.document.fileName} (signed {formatDateOnly(contract.signedOn)})
                      </a>
                    ) : (
                      <span key="c" className="text-amber-700">Not archived yet</span>
                    ),
                  ],
                ]}
              />
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          {deposit.status === 'PENDING' && !cancelled && (
            <>
              <Card>
                <CardHeader title="Confirm that the money has arrived" />
                <CardBody>
                  <ActionForm action={confirmDepositAction.bind(null, deposit.id)} keepValues className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="receivedAmount">Amount received ($)</Label>
                        <Input id="receivedAmount" name="receivedAmount" inputMode="decimal" required defaultValue={centsToInput(deposit.amountCents)} />
                        <FieldError name="receivedAmount" />
                      </div>
                      <div>
                        <Label htmlFor="receivedOn">Date received</Label>
                        <Input id="receivedOn" name="receivedOn" type="date" required defaultValue={today} max={today} />
                        <FieldError name="receivedOn" />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="bankReference" optional>
                        Bank reference
                      </Label>
                      <Input id="bankReference" name="bankReference" maxLength={100} />
                    </div>
                    <div>
                      <Label htmlFor="confirm-note" optional>
                        Remark
                      </Label>
                      <Textarea id="confirm-note" name="note" rows={2} />
                    </div>
                    <FormMessage />
                    <SubmitButton pendingLabel="Confirming…">Confirm deposit</SubmitButton>
                  </ActionForm>
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Or reject it" description="The order goes back to sales with your reason, and they can submit again." />
                <CardBody>
                  <ActionForm action={rejectDepositAction.bind(null, deposit.id)} keepValues className="space-y-4">
                    <div>
                      <Label htmlFor="reject-note">Reason</Label>
                      <Textarea id="reject-note" name="note" rows={3} required placeholder="For example: no matching transfer has arrived, or the amount differs" />
                      <FieldError name="note" />
                    </div>
                    <FormMessage />
                    <SubmitButton variant="danger" pendingLabel="Rejecting…">
                      Reject deposit
                    </SubmitButton>
                  </ActionForm>
                </CardBody>
              </Card>
            </>
          )}

          {deposit.status !== 'PENDING' && (
            <Card>
              <CardHeader title="Decision" />
              <CardBody className="space-y-4">
                <Dl
                  rows={[
                    ['Outcome', deposit.status === 'CONFIRMED' ? 'Confirmed' : deposit.status === 'REJECTED' ? 'Rejected' : 'Withdrawn by sales'],
                    ...(deposit.status === 'CONFIRMED'
                      ? ([
                          ['Received', `${formatCents(deposit.receivedAmountCents, deposit.currency)} on ${formatDateOnly(deposit.receivedOn)}`],
                          ['Bank reference', deposit.bankReference],
                        ] as [string, string][])
                      : []),
                    [deposit.status === 'REJECTED' ? 'Reason' : 'Remark', deposit.decisionNote ? <span key="n" className="whitespace-pre-wrap">{deposit.decisionNote}</span> : null],
                    ['When', `${fmtDateTime(deposit.decidedAt)}${deposit.decidedBy ? ` by ${deposit.decidedBy.name}` : ''}`],
                  ]}
                />
                {deposit.status === 'CONFIRMED' && !withOps && !cancelled && (
                  <div className="border-t border-slate-100 pt-3">
                    <Modal trigger="Undo confirmation" title="Undo this confirmation" size="sm" description="Use this if the deposit was confirmed by mistake. It goes back to waiting, and sales is told.">
                      <ActionForm action={reopenDepositAction.bind(null, deposit.id)} className="space-y-4">
                        <div>
                          <Label htmlFor="reopen-reason">Why?</Label>
                          <Textarea id="reopen-reason" name="reason" rows={2} required />
                          <FieldError name="reason" />
                        </div>
                        <FormMessage />
                        <div className="flex justify-end gap-2">
                          <CancelButton />
                          <SubmitButton variant="danger">Undo confirmation</SubmitButton>
                        </div>
                      </ActionForm>
                    </Modal>
                  </div>
                )}
                {deposit.status === 'CONFIRMED' && withOps && <p className="text-xs text-slate-500">The order has gone to operations, so this confirmation can no longer be undone here.</p>}
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

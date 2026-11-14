import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import {
  DEPOSIT_METHOD_LABEL,
  NotFoundError,
  STAGE_LABEL,
  can,
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
import { DocTile } from '@/components/doc-tile';
import { Alert, Badge, Card, CardBody, CardHeader, Dl, PageHeader } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import { requireSession } from '@/lib/session';

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
  const cancelled = deposit.order.sideState === 'CANCELLED';

  return (
    <>
      <PageHeader
        back={{ href: '/finance', label: 'Payments' }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            Deposit for {deposit.order.orderNo}
            {deposit.status === 'PENDING' && <Badge tone="amber">Recorded, not confirmed yet</Badge>}
            {deposit.status === 'CONFIRMED' && <Badge tone="green">Received</Badge>}
            {deposit.status === 'REJECTED' && <Badge tone="red">Not accepted</Badge>}
            {deposit.status === 'WITHDRAWN' && <Badge>Withdrawn by sales</Badge>}
          </span>
        }
        description={`${fullName(deposit.order.customer)} · ${formatAddress(deposit.order.property) || 'no address'} · Salesperson: ${deposit.order.owner?.name ?? 'unassigned'}`}
      />
      {cancelled && (
        <Alert tone="red">
          This order has been cancelled.{deposit.status === 'PENDING' && ' Nobody confirmed that this deposit arrived: check the account before any refund is paid.'}
        </Alert>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="What sales recorded" />
            <CardBody className="space-y-4">
              <Dl
                rows={[
                  ['Amount', <span key="a" className="text-base font-semibold tabular-nums">{formatCents(deposit.amountCents, deposit.currency)}</span>],
                  ['Paid by', DEPOSIT_METHOD_LABEL[deposit.method]],
                  ['Recorded', `${fmtDateTime(deposit.submittedAt)}${deposit.submittedBy ? ` by ${deposit.submittedBy.name}` : ''}`],
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
                  ['Deposit on the proposal', quote ? formatCents(quote.depositCents, quote.currency) : null],
                  ...(contract
                    ? [
                        [
                          'Signed copy',
                          <a key="c" href={`/api/documents/${contract.document.id}`} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                            {contract.document.fileName} (signed {formatDateOnly(contract.signedOn)})
                          </a>,
                        ] as [string, ReactNode],
                      ]
                    : []),
                ]}
              />
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Where it stands" />
            <CardBody className="space-y-3">
              {deposit.status === 'PENDING' && (
                <p className="text-sm text-slate-700">
                  Sales has recorded this deposit. Operations confirms that the money has arrived when they accept the order, and you are told when they do. There is nothing to decide here.
                </p>
              )}
              <Dl
                rows={[
                  ['Status', deposit.status === 'CONFIRMED' ? 'Received' : deposit.status === 'PENDING' ? 'Recorded, not confirmed yet' : deposit.status === 'REJECTED' ? 'Not accepted' : 'Withdrawn by sales'],
                  ...(deposit.status === 'CONFIRMED'
                    ? ([
                        ['Received', `${formatCents(deposit.receivedAmountCents ?? deposit.amountCents, deposit.currency)} on ${formatDateOnly(deposit.receivedOn)}`],
                        ...(deposit.bankReference ? [['Bank reference', deposit.bankReference]] : []),
                        ['Confirmed', `${fmtDateTime(deposit.decidedAt)}${deposit.decidedBy ? ` by ${deposit.decidedBy.name}` : ''}`],
                      ] as [string, string][])
                    : []),
                  ...(deposit.status === 'REJECTED' || deposit.status === 'WITHDRAWN'
                    ? ([
                        ...(deposit.decisionNote ? [['Reason', <span key="n" className="whitespace-pre-wrap">{deposit.decisionNote}</span>]] : []),
                        ['When', `${fmtDateTime(deposit.decidedAt)}${deposit.decidedBy ? ` by ${deposit.decidedBy.name}` : ''}`],
                      ] as [string, ReactNode][])
                    : []),
                ]}
              />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

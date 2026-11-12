import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  BEST_TIME_LABEL,
  DEPOSIT_METHOD_LABEL,
  NotFoundError,
  can,
  formatCents,
  formatDateOnly,
  formatKw,
  formatKwh,
  getOrderDocuments,
  getOrderHandoff,
  getOrderHeader,
  getOrderTimeline,
  parseDateOnly,
  type HandoffSnapshot,
  type LeadDetails,
  type OrderHeader,
} from '@bluven/core';
import { ActionButton, ActionForm, CancelButton, FieldError, FormMessage, Modal, SubmitButton } from '@/components/client';
import { assistantConfigured, getAssistantSettings, getOrderBills, getOrderMail, getOrderSummary, storedBrief } from '@bluven/integrations';
import { BillsCard, BriefCard, SummaryCard } from '@/components/assistant';
import { DocTile } from '@/components/doc-tile';
import { EmailList } from '@/components/email-list';
import { Timeline } from '@/components/timeline';
import { Alert, Badge, Card, CardBody, CardHeader, Checkbox, Dl, Label, PageHeader, StageBadge, Textarea } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import { requireSession } from '@/lib/session';
import { writeBriefAction } from '../../../orders/[id]/actions';
import { acceptHandoffAction, returnHandoffAction } from '../../actions';

export const metadata: Metadata = { title: 'Order handoff' };

export default async function OpsOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, ctx } = await requireSession();
  if (!can(user, 'ops.handoffs')) notFound();
  const { id } = await params;
  let header: OrderHeader;
  try {
    header = await getOrderHeader(ctx, id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const { order } = header;
  const [{ packages }, { documents, types }, timeline, mail, summary, bills] = await Promise.all([
    getOrderHandoff(ctx, id),
    getOrderDocuments(ctx, id),
    getOrderTimeline(ctx, id),
    getOrderMail(ctx, id),
    getOrderSummary(ctx, id),
    getOrderBills(ctx, id),
  ]);
  const latest = packages.find((p) => p.decision !== 'WITHDRAWN') ?? packages[0];
  if (!latest) notFound();
  const snap = latest.snapshot as unknown as HandoffSnapshot;
  const pending = latest.decision === 'PENDING' && order.sideState === 'NONE';
  const lead = snap.order.leadDetails as LeadDetails;
  const earlierReturns = packages.filter((p) => p.decision === 'RETURNED' && p.id !== latest.id);
  const labelFor = new Map(snap.checklist.map((i) => [i.key, i.label]));
  const assistant = assistantConfigured();
  // Shortly after a push the brief is on its way; later, a missing one has to be asked for.
  const now = new Date();
  const briefOnItsWay = assistant && latest.decision === 'PENDING' && now.getTime() - latest.pushedAt.getTime() < 10 * 60_000 && (await getAssistantSettings(ctx.db)).autoBrief;

  return (
    <>
      <PageHeader
        back={{ href: '/ops', label: 'Incoming orders' }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {snap.customer.name}
            <span className="text-sm font-normal text-slate-500">{order.orderNo}</span>
            <StageBadge stage={order.stage} sideState={order.sideState} />
          </span>
        }
        description={`${snap.property.address} · Salesperson: ${snap.owner?.name ?? 'unassigned'} · Submission ${latest.version}, pushed ${fmtDateTime(latest.pushedAt)}`}
        actions={
          pending && (
            <>
              <Modal trigger="Return to sales" title="Return this order to sales" variant="danger" description="Sales is notified, fixes what you describe and pushes the order again.">
                <ActionForm action={returnHandoffAction.bind(null, order.id)} className="space-y-4">
                  <div>
                    <Label htmlFor="return-reason">What needs to be fixed?</Label>
                    <Textarea id="return-reason" name="reason" rows={4} required placeholder="Be specific, for example: the meter box photo is too dark to read the main switch rating" />
                    <FieldError name="reason" />
                  </div>
                  <fieldset>
                    <legend className="mb-1.5 text-xs font-medium text-slate-600">Which items does this concern? (optional)</legend>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {snap.checklist.map((item) => (
                        <Checkbox key={item.key} name="missing" value={item.key} label={item.label} />
                      ))}
                    </div>
                  </fieldset>
                  <FormMessage />
                  <div className="flex justify-end gap-2">
                    <CancelButton />
                    <SubmitButton variant="danger" pendingLabel="Returning…">
                      Return to sales
                    </SubmitButton>
                  </div>
                </ActionForm>
              </Modal>
              <ActionButton action={acceptHandoffAction.bind(null, order.id)} variant="primary" confirm={`Accept ${order.orderNo}? Sales will be told that operations has taken it on.`}>
                Accept order
              </ActionButton>
            </>
          )
        }
      />

      <div className="mb-4 space-y-2">
        {order.sideState === 'CANCELLED' && <Alert tone="red">This order was cancelled by sales.</Alert>}
        {latest.decision === 'ACCEPTED' && <Alert tone="green">Accepted {fmtDateTime(latest.decidedAt)}{latest.decidedBy ? ` by ${latest.decidedBy.name}` : ''}.</Alert>}
        {latest.decision === 'RETURNED' && (
          <Alert tone="amber" title={`Returned to sales ${fmtDateTime(latest.decidedAt)}${latest.decidedBy ? ` by ${latest.decidedBy.name}` : ''}`}>
            <p className="whitespace-pre-wrap">{latest.returnReason}</p>
            <p className="mt-1">It will reappear under “Waiting for you” once sales pushes it again.</p>
          </Alert>
        )}
        {earlierReturns.length > 0 && (
          <Alert tone="blue" title={`Returned ${earlierReturns.length} time${earlierReturns.length === 1 ? '' : 's'} before`}>
            <ul className="mt-1 space-y-1">
              {earlierReturns.map((p) => (
                <li key={p.id}>
                  <span className="font-medium">Submission {p.version}:</span> <span className="whitespace-pre-wrap">{p.returnReason}</span>
                  {p.returnMissing.length > 0 && <span className="text-slate-600"> ({p.returnMissing.map((k) => labelFor.get(k) ?? k).join(', ')})</span>}
                </li>
              ))}
            </ul>
          </Alert>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <BriefCard brief={storedBrief(latest.brief)} writtenAt={latest.briefAt} available={assistant} automatic={briefOnItsWay} write={writeBriefAction.bind(null, order.id)} />
          {snap.order.notes && (
            <Card>
              <CardHeader title="Notes from sales" />
              <CardBody>
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-slate-800">{snap.order.notes}</p>
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title="Customer" />
            <CardBody>
              <Dl
                rows={[
                  ['Name', snap.customer.name],
                  ['Phone', snap.customer.phones.join(', ')],
                  ['Email', snap.customer.emails.join(', ')],
                  ['Best time to contact', lead.bestTime ? (BEST_TIME_LABEL[lead.bestTime as keyof typeof BEST_TIME_LABEL] ?? lead.bestTime) : null],
                  ['Notes', snap.customer.notes ? <span key="n" className="whitespace-pre-wrap">{snap.customer.notes}</span> : null],
                ]}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Site" />
            <CardBody>
              <Dl
                rows={[
                  ['Address', snap.property.address],
                  ['Property type', snap.property.propertyType],
                  ['NMI', snap.property.nmi],
                  ['Retailer', snap.property.retailer],
                  ['Supply', snap.property.phase],
                  ['Roof', snap.property.roofType],
                  ['Storeys', snap.property.storeys],
                  ['Site notes', snap.property.notes ? <span key="n" className="whitespace-pre-wrap">{snap.property.notes}</span> : null],
                ]}
              />
            </CardBody>
          </Card>
          <BillsCard bills={bills} available={false} />
          <Card>
            <CardHeader title="What was sold" />
            <CardBody>
              <Dl
                rows={[
                  ['System', snap.quote ? [formatKw(snap.quote.dcWatts), snap.quote.storageWh ? `${formatKwh(snap.quote.storageWh)} battery` : ''].filter(Boolean).join(' + ') : null],
                  ['Description', snap.quote?.title],
                  ['Quote version', snap.quote ? `v${snap.quote.version}` : null],
                  ['Total price', snap.quote ? formatCents(snap.quote.totalCents, snap.quote.currency) : null],
                  ['Contract signed', snap.contract ? formatDateOnly(parseDateOnly(snap.contract.signedOn)) : null],
                  [
                    'Deposit',
                    snap.deposit ? (
                      <span key="d">
                        {formatCents(snap.deposit.receivedAmountCents ?? snap.deposit.amountCents, snap.deposit.currency)} received {snap.deposit.receivedOn ? formatDateOnly(parseDateOnly(snap.deposit.receivedOn)) : ''} ·{' '}
                        {DEPOSIT_METHOD_LABEL[snap.deposit.method as keyof typeof DEPOSIT_METHOD_LABEL] ?? snap.deposit.method} · confirmed by {snap.deposit.confirmedBy ?? 'finance'}
                      </span>
                    ) : null,
                  ],
                  [
                    'Balance to collect',
                    snap.quote?.totalCents != null && snap.deposit ? formatCents(snap.quote.totalCents - (snap.deposit.receivedAmountCents ?? snap.deposit.amountCents), snap.quote.currency) : null,
                  ],
                ]}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Checklist at the time of the push" />
            <ul className="divide-y divide-slate-100">
              {snap.checklist.map((item) => (
                <li key={item.key} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                  <div>
                    <p className="font-medium text-slate-900">{item.label}</p>
                    <p className="text-slate-500">{item.detail}</p>
                  </div>
                  {latest.returnMissing.includes(item.key) ? <Badge tone="red">Flagged</Badge> : <Badge tone="green">Provided</Badge>}
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="space-y-4">
          <SummaryCard summary={summary} available={false} />
          <Card>
            <CardHeader title="Documents" description="These are the files as they are now. If sales adds or replaces a file after a return, you see the new one." />
            <CardBody className="space-y-4">
              {types
                .filter((t) => documents.some((d) => d.typeId === t.id))
                .map((t) => (
                  <div key={t.id}>
                    <p className="mb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">{t.label}</p>
                    <ul className="space-y-2">
                      {documents
                        .filter((d) => d.typeId === t.id)
                        .map((d) => (
                          <DocTile
                            key={d.id}
                            doc={{ id: d.id, fileName: d.fileName, mimeType: d.mimeType, sizeBytes: d.sizeBytes, hasThumb: !!d.thumbKey, createdAt: d.createdAt, takenAt: d.takenAt, uploadedBy: d.uploadedBy?.name, source: d.source, note: d.note }}
                          />
                        ))}
                    </ul>
                  </div>
                ))}
              {documents.length === 0 && <p className="text-sm text-slate-500">No files.</p>}
            </CardBody>
          </Card>
          {mail.emails.length > 0 && (
            <Card>
              <CardHeader title="Email with the customer" description="What sales and the customer wrote to each other, newest first." />
              <EmailList emails={mail.emails} />
            </Card>
          )}
          <Card>
            <CardHeader title="Timeline" description="The full history of the sale, for context." />
            <Timeline entries={timeline} />
          </Card>
        </div>
      </div>
    </>
  );
}

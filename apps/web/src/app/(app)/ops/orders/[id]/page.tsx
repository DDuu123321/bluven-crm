import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  BEST_TIME_LABEL,
  CA_STATUSES,
  CA_STATUS_LABEL,
  DELIVERY_MODES,
  DELIVERY_MODE_LABEL,
  DEPOSIT_METHOD_LABEL,
  NotFoundError,
  PURCHASE_STATUSES,
  PURCHASE_STATUS_LABEL,
  REFUND_LABEL,
  STC_PLATFORMS,
  STC_PLATFORM_LABEL,
  can,
  dateOnlyString,
  formatCents,
  formatDateOnly,
  formatKw,
  formatKwh,
  getOperationsSettings,
  getOperationsView,
  getOrderDocuments,
  getOrderHandoff,
  getOrderHeader,
  getOrderTimeline,
  opsFolderBlockReason,
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
import { AfterInstallation, NoticeList, OpsItemList, OpsNotes } from '@/components/operations';
import { Timeline } from '@/components/timeline';
import { Uploader } from '@/components/uploader';
import { Alert, Badge, Card, CardBody, CardHeader, Checkbox, Dl, Input, Label, PageHeader, Select, StageBadge, Textarea } from '@/components/ui';
import { fmtDateTime, inputDate } from '@/lib/fmt';
import { requireSession } from '@/lib/session';
import { cancelOrderAction, confirmEmailAction, deleteDocumentAction, writeBriefAction } from '../../../orders/[id]/actions';
import {
  acceptHandoffAction,
  addOpsNoteAction,
  chaseBalanceAction,
  finalPaymentAction,
  markJobDoneAction,
  rebateAction,
  retryNoticeAction,
  returnHandoffAction,
  sendScheduleNoticeAction,
  updateOpsJobAction,
} from '../../actions';

export const metadata: Metadata = { title: 'Order with operations' };

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
  const [{ packages }, { documents, types }, timeline, mail, summary, bills, view, settings] = await Promise.all([
    getOrderHandoff(ctx, id),
    getOrderDocuments(ctx, id),
    getOrderTimeline(ctx, id),
    getOrderMail(ctx, id),
    getOrderSummary(ctx, id),
    getOrderBills(ctx, id),
    getOperationsView(ctx, id),
    getOperationsSettings(ctx.db),
  ]);
  const latest = packages.find((p) => p.decision !== 'WITHDRAWN') ?? packages[0];
  if (!latest) notFound();
  const snap = latest.snapshot as unknown as HandoffSnapshot;
  const active = order.sideState === 'NONE';
  const pending = latest.decision === 'PENDING' && active;
  // After acceptance: being arranged, then installed and waiting for the balance, then closed.
  const arranging = active && order.stage === 'IN_PROGRESS';
  const installed = active && order.stage === 'INSTALLED';
  const canChange = !!view && (arranging || installed);
  // From the push until the job is closed operations add to the folder themselves.
  const canAddFiles = opsFolderBlockReason(order) === null;
  const job = view?.job;
  const openItems = view ? view.items.filter((i) => !i.done) : [];
  const datesSettled = !!view && view.items.every((i) => (i.key !== 'installDate' && i.key !== 'delivery') || i.done);
  const dep = snap.deposit;
  const depositProof = snap.documents.find((d) => d.typeKey === 'deposit_proof');
  const depositLine = dep
    ? dep.method === 'FINANCE'
      ? `The finance approval for the deposit of ${formatCents(dep.amountCents, dep.currency)} is in order`
      : dep.method === 'GATEWAY'
        ? `The deposit of ${formatCents(dep.amountCents, dep.currency)}, paid through Pylon, has arrived`
        : `The deposit of ${formatCents(dep.amountCents, dep.currency)} has arrived in the account`
    : 'The deposit has arrived in the account';
  // The e-mails that go to the customer by themselves need an address somebody has confirmed.
  const addresses = order.customer.emails;
  const noConfirmedAddress = !addresses.some((a) => !a.unconfirmed);
  const today = inputDate(new Date());
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
        back={{ href: arranging ? '/ops?tab=jobs' : installed ? '/ops?tab=installed' : order.stage === 'COMPLETED' ? '/ops?tab=closed' : '/ops', label: 'Operations' }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {snap.customer.name}
            <span className="text-sm font-normal text-slate-500">{order.orderNo}</span>
            <StageBadge stage={order.stage} sideState={order.sideState} />
          </span>
        }
        description={`${snap.property.address} · Salesperson: ${snap.owner?.name ?? 'unassigned'} · Submission ${latest.version}, pushed ${fmtDateTime(latest.pushedAt)}`}
        actions={
          <>
            {(pending || arranging) && (
              <Modal
                trigger="Return to sales"
                title="Return this order to sales"
                variant={pending ? 'danger' : 'secondary'}
                description={
                  arranging
                    ? 'For what you cannot settle without the salesperson, for example a customer you cannot reach. What you have arranged is kept, and the order comes back when sales pushes it again.'
                    : 'For what you cannot settle yourself. A file that is missing is quicker to ask for directly. Sales is notified, sorts it out and pushes the order again.'
                }
              >
                <ActionForm action={returnHandoffAction.bind(null, order.id)} className="space-y-4">
                  <div>
                    <Label htmlFor="return-reason">Why is the salesperson needed?</Label>
                    <Textarea id="return-reason" name="reason" rows={4} required placeholder="Be specific, for example: the customer does not answer calls or e-mails since Monday" />
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
            )}
            {arranging && (
              <Modal trigger="Cancel order" title="Cancel this order" variant="danger" description="For a job that cannot go ahead. The salesperson and the managers are told.">
                <ActionForm action={cancelOrderAction.bind(null, order.id)} className="space-y-4">
                  <div>
                    <Label htmlFor="cancel-note">Why is the order being cancelled?</Label>
                    <Textarea id="cancel-note" name="note" rows={3} required />
                    <FieldError name="note" />
                  </div>
                  <div>
                    <Label htmlFor="cancel-refund">Deposit refund</Label>
                    <Select id="cancel-refund" name="refundStatus" required defaultValue="">
                      <option value="" disabled>
                        Choose
                      </option>
                      <option value="PENDING">{REFUND_LABEL.PENDING} (finance will be notified)</option>
                      <option value="NOT_REQUIRED">{REFUND_LABEL.NOT_REQUIRED}</option>
                      <option value="REFUNDED">{REFUND_LABEL.REFUNDED}</option>
                    </Select>
                    <FieldError name="refundStatus" />
                  </div>
                  <FormMessage />
                  <div className="flex justify-end gap-2">
                    <CancelButton>Keep the order</CancelButton>
                    <SubmitButton variant="danger">Cancel order</SubmitButton>
                  </div>
                </ActionForm>
              </Modal>
            )}
            {pending && (
              <Modal
                trigger="Accept order"
                title={`Accept ${order.orderNo}`}
                variant="primary"
                description="Accepting makes the job yours. Finance is told that the deposit has arrived, sales is told that you have taken the order on, and the customer gets the welcome e-mail."
              >
                <ActionForm action={acceptHandoffAction.bind(null, order.id)} className="space-y-4">
                  {dep && (
                    <Dl
                      rows={[
                        ['Deposit', `${formatCents(dep.amountCents, dep.currency)} · ${DEPOSIT_METHOD_LABEL[dep.method as keyof typeof DEPOSIT_METHOD_LABEL] ?? dep.method}`],
                        ...(dep.note ? ([['Note from sales', <span key="n" className="whitespace-pre-wrap">{dep.note}</span>]] as [string, ReactNode][]) : []),
                        ...(depositProof
                          ? ([
                              [
                                'Proof',
                                <a key="p" href={`/api/documents/${depositProof.id}`} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                                  {depositProof.fileName}
                                </a>,
                              ],
                            ] as [string, ReactNode][])
                          : []),
                      ]}
                    />
                  )}
                  <div>
                    <Checkbox name="depositReceived" required defaultChecked={header.deposit === 'CONFIRMED'} label={depositLine} />
                    <FieldError name="depositReceived" />
                    <p className="mt-1 text-xs text-slate-500">
                      {header.deposit === 'CONFIRMED' ? 'Confirmed when this order was accepted before.' : 'Check the account first. If the money is not there, leave the order waiting or return it to sales.'}
                    </p>
                  </div>
                  {noConfirmedAddress && !view && settings.notices.WELCOME.enabled && (
                    <Alert tone="amber">
                      {addresses.length > 0
                        ? `Nobody has confirmed that ${addresses[0]!.email} is the customer’s address, so the welcome e-mail will be held back. You can confirm the address and send it afterwards, further down this page.`
                        : 'The customer has no e-mail address on record, so the welcome e-mail cannot go out.'}
                    </Alert>
                  )}
                  <FormMessage />
                  <div className="flex justify-end gap-2">
                    <CancelButton />
                    <SubmitButton pendingLabel="Accepting…">Accept order</SubmitButton>
                  </div>
                </ActionForm>
              </Modal>
            )}
            {arranging && (
              <ActionButton
                action={markJobDoneAction.bind(null, order.id)}
                variant="primary"
                confirm={`Mark the installation for ${order.orderNo} as done?${settings.notices.JOB_DONE.enabled ? ` The customer is thanked and asked to pay the balance within ${settings.balanceDays} working days.` : ''}${openItems.length > 0 ? ` Still open on the job: ${openItems.map((i) => i.label.toLowerCase()).join(', ')}.` : ''}`}
              >
                Job done
              </ActionButton>
            )}
            {installed && <FinalPaymentModal orderId={order.id} orderNo={order.orderNo} today={today} variant="primary" />}
          </>
        }
      />

      <div className="mb-4 space-y-2">
        {order.sideState === 'CANCELLED' && <Alert tone="red" title="This order was cancelled">{order.cancelNote}</Alert>}
        {latest.decision === 'ACCEPTED' && active && (
          <Alert tone={order.stage === 'COMPLETED' ? 'green' : 'blue'}>
            Accepted {fmtDateTime(latest.decidedAt)}
            {latest.decidedBy ? ` by ${latest.decidedBy.name}` : ''}.{' '}
            {order.stage === 'COMPLETED'
              ? `The final payment has arrived and the job was closed ${fmtDateTime(order.completedAt)}.`
              : order.stage === 'INSTALLED'
                ? `The job was done ${fmtDateTime(order.jobDoneAt)}. It closes when the final payment has arrived.`
                : 'Arrange the items below in any order, tell the customer the dates, and mark the job as done after the installation.'}
          </Alert>
        )}
        {latest.decision === 'RETURNED' && (
          <Alert tone="amber" title={`Returned to sales ${fmtDateTime(latest.decidedAt)}${latest.decidedBy ? ` by ${latest.decidedBy.name}` : ''}`}>
            <p className="whitespace-pre-wrap">{latest.returnReason}</p>
            <p className="mt-1">It will reappear under “To accept” once sales pushes it again.</p>
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
          {view && job && (
            <Card id="job">
              <CardHeader
                title="The job"
                description={canChange ? 'What you have arranged. The items stand side by side: fill in whichever is settled, in any order. Sales reads this and cannot change it.' : 'What was arranged for this job.'}
                actions={openItems.length === 0 ? <Badge tone="green">All settled</Badge> : <Badge tone="slate">{openItems.length} open</Badge>}
              />
              {canChange ? (
                <CardBody>
                  <ActionForm action={updateOpsJobAction.bind(null, order.id)} keepValues className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="job-ca">Connection approval</Label>
                        <Select id="job-ca" name="caStatus" defaultValue={job.caStatus}>
                          {CA_STATUSES.map((v) => (
                            <option key={v} value={v}>
                              {CA_STATUS_LABEL[v]}
                            </option>
                          ))}
                        </Select>
                        <FieldError name="caStatus" />
                      </div>
                      <div>
                        <Label htmlFor="job-ca-ref" optional>
                          Application number
                        </Label>
                        <Input id="job-ca-ref" name="caReference" defaultValue={job.caReference} maxLength={100} />
                        <FieldError name="caReference" />
                      </div>
                      <div>
                        <Label htmlFor="job-stc">Job assigned on</Label>
                        <Select id="job-stc" name="stcPlatform" defaultValue={job.stcPlatform ?? ''}>
                          <option value="">Not assigned yet</option>
                          {STC_PLATFORMS.map((v) => (
                            <option key={v} value={v}>
                              {STC_PLATFORM_LABEL[v]}
                            </option>
                          ))}
                        </Select>
                        <FieldError name="stcPlatform" />
                      </div>
                      <div>
                        <Label htmlFor="job-stc-ref" optional>
                          Job number there
                        </Label>
                        <Input id="job-stc-ref" name="stcReference" defaultValue={job.stcReference} maxLength={100} />
                        <FieldError name="stcReference" />
                      </div>
                      <div>
                        <Label htmlFor="job-installer">Installer</Label>
                        <Input id="job-installer" name="installerName" defaultValue={job.installerName} maxLength={100} />
                        <FieldError name="installerName" />
                      </div>
                      <div>
                        <Label htmlFor="job-licence">Electrician licence number</Label>
                        <Input id="job-licence" name="electricianLicence" defaultValue={job.electricianLicence} maxLength={50} />
                        <FieldError name="electricianLicence" />
                      </div>
                      <div>
                        <Label htmlFor="job-date">Installation date</Label>
                        <Input id="job-date" name="installDate" type="date" defaultValue={dateOnlyString(job.installDate)} />
                        <FieldError name="installDate" />
                      </div>
                      <div>
                        <Label htmlFor="job-stock">Stock</Label>
                        <Select id="job-stock" name="purchaseStatus" defaultValue={job.purchaseStatus}>
                          {PURCHASE_STATUSES.map((v) => (
                            <option key={v} value={v}>
                              {PURCHASE_STATUS_LABEL[v]}
                            </option>
                          ))}
                        </Select>
                        <FieldError name="purchaseStatus" />
                      </div>
                      <div>
                        <Label htmlFor="job-delivery">Delivery</Label>
                        <Select id="job-delivery" name="deliveryMode" defaultValue={job.deliveryMode ?? ''}>
                          <option value="">Not arranged yet</option>
                          {DELIVERY_MODES.map((v) => (
                            <option key={v} value={v}>
                              {DELIVERY_MODE_LABEL[v]}
                            </option>
                          ))}
                        </Select>
                        <FieldError name="deliveryMode" />
                      </div>
                      <div>
                        <Label htmlFor="job-eta" optional>
                          Expected on site
                        </Label>
                        <Input id="job-eta" name="deliveryEta" type="date" defaultValue={dateOnlyString(job.deliveryEta)} />
                        <p className="mt-1 text-xs text-slate-500">For a delivery. Not kept when the installer picks the equipment up.</p>
                        <FieldError name="deliveryEta" />
                      </div>
                    </div>
                    <FormMessage />
                    <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
                  </ActionForm>
                </CardBody>
              ) : (
                <OpsItemList items={view.items} />
              )}
            </Card>
          )}
          {view && arranging && settings.notices.SCHEDULE.enabled && (
            <Card>
              <CardHeader title="Tell the customer the dates" description="An e-mail with the installation date and how the equipment arrives. Send it when both are settled, and again when either changes." />
              <CardBody className="space-y-3">
                {!datesSettled ? (
                  <p className="text-sm text-slate-500">Fill in the installation date and the delivery first.</p>
                ) : view.scheduleUpToDate ? (
                  <p className="text-sm text-slate-700">The customer has been told the dates as they stand now.</p>
                ) : (
                  <>
                    <Dl rows={view.items.filter((i) => i.key === 'installDate' || i.key === 'delivery').map((i) => [i.label, i.detail])} />
                    <ActionButton action={sendScheduleNoticeAction.bind(null, order.id)} variant="primary" confirm="Send the customer the installation date and the delivery as they stand now?">
                      Send the dates to the customer
                    </ActionButton>
                  </>
                )}
              </CardBody>
            </Card>
          )}
          {view && view.jobDoneAt && (
            <Card id="after">
              <CardHeader title="After the installation" description="You are reminded to apply for the rebate, and to look whether the balance has come in. Sales cannot see the account: ask them to chase only once you have looked." />
              <CardBody className="space-y-3">
                <AfterInstallation view={view} />
                {active && (
                  <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                    {view.rebate.appliedAt ? (
                      <ActionButton action={rebateAction.bind(null, order.id, 'no')} size="sm" confirm="Mark the rebate as not applied for yet?">
                        Rebate not applied for after all
                      </ActionButton>
                    ) : (
                      <ActionButton action={rebateAction.bind(null, order.id, 'yes')} size="sm" variant={view.rebate.overdue ? 'primary' : 'secondary'}>
                        Rebate applied for
                      </ActionButton>
                    )}
                    {installed && (
                      <>
                        <Modal trigger="Ask sales to chase the balance" title="Ask the salesperson to chase the balance" size="sm" description="The salesperson gets a task and a notification. Do this when the balance has not arrived.">
                          <ActionForm action={chaseBalanceAction.bind(null, order.id)} className="space-y-4">
                            <div>
                              <Label htmlFor="chase-note" optional>
                                Anything they should know
                              </Label>
                              <Textarea id="chase-note" name="note" rows={3} placeholder="For example the amount that is still open" />
                            </div>
                            <FormMessage />
                            <div className="flex justify-end gap-2">
                              <CancelButton />
                              <SubmitButton>Ask sales</SubmitButton>
                            </div>
                          </ActionForm>
                        </Modal>
                        <FinalPaymentModal orderId={order.id} orderNo={order.orderNo} today={today} idPrefix="after" />
                      </>
                    )}
                  </div>
                )}
              </CardBody>
            </Card>
          )}
          {view && (
            <Card id="notes">
              <CardHeader title="Notes on the job" description="Anything out of the ordinary about this job. Sales and the managers read them on the order." />
              <CardBody className="space-y-3">
                {active && (
                  <ActionForm action={addOpsNoteAction.bind(null, order.id)} className="space-y-2">
                    <Label htmlFor="ops-note">Add a note</Label>
                    <Textarea id="ops-note" name="body" rows={2} required />
                    <FieldError name="body" />
                    <FormMessage />
                    <SubmitButton pendingLabel="Saving…">Add note</SubmitButton>
                  </ActionForm>
                )}
                <OpsNotes notes={view.notes} />
              </CardBody>
            </Card>
          )}
          {view && (
            <Card id="notices">
              <CardHeader title="E-mails to the customer" description="They go out by themselves: the welcome when you accept, the dates when you send them, and the thank-you with the request for the balance when the job is done." />
              {addresses.some((a) => a.unconfirmed) && active && (
                <div className="border-b border-slate-100 px-4 py-3">
                  <p className="text-sm text-slate-700">{noConfirmedAddress ? 'Nobody has confirmed the customer’s e-mail address yet, so nothing can be sent.' : 'One of the customer’s addresses has not been confirmed.'}</p>
                  <ul className="mt-2 space-y-1.5">
                    {addresses
                      .filter((a) => a.unconfirmed)
                      .map((a) => (
                        <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="text-slate-900">{a.email}</span>
                          <ActionButton action={confirmEmailAction.bind(null, order.id, a.id)} size="sm" confirm={`Confirm that ${a.email} is the customer’s own address?`}>
                            This is the customer’s address
                          </ActionButton>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
              <NoticeList notices={view.notices} retry={active ? (noticeId) => retryNoticeAction.bind(null, noticeId) : undefined} />
            </Card>
          )}
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
                  ...(snap.contract ? ([['Signed copy on file', `signed ${formatDateOnly(parseDateOnly(snap.contract.signedOn))}`]] as [string, ReactNode][]) : []),
                  [
                    'Deposit',
                    dep ? (
                      <span key="d" className="flex flex-wrap items-center gap-2">
                        {formatCents(dep.amountCents, dep.currency)} · {DEPOSIT_METHOD_LABEL[dep.method as keyof typeof DEPOSIT_METHOD_LABEL] ?? dep.method}
                        {header.deposit === 'CONFIRMED' ? <Badge tone="green">Confirmed as received</Badge> : <Badge tone="amber">To be confirmed when you accept</Badge>}
                      </span>
                    ) : null,
                  ],
                  ...(dep?.note ? ([['Note on the deposit', <span key="n" className="whitespace-pre-wrap">{dep.note}</span>]] as [string, ReactNode][]) : []),
                  ['Balance to collect', snap.quote?.totalCents != null && dep ? formatCents(Math.max(0, snap.quote.totalCents - dep.amountCents), snap.quote.currency) : null],
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
          <Card id="documents">
            <CardHeader
              title="Documents"
              description={
                canAddFiles
                  ? 'The files as they are now. While the order is with you, add what you get from the customer or the installer here: what is missing is quicker to ask for directly than to send the order back. Files from sales stay as they are.'
                  : 'These are the files as they are now. If sales adds or replaces a file after a return, you see the new one.'
              }
            />
            <CardBody className="space-y-4">
              {types
                .filter((t) => documents.some((d) => d.typeId === t.id) || (canAddFiles && !t.isSystem))
                .map((t) => (
                  <div key={t.id} id={`folder-${t.key}`}>
                    <p className="mb-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">{t.label}</p>
                    <ul className="space-y-2">
                      {documents
                        .filter((d) => d.typeId === t.id)
                        .map((d) => (
                          <DocTile
                            key={d.id}
                            doc={{ id: d.id, fileName: d.fileName, mimeType: d.mimeType, sizeBytes: d.sizeBytes, hasThumb: !!d.thumbKey, createdAt: d.createdAt, takenAt: d.takenAt, uploadedBy: d.uploadedBy?.name, source: d.source, note: d.note }}
                            actions={
                              canAddFiles && !t.isSystem && d.uploadedById === user.id ? (
                                <ActionButton action={deleteDocumentAction.bind(null, d.id)} variant="link-danger" confirm={`Remove “${d.fileName}” from this order?`}>
                                  Remove
                                </ActionButton>
                              ) : undefined
                            }
                          />
                        ))}
                    </ul>
                    {canAddFiles && !t.isSystem && (
                      <div className="mt-2">
                        <Uploader endpoint={`/api/orders/${order.id}/documents?typeId=${t.id}`} compact />
                      </div>
                    )}
                  </div>
                ))}
              {documents.length === 0 && !canAddFiles && <p className="text-sm text-slate-500">No files.</p>}
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

/** The balance is in the account: closing the job, with what arrived if that is known. */
function FinalPaymentModal({ orderId, orderNo, today, variant, idPrefix = 'final' }: { orderId: string; orderNo: string; today: string; variant?: 'primary'; idPrefix?: string }) {
  return (
    <Modal
      trigger="Final payment received"
      title={`Final payment for ${orderNo}`}
      size="sm"
      variant={variant}
      description="Say this once the balance is in the account. The job is closed, and finance, the salesperson and the managers are told."
    >
      <ActionForm action={finalPaymentAction.bind(null, orderId)} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor={`${idPrefix}-amount`} optional>
              Amount received ($)
            </Label>
            <Input id={`${idPrefix}-amount`} name="amount" inputMode="decimal" />
            <FieldError name="amount" />
          </div>
          <div>
            <Label htmlFor={`${idPrefix}-on`}>Received on</Label>
            <Input id={`${idPrefix}-on`} name="receivedOn" type="date" required defaultValue={today} max={today} />
            <FieldError name="receivedOn" />
          </div>
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-note`} optional>
            Note
          </Label>
          <Textarea id={`${idPrefix}-note`} name="note" rows={2} placeholder="Bank reference, or anything unusual about the payment" />
        </div>
        <FormMessage />
        <div className="flex justify-end gap-2">
          <CancelButton />
          <SubmitButton pendingLabel="Closing…">Close the job</SubmitButton>
        </div>
      </ActionForm>
    </Modal>
  );
}

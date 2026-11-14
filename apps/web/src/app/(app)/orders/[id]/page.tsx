import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  NotFoundError,
  REFUND_LABEL,
  STAGE_HINT,
  can,
  canCancel,
  canEditOrder,
  canHold,
  canMarkLost,
  editBlockReason,
  formatAddress,
  fullName,
  getOrderHeader,
  getSettings,
  idleDays,
  isIdleTrackedStage,
  isManager,
  isOrderStaff,
  isSalesEditableStage,
  isWithOperations,
  listSalespeople,
  type OrderHeader,
} from '@bluven/core';
import { ActionButton, ActionForm, CancelButton, FieldError, FormMessage, Modal, SubmitButton } from '@/components/client';
import { Alert, Badge, Card, Input, Label, LinkButton, PageHeader, Select, StageBadge, StageTracker, Tabs, Textarea } from '@/components/ui';
import { fmtDate, fmtDateTime, inputDate } from '@/lib/fmt';
import { one } from '@/lib/params';
import { requireSession } from '@/lib/session';
import { assignOneAction, cancelOrderAction, dismissDuplicateAction, holdAction, intentAction, leadOriginAction, markLostAction, openJobAction, restoreLostAction, resumeAction } from './actions';
import { DealTab } from './deal';
import { DocumentsTab } from './documents';
import { EmailTab } from './email';
import { HandoffTab } from './handoff';
import { HistoryTab } from './history';
import { OperationsTab } from './operations';
import { OverviewTab } from './overview';

export const metadata: Metadata = { title: 'Order' };

const TABS = ['overview', 'email', 'documents', 'deal', 'handoff', 'operations', 'history'] as const;
type Tab = (typeof TABS)[number];

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, ctx } = await requireSession();
  const { id } = await params;
  const sp = await searchParams;

  let header: OrderHeader;
  try {
    header = await getOrderHeader(ctx, id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  // Operations and finance have their own, narrower pages for an order.
  if (header.view === 'OPS') redirect(`/ops/orders/${id}`);
  if (header.view === 'FINANCE') redirect('/finance');

  const { order } = header;
  const access = { ownerId: order.ownerId, stage: order.stage, sideState: order.sideState, firstPushedAt: order.firstPushedAt, hasDepositRecord: header.deposit !== 'NONE' };
  const staff = isOrderStaff(user, order);
  const editable = canEditOrder(user, access);
  // Correcting a lead's details needs no more than that. Working on it needs the job to be open.
  const opened = !!order.openedAt;
  const workable = editable && opened;
  const withOps = isWithOperations(order.stage);
  // What operations has arranged is there to read from the first acceptance on.
  const showOperations = !!order.handedOverAt;
  const manager = isManager(user);
  const showHistory = can(user, 'audit.view');
  const requested = one(sp.tab) as Tab | undefined;
  const tab: Tab = requested && TABS.includes(requested) && (requested !== 'history' || showHistory) && (requested !== 'operations' || showOperations) ? requested : 'overview';
  const base = `/orders/${order.id}`;
  const stateInput = { stage: order.stage, sideState: order.sideState, deposit: header.deposit };
  const now = new Date();
  const idle = order.ownerId && order.sideState === 'NONE' && isIdleTrackedStage(order.stage) ? Math.floor(idleDays(order.lastStaffActivityAt, now)) : 0;

  const idleThreshold = (await getSettings(ctx.db)).idle.remindOwnerDays;
  const [salespeople, lostReasons, origins, lastReturn] = await Promise.all([
    manager ? listSalespeople(ctx.db) : Promise.resolve([]),
    staff ? ctx.db.lostReason.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }) : Promise.resolve([]),
    staff ? ctx.db.leadOrigin.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }) : Promise.resolve([]),
    order.stage === 'RETURNED' ? ctx.db.handoffPackage.findFirst({ where: { orderId: order.id, decision: 'RETURNED' }, orderBy: { version: 'desc' }, include: { decidedBy: { select: { name: true } } } }) : Promise.resolve(null),
  ]);
  const tomorrow = inputDate(new Date(now.getTime() + 86_400_000));

  return (
    <>
      <PageHeader
        back={{ href: order.ownerId || !manager ? '/orders' : '/orders/unassigned', label: order.ownerId || !manager ? 'Orders' : 'Unassigned leads' }}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {fullName(order.customer)}
            <span className="text-sm font-normal text-slate-500">{order.orderNo}</span>
            <StageBadge stage={order.stage} sideState={order.sideState} />
          </span>
        }
        description={
          <>
            {formatAddress(order.property) || 'No address yet'} · {order.owner ? `Salesperson: ${order.owner.name}` : 'Unassigned'} · Lead source:{' '}
            {order.leadOrigin ? `${order.leadOrigin.label}${order.leadOriginNote ? ` (${order.leadOriginNote})` : ''}` : opened ? 'not recorded' : 'asked for when the job is opened'}
          </>
        }
        actions={
          staff && (
            <>
              {manager && (
                <Modal trigger={order.ownerId ? 'Reassign' : 'Assign'} title={order.ownerId ? 'Reassign this order' : 'Assign this lead'} variant={order.ownerId ? 'secondary' : 'primary'}>
                  <ActionForm action={assignOneAction.bind(null, order.id)} className="space-y-4">
                    <div>
                      <Label htmlFor="assign-owner">Salesperson</Label>
                      <Select id="assign-owner" name="ownerId" required defaultValue="">
                        <option value="" disabled>
                          Choose a salesperson
                        </option>
                        {salespeople
                          .filter((s) => s.id !== order.ownerId)
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} ({s.openOrders} open)
                            </option>
                          ))}
                        {order.ownerId && <option value="__pool__">Return to the unassigned pool</option>}
                      </Select>
                      <FieldError name="ownerId" />
                    </div>
                    <FormMessage />
                    <div className="flex justify-end gap-2">
                      <CancelButton />
                      <SubmitButton>{order.ownerId ? 'Reassign' : 'Assign'}</SubmitButton>
                    </div>
                  </ActionForm>
                </Modal>
              )}
              {opened && editable && (
                <Modal trigger={order.leadOrigin ? 'Lead source' : 'Record the lead source'} title="Where this customer came from" description="Partners are paid by this. Correct it when it turns out to be wrong.">
                  <ActionForm action={leadOriginAction.bind(null, order.id)} className="space-y-4">
                    <div>
                      <Label htmlFor="origin-id">Lead source</Label>
                      <Select id="origin-id" name="leadOriginId" required defaultValue={origins.some((o) => o.id === order.leadOriginId) ? (order.leadOriginId ?? '') : ''}>
                        <option value="" disabled>
                          Choose where the customer came from
                        </option>
                        {origins.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                      <FieldError name="leadOriginId" />
                    </div>
                    <div>
                      <Label htmlFor="origin-note" optional>
                        Who exactly
                      </Label>
                      <Input id="origin-note" name="leadOriginNote" maxLength={200} defaultValue={order.leadOriginNote} placeholder="The partner, or the person who referred them" />
                      <FieldError name="leadOriginNote" />
                    </div>
                    <FormMessage />
                    <div className="flex justify-end gap-2">
                      <CancelButton />
                      <SubmitButton>Save</SubmitButton>
                    </div>
                  </ActionForm>
                </Modal>
              )}
              {order.sideState === 'ON_HOLD' && <ActionButton action={resumeAction.bind(null, order.id)}>Take off hold</ActionButton>}
              {order.sideState === 'LOST' && can(user, 'orders.restoreLost') && <ActionButton action={restoreLostAction.bind(null, order.id)}>Restore</ActionButton>}
              {canHold(stateInput).ok && (
                <Modal trigger="Put on hold" title="Put this order on hold" description="For a customer who asks to be contacted later. Idle reminders pause until the date you set.">
                  <ActionForm action={holdAction.bind(null, order.id)} className="space-y-4">
                    <div>
                      <Label htmlFor="hold-until">Follow up on</Label>
                      <Input id="hold-until" name="until" type="date" required min={tomorrow} className="max-w-48" />
                      <p className="mt-1 text-xs text-slate-500">On this day the order comes off hold and you get a task to follow up.</p>
                      <FieldError name="until" />
                    </div>
                    <div>
                      <Label htmlFor="hold-note" optional>
                        Why
                      </Label>
                      <Textarea id="hold-note" name="note" rows={2} />
                    </div>
                    <FormMessage />
                    <div className="flex justify-end gap-2">
                      <CancelButton />
                      <SubmitButton>Put on hold</SubmitButton>
                    </div>
                  </ActionForm>
                </Modal>
              )}
              {canMarkLost(stateInput).ok && (
                <Modal trigger="Mark as lost" title="Mark this order as lost" variant="danger">
                  <ActionForm action={markLostAction.bind(null, order.id)} className="space-y-4">
                    <div>
                      <Label htmlFor="lost-reason">Reason</Label>
                      <Select id="lost-reason" name="reasonId" required defaultValue="">
                        <option value="" disabled>
                          Choose a reason
                        </option>
                        {lostReasons.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                      </Select>
                      <FieldError name="reasonId" />
                    </div>
                    <div>
                      <Label htmlFor="lost-note" optional>
                        Details
                      </Label>
                      <Textarea id="lost-note" name="note" rows={3} placeholder="Anything worth knowing if the customer comes back" />
                    </div>
                    <FormMessage />
                    <div className="flex justify-end gap-2">
                      <CancelButton />
                      <SubmitButton variant="danger">Mark as lost</SubmitButton>
                    </div>
                  </ActionForm>
                </Modal>
              )}
              {canCancel(stateInput).ok && (!withOps || manager) && (
                <Modal trigger="Cancel order" title="Cancel this order" variant="danger" description="For a customer who pulls out after paying a deposit.">
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
            </>
          )
        }
      />

      <div className="mb-4 space-y-2">
        <Card className="px-4 py-3">
          <StageTracker stage={order.stage} />
        </Card>
        {one(sp.notice) === 'merged' && <Alert tone="blue">This enquiry matched an order that is already in progress, so it was added to this order’s timeline instead of creating a second one.</Alert>}
        {!order.ownerId && manager && order.sideState === 'NONE' && !withOps && <Alert tone="amber">Nobody is working on this {opened ? 'order' : 'lead'} yet. Assign it to a salesperson.</Alert>}
        {staff && !opened && order.ownerId && order.sideState === 'NONE' && (
          <Card className="px-4 py-4 ring-2 ring-brand-200">
            <h2 className="text-sm font-semibold text-slate-900">Open this job</h2>
            <p className="mt-0.5 max-w-3xl text-sm text-slate-600">
              Until it is opened this is only a lead: nothing can be recorded on it. Opening it makes it {order.ownerId === user.id ? 'your' : `${order.owner?.name ?? 'the salesperson'}’s`} job, and asks where the customer came from. Partners are
              paid by that, so choose with care.
            </p>
            <ActionForm action={openJobAction.bind(null, order.id)} className="mt-3 flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="open-origin">Lead source</Label>
                <Select id="open-origin" name="leadOriginId" required defaultValue="" className="min-w-56">
                  <option value="" disabled>
                    Choose where the customer came from
                  </option>
                  {origins.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                <FieldError name="leadOriginId" />
              </div>
              <div className="min-w-56 flex-1">
                <Label htmlFor="open-note" optional>
                  Who exactly
                </Label>
                <Input id="open-note" name="leadOriginNote" maxLength={200} placeholder="The partner, or the person who referred them" />
                <FieldError name="leadOriginNote" />
              </div>
              <SubmitButton>Open job</SubmitButton>
              <FormMessage className="basis-full" />
            </ActionForm>
          </Card>
        )}
        {staff && opened && order.sideState === 'NONE' && isSalesEditableStage(order.stage) && order.stage !== 'RETURNED' && order.stage !== 'NEW' && (
          <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <p className="text-sm text-slate-700">
              <span className="font-medium text-slate-900">Next: </span>
              {STAGE_HINT[order.stage]}
            </p>
            <div className="flex flex-wrap gap-2">
              {order.stage === 'FOLLOW_UP' && (
                <ActionButton action={intentAction.bind(null, order.id, 'DESIGN')} variant="primary" size="sm">
                  The customer wants a proposal
                </ActionButton>
              )}
              {order.stage === 'DESIGN' && (
                <>
                  <LinkButton href={`${base}?tab=deal`} variant="primary" size="sm">
                    Design and proposal
                  </LinkButton>
                  <ActionButton action={intentAction.bind(null, order.id, 'FOLLOW_UP')} size="sm">
                    Back to following up
                  </ActionButton>
                </>
              )}
              {order.stage === 'PROPOSAL_SENT' && (
                <LinkButton href={`${base}?tab=deal`} variant="primary" size="sm">
                  Record the deposit
                </LinkButton>
              )}
              {order.stage === 'DEPOSIT_PAID' && (
                <LinkButton href={`${base}?tab=handoff`} variant="primary" size="sm">
                  Complete the folder and push
                </LinkButton>
              )}
            </div>
          </Card>
        )}
        {manager && order.possibleDuplicateOf && !order.duplicateDismissedAt && (
          <Alert tone="amber" title="Possible duplicate">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                Looks related to{' '}
                <Link href={`/orders/${order.possibleDuplicateOf.id}`} className="font-medium underline">
                  {order.possibleDuplicateOf.orderNo}
                </Link>{' '}
                ({fullName(order.possibleDuplicateOf.customer)}, {order.possibleDuplicateOf.owner?.name ?? 'unassigned'}): same address or shared contact details, but not clearly the same person.
              </span>
              <ActionButton action={dismissDuplicateAction.bind(null, order.id)} size="sm">
                Not a duplicate
              </ActionButton>
            </div>
          </Alert>
        )}
        {order.stage === 'RETURNED' && order.sideState === 'NONE' && lastReturn && (
          <Alert tone="red" title={`Returned by operations${lastReturn.decidedBy ? ` (${lastReturn.decidedBy.name})` : ''} on ${fmtDate(lastReturn.decidedAt)}`}>
            <p className="whitespace-pre-wrap">{lastReturn.returnReason}</p>
            <p className="mt-1">
              Sort it out, then push again from the{' '}
              <Link href={`${base}?tab=handoff`} className="font-medium underline">
                Handoff
              </Link>{' '}
              tab.
            </p>
          </Alert>
        )}
        {order.stage === 'PUSHED' && order.sideState === 'NONE' && <Alert tone="amber">Pushed to operations on {fmtDateTime(order.pushedAt)}, who have not accepted it yet. It can be changed again if they return it.</Alert>}
        {withOps && order.sideState === 'NONE' && (
          <Alert tone={order.stage === 'INSTALLED' ? 'amber' : 'green'}>
            {order.stage === 'IN_PROGRESS' && <>Accepted by operations on {fmtDate(order.handedOverAt)}. They are arranging the installation. </>}
            {order.stage === 'INSTALLED' && <>The installation was done on {fmtDate(order.jobDoneAt)}. The customer has been asked for the balance. </>}
            {order.stage === 'COMPLETED' && <>The final payment arrived and the job was closed on {fmtDate(order.completedAt)}. </>}
            <Link href={`${base}?tab=operations`} className="font-medium underline">
              See how it stands with operations
            </Link>
            . You can still add notes and write to the customer.
          </Alert>
        )}
        {order.sideState === 'ON_HOLD' && (
          <Alert tone="amber" title={`On hold until ${fmtDate(order.onHoldUntil)}`}>
            {order.onHoldNote}
          </Alert>
        )}
        {order.sideState === 'LOST' && (
          <Alert tone="red" title={`Lost: ${order.lostReason?.label ?? 'no reason recorded'}`}>
            {order.lostNote}
            {!can(user, 'orders.restoreLost') && <p className="mt-1">A manager can restore it if the customer comes back.</p>}
          </Alert>
        )}
        {order.sideState === 'CANCELLED' && (
          <Alert tone="red" title={`Cancelled on ${fmtDate(order.cancelledAt)}`}>
            <p className="whitespace-pre-wrap">{order.cancelNote}</p>
            <p className="mt-1">
              Refund: <Badge tone={order.refundStatus === 'PENDING' ? 'amber' : 'slate'}>{REFUND_LABEL[order.refundStatus]}</Badge>
            </p>
          </Alert>
        )}
        {idle >= idleThreshold && <Alert tone="amber">No activity has been recorded on this order for {idle} days.</Alert>}
        {staff && !editable && order.stage !== 'PUSHED' && !withOps && order.sideState === 'NONE' && <Alert tone="slate">{editBlockReason(order)}</Alert>}
      </div>

      <Tabs
        current={tab}
        tabs={[
          { key: 'overview', label: 'Overview', href: base },
          { key: 'email', label: 'Email', href: `${base}?tab=email` },
          { key: 'documents', label: 'Documents', href: `${base}?tab=documents` },
          { key: 'deal', label: 'Proposal & deposit', href: `${base}?tab=deal` },
          { key: 'handoff', label: 'Handoff', href: `${base}?tab=handoff` },
          ...(showOperations ? [{ key: 'operations', label: 'Operations', href: `${base}?tab=operations` }] : []),
          ...(showHistory ? [{ key: 'history', label: 'History', href: `${base}?tab=history` }] : []),
        ]}
      />

      {tab === 'overview' && <OverviewTab ctx={ctx} header={header} editable={editable} staff={staff} opened={opened} />}
      {tab === 'email' && <EmailTab ctx={ctx} header={header} staff={staff && opened} editable={workable} />}
      {tab === 'documents' && <DocumentsTab ctx={ctx} header={header} editable={workable} staff={staff} />}
      {tab === 'deal' && <DealTab ctx={ctx} header={header} editable={workable} staff={staff} manager={manager} />}
      {tab === 'handoff' && <HandoffTab ctx={ctx} header={header} editable={workable} staff={staff} />}
      {tab === 'operations' && showOperations && <OperationsTab ctx={ctx} orderId={order.id} />}
      {tab === 'history' && showHistory && <HistoryTab ctx={ctx} orderId={order.id} />}
    </>
  );
}

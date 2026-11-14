import Link from 'next/link';
import { getOrderHandoff, isWithOperations, type Ctx, type OrderHeader } from '@bluven/core';
import { assistantConfigured, getAssistantSettings, storedBrief } from '@bluven/integrations';
import { BriefCard } from '@/components/assistant';
import { ActionForm, FormMessage, SubmitButton } from '@/components/client';
import { Alert, Badge, Card, CardBody, CardHeader, Label, Textarea, cx } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import { handoffAction, writeBriefAction } from './actions';

export async function HandoffTab({ ctx, header, editable, staff }: { ctx: Ctx; header: OrderHeader; editable: boolean; staff: boolean }) {
  const { order } = header;
  const { checklist, packages } = await getOrderHandoff(ctx, order.id);
  const base = `/orders/${order.id}`;
  const accepted = isWithOperations(order.stage);
  const withOps = order.stage === 'PUSHED' || accepted;
  const canPush = staff && editable && checklist.complete && order.sideState === 'NONE' && (order.stage === 'DEPOSIT_PAID' || order.stage === 'RETURNED');
  // The e-mails that go to the customer once operations has the order need an address somebody has confirmed.
  const addresses = withOps ? [] : await ctx.db.customerEmail.findMany({ where: { customerId: order.customerId }, select: { email: true, unconfirmed: true } });
  const noConfirmedAddress = !withOps && !addresses.some((a) => !a.unconfirmed);
  const labelFor = new Map(checklist.items.map((i) => [i.key, i.label]));
  const latest = packages[0];
  const assistant = assistantConfigured();
  // Shortly after a push the brief is on its way; later, a missing one has to be asked for.
  const now = new Date();
  const briefOnItsWay = !!latest && assistant && latest.decision === 'PENDING' && now.getTime() - latest.pushedAt.getTime() < 10 * 60_000 && (await getAssistantSettings(ctx.db)).autoBrief;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader
          title="The folder"
          description="What has to be on file before the order can go to operations: the proposal the customer accepted, the proof of the deposit, the bill and the photos."
          actions={checklist.complete ? <Badge tone="green">Complete</Badge> : <Badge tone="amber">{checklist.items.filter((i) => !i.ok).length} to go</Badge>}
        />
        <ul className="divide-y divide-slate-100">
          {checklist.items.map((item) => {
            const href = item.key === 'address' ? base : item.typeId ? `${base}?tab=documents#type-${item.key.replace('doc:', '')}` : `${base}?tab=deal`;
            return (
              <li key={item.key} className="flex items-start gap-3 px-4 py-3">
                <span
                  aria-hidden
                  className={cx('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold', item.ok ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700')}
                >
                  {item.ok ? '✓' : '!'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">
                    {item.label}
                    <span className="sr-only">{item.ok ? ': done' : ': missing'}</span>
                  </p>
                  <p className="text-sm text-slate-500">{item.detail}</p>
                </div>
                {!item.ok && editable && (
                  <Link href={href} className="shrink-0 text-xs font-medium text-brand-700 hover:underline">
                    Fix
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader
            title="Send to operations"
            description="Operations cannot see this order until you push it. When they accept it they confirm that the deposit has arrived, and the customer gets a welcome e-mail. They send an order back only when they cannot sort something out without you."
          />
          <CardBody>
            {withOps ? (
              <Alert tone={accepted ? 'green' : 'amber'}>
                {accepted ? (
                  <>
                    Accepted by operations on {fmtDateTime(order.handedOverAt)}.{' '}
                    <Link href={`${base}?tab=operations`} className="font-medium underline">
                      See how the job stands
                    </Link>
                    .
                  </>
                ) : (
                  `Pushed on ${fmtDateTime(order.pushedAt)}. Waiting for operations to accept it.`
                )}
              </Alert>
            ) : !staff || !editable ? (
              <p className="text-sm text-slate-500">This order cannot be pushed in its current state.</p>
            ) : (
              <ActionForm action={handoffAction.bind(null, order.id)} keepValues className="space-y-4">
                <div>
                  <Label htmlFor="handoff-notes" optional>
                    Notes for operations
                  </Label>
                  <Textarea
                    id="handoff-notes"
                    name="notes"
                    rows={5}
                    defaultValue={order.handoffNotes}
                    placeholder="Preferred install times, access, pets, anything promised to the customer, anything unusual about the site"
                  />
                </div>
                {!checklist.complete && <Alert tone="amber">Complete the folder to enable the push.</Alert>}
                {noConfirmedAddress && (
                  <Alert tone="amber">
                    {addresses.length > 0
                      ? `Nobody has confirmed that ${addresses[0]!.email} is the customer’s address. Confirm it on the Overview tab, or the welcome e-mail will not go out when operations accepts.`
                      : 'The customer has no e-mail address on record, so the welcome e-mail cannot go out when operations accepts. Add one on the Overview tab if they have one.'}
                  </Alert>
                )}
                {checklist.complete && order.sideState === 'ON_HOLD' && <Alert tone="amber">Take the order off hold before pushing it.</Alert>}
                <FormMessage />
                <div className="flex flex-wrap gap-2">
                  <SubmitButton name="intent" value="push" pendingLabel="Sending…" disabled={!canPush} title={canPush ? undefined : 'Complete the folder first'}>
                    {order.stage === 'RETURNED' ? 'Push to operations again' : 'Push to operations'}
                  </SubmitButton>
                  <SubmitButton name="intent" value="save" variant="secondary">
                    Save notes
                  </SubmitButton>
                </div>
              </ActionForm>
            )}
          </CardBody>
        </Card>

        {latest && <BriefCard brief={storedBrief(latest.brief)} writtenAt={latest.briefAt} available={assistant} automatic={briefOnItsWay} write={staff ? writeBriefAction.bind(null, order.id) : undefined} />}

        {packages.length > 0 && (
          <Card>
            <CardHeader title="Submissions" />
            <ul className="divide-y divide-slate-100">
              {packages.map((p) => (
                <li key={p.id} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-900">Submission {p.version}</span>
                    <Badge tone={p.decision === 'ACCEPTED' ? 'green' : p.decision === 'RETURNED' ? 'red' : p.decision === 'PENDING' ? 'amber' : 'slate'}>
                      {p.decision === 'ACCEPTED' ? 'Accepted' : p.decision === 'RETURNED' ? 'Returned' : p.decision === 'PENDING' ? 'Waiting' : 'Withdrawn'}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Pushed {fmtDateTime(p.pushedAt)}
                    {p.pushedBy ? ` by ${p.pushedBy.name}` : ''}
                    {p.decidedAt ? ` · ${p.decision === 'ACCEPTED' ? 'accepted' : p.decision === 'RETURNED' ? 'returned' : 'closed'} ${fmtDateTime(p.decidedAt)}${p.decidedBy ? ` by ${p.decidedBy.name}` : ''}` : ''}
                  </p>
                  {p.returnReason && <p className="mt-1.5 rounded-md bg-red-50 px-3 py-2 whitespace-pre-wrap text-red-800">{p.returnReason}</p>}
                  {p.returnMissing.length > 0 && <p className="mt-1 text-xs text-slate-600">Flagged: {p.returnMissing.map((k) => labelFor.get(k) ?? k).join(', ')}</p>}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

import Link from 'next/link';
import { getOrderHandoff, type Ctx, type OrderHeader } from '@bluven/core';
import { ActionForm, FormMessage, SubmitButton } from '@/components/client';
import { Alert, Badge, Card, CardBody, CardHeader, Label, Textarea, cx } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import { handoffAction } from './actions';

export async function HandoffTab({ ctx, header, editable, staff }: { ctx: Ctx; header: OrderHeader; editable: boolean; staff: boolean }) {
  const { order } = header;
  const { checklist, packages } = await getOrderHandoff(ctx, order.id);
  const base = `/orders/${order.id}`;
  const withOps = order.stage === 'PUSHED' || order.stage === 'HANDED_OVER';
  const canPush = staff && editable && checklist.complete && order.sideState === 'NONE' && (order.stage === 'DEPOSIT_CONFIRMED' || order.stage === 'RETURNED');
  const labelFor = new Map(checklist.items.map((i) => [i.key, i.label]));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader
          title="Checklist"
          description="Everything operations needs before they can take the order."
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
          <CardHeader title="Send to operations" description="Operations cannot see this order until you push it. They either accept it or return it with a reason." />
          <CardBody>
            {withOps ? (
              <Alert tone={order.stage === 'HANDED_OVER' ? 'green' : 'amber'}>
                {order.stage === 'HANDED_OVER' ? `Accepted by operations on ${fmtDateTime(order.handedOverAt)}.` : `Pushed on ${fmtDateTime(order.pushedAt)}. Waiting for operations to accept or return it.`}
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
                {!checklist.complete && <Alert tone="amber">Complete the checklist to enable the push.</Alert>}
                {checklist.complete && order.sideState === 'ON_HOLD' && <Alert tone="amber">Take the order off hold before pushing it.</Alert>}
                <FormMessage />
                <div className="flex flex-wrap gap-2">
                  <SubmitButton name="intent" value="push" pendingLabel="Sending…" disabled={!canPush} title={canPush ? undefined : 'Complete the checklist first'}>
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

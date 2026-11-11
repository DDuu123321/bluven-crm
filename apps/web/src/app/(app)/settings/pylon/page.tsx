import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can, getConfig } from '@bluven/core';
import { HANDLED_EVENTS, getPylonSyncState } from '@bluven/integrations';
import { ActionButton } from '@/components/client';
import { Alert, Badge, Card, CardBody, CardHeader, Dl, EmptyState, PageHeader, Table, Td, type Tone } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import { requireSession } from '@/lib/session';
import { retryPylonEventAction } from './actions';

export const metadata: Metadata = { title: 'Pylon' };

const STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'Waiting', tone: 'amber' },
  PROCESSED: { label: 'Done', tone: 'green' },
  IGNORED: { label: 'No action needed', tone: 'slate' },
  FAILED: { label: 'Failed', tone: 'red' },
};

export default async function PylonPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { user, ctx } = await requireSession();
  if (!can(user, 'admin.pylon')) notFound();
  const config = getConfig();
  const showAll = (await searchParams).show === 'all';
  // A busy Pylon account sends hundreds of events a day about projects that are not CRM orders.
  // They are kept for a month for reference, but they are not what this page is for.
  const relevant = { OR: [{ orderId: { not: null } }, { status: { in: ['PENDING' as const, 'FAILED' as const] } }] };
  const [events, counts, lastReceived, sync, unrelated] = await Promise.all([
    ctx.db.pylonEvent.findMany({ where: showAll ? {} : relevant, orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 100 }),
    ctx.db.pylonEvent.groupBy({ by: ['status'], _count: { _all: true } }),
    ctx.db.pylonEvent.findFirst({ orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
    getPylonSyncState(ctx.db),
    ctx.db.pylonEvent.count({ where: { status: 'IGNORED', orderId: null } }),
  ]);
  const orderNos = new Map(
    (await ctx.db.order.findMany({ where: { id: { in: [...new Set(events.map((e) => e.orderId).filter((x): x is string => !!x))] } }, select: { id: true, orderNo: true } })).map((o) => [o.id, o.orderNo]),
  );
  const count = (status: string) => counts.find((c) => c.status === status)?._count._all ?? 0;
  const ready = !!config.pylon.apiToken;
  const reading = sync?.lastOkAt ? new Date(sync.lastOkAt) : null;

  return (
    <>
      <PageHeader title="Pylon" description="Designs are made in Pylon. Pylon tells the CRM when a design changes, when a customer signs a web proposal and when a deposit is paid through its payment gateway." />
      <div className="mb-4 space-y-2">
        {!ready && (
          <Alert tone="amber" title="The CRM is not connected to Pylon">
            Set PYLON_API_TOKEN in the server environment and restart the web and worker processes. Until then, quotes and contracts are entered by hand, which always works.
          </Alert>
        )}
        {ready && sync?.lastError && (
          <Alert tone="red" title="The CRM cannot read from Pylon">
            {sync.lastError} Quotes, signatures and payments from Pylon are not arriving{reading ? ` (last successful read ${fmtDateTime(reading)})` : ''}. The usual cause is an API token that was deleted or replaced in Pylon.
          </Alert>
        )}
        {count('FAILED') > 0 && <Alert tone="red">{count('FAILED')} event{count('FAILED') === 1 ? '' : 's'} could not be processed. Check the reason below, fix the cause, then retry.</Alert>}
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Connection" />
          <CardBody>
            <Dl
              rows={[
                ['API token', config.pylon.apiToken ? <Badge key="t" tone="green">Configured</Badge> : <Badge key="t" tone="amber">Missing</Badge>],
                [
                  'Reading Pylon’s events',
                  !ready ? 'off' : sync?.lastError ? <Badge key="r" tone="red">Failing</Badge> : reading ? `every minute, last read ${fmtDateTime(reading)}` : 'starts within a minute of the worker starting',
                ],
                ['Webhook (optional)', config.pylon.webhookSecret ? <Badge key="s" tone="green">Configured</Badge> : <span key="s" className="text-slate-500">Not set up. Events still arrive, within a minute.</span>],
                ['API address', config.pylon.apiBase],
                ['Last event received', lastReceived ? fmtDateTime(lastReceived.receivedAt) : 'never'],
                ['Waiting / failed', `${count('PENDING')} / ${count('FAILED')}`],
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Setting it up in Pylon" />
          <CardBody className="space-y-2 text-sm text-slate-600">
            <p>In Pylon, open Settings, then Integrations &amp; API, then API settings.</p>
            <ol className="list-decimal space-y-1.5 pl-5">
              <li>
                Create an API token with the “Read” permission and put it in PYLON_API_TOKEN. Pylon shows the token only once, when it is created. <strong className="font-medium text-slate-900">This is all that is needed</strong>: the CRM
                reads Pylon’s events every minute.
              </li>
              <li>
                Optional, for events to arrive within seconds: add a webhook destination with this URL
                <code className="mt-1 block rounded bg-slate-100 px-2 py-1 font-mono text-xs break-all text-slate-900">{config.appUrl}/api/webhooks/pylon</code>
                for the event types <span className="font-mono text-xs text-slate-900">{HANDLED_EVENTS.join(', ')}</span>, and put the secret Pylon shows once in PYLON_WEBHOOK_SECRET.
              </li>
            </ol>
            <p>
              An order finds its Pylon project in one of two ways: the salesperson starts the project with “Design in Pylon”, which passes the CRM order number as the project’s reference number; or, for a project that already exists, they
              paste its address under “Link Pylon project” on the order.
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Recent events"
          description={showAll ? 'The latest 100 events received from Pylon, whatever they concern.' : 'The latest 100 events that concern a CRM order, are waiting, or failed.'}
          actions={
            <Link href={showAll ? '/settings/pylon' : '/settings/pylon?show=all'} className="text-sm text-brand-700 hover:underline">
              {showAll ? 'Only events that concern an order' : `Show all (${unrelated} about projects that are not CRM orders)`}
            </Link>
          }
        />
        {events.length === 0 ? (
          <EmptyState title="No events yet">{ready ? 'Events appear here once a project in Pylon is linked to an order.' : 'Events appear here once the CRM is connected to Pylon.'}</EmptyState>
        ) : (
          <Table head={['Received', 'Event', 'Order', 'Status', 'Result', '']}>
            {events.map((e) => {
              const status = STATUS[e.status] ?? STATUS.PENDING!;
              return (
                <tr key={e.id}>
                  <Td className="whitespace-nowrap text-slate-600">{fmtDateTime(e.receivedAt)}</Td>
                  <Td className="font-mono text-xs text-slate-900">{e.name}</Td>
                  <Td>
                    {e.orderId && orderNos.has(e.orderId) ? (
                      <Link href={`/orders/${e.orderId}?tab=deal`} className="text-brand-700 hover:underline">
                        {orderNos.get(e.orderId)}
                      </Link>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={status.tone}>{status.label}</Badge>
                    {e.status === 'PENDING' && e.attempts > 0 && <div className="mt-1 text-xs text-slate-500">attempt {e.attempts}, next {fmtDateTime(e.nextAttemptAt)}</div>}
                  </Td>
                  <Td className="max-w-md text-slate-600">{e.lastError ? <span className="text-red-700">{e.lastError}</span> : e.resultNote}</Td>
                  <Td className="text-right">
                    {(e.status === 'FAILED' || e.status === 'IGNORED') && (
                      <ActionButton action={retryPylonEventAction.bind(null, e.id)} size="sm">
                        Try again
                      </ActionButton>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}

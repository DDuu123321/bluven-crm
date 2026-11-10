import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can, formatAddress, fullName, listHandoffs, relativeTime } from '@bluven/core';
import { Badge, Card, EmptyState, LinkButton, PageHeader, Table, Tabs, Td } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import { one } from '@/lib/params';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Incoming orders' };

export default async function OpsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, ctx } = await requireSession();
  if (!can(user, 'ops.handoffs')) notFound();
  const sp = await searchParams;
  const tab = one(sp.tab) === 'returned' ? 'returned' : one(sp.tab) === 'accepted' ? 'accepted' : 'incoming';
  const [incoming, returned] = await Promise.all([listHandoffs(ctx, 'PENDING'), listHandoffs(ctx, 'RETURNED')]);
  const accepted = tab === 'accepted' ? await listHandoffs(ctx, 'ACCEPTED') : [];
  const rows = tab === 'incoming' ? incoming : tab === 'returned' ? returned : accepted;
  const now = new Date();

  return (
    <>
      <PageHeader title="Incoming orders" description="Orders that sales has finished and pushed to operations. Accept an order to take it on, or return it with a reason if something is missing or unclear." />
      <Tabs
        current={tab}
        tabs={[
          { key: 'incoming', label: 'Waiting for you', href: '/ops', count: incoming.length },
          { key: 'returned', label: 'Returned to sales', href: '/ops?tab=returned', count: returned.length },
          { key: 'accepted', label: 'Accepted', href: '/ops?tab=accepted' },
        ]}
      />
      <Card>
        {rows.length === 0 ? (
          <EmptyState title={tab === 'incoming' ? 'Nothing is waiting' : tab === 'returned' ? 'Nothing is with sales for fixing' : 'No accepted orders yet'}>
            {tab === 'incoming' && 'You are notified as soon as sales pushes an order.'}
          </EmptyState>
        ) : (
          <Table head={['Order', 'Customer', 'Address', 'Salesperson', tab === 'incoming' ? 'Pushed' : tab === 'returned' ? 'Returned' : 'Accepted', '']}>
            {rows.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50/60">
                <Td>
                  <span className="font-medium text-slate-900">{p.order.orderNo}</span>
                  {p.version > 1 && (
                    <div className="mt-0.5">
                      <Badge tone="blue">Submission {p.version}</Badge>
                    </div>
                  )}
                </Td>
                <Td className="text-slate-900">{fullName(p.order.customer)}</Td>
                <Td className="max-w-64 text-slate-600">{formatAddress(p.order.property)}</Td>
                <Td className="text-slate-600">{p.order.owner?.name ?? p.pushedBy?.name}</Td>
                <Td className="text-slate-600">
                  <span title={fmtDateTime(tab === 'incoming' ? p.pushedAt : p.decidedAt)}>{relativeTime((tab === 'incoming' ? p.pushedAt : p.decidedAt) ?? p.pushedAt, now)}</span>
                  {tab !== 'incoming' && p.decidedBy && <div className="text-xs text-slate-500">by {p.decidedBy.name}</div>}
                </Td>
                <Td className="text-right">
                  <LinkButton href={`/ops/orders/${p.order.id}`} size="sm" variant={tab === 'incoming' ? 'primary' : 'secondary'}>
                    {tab === 'incoming' ? 'Review' : 'Open'}
                  </LinkButton>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

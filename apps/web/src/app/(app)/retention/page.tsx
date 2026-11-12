import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can, formatBytes, listRetentionOrders } from '@bluven/core';
import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, Td } from '@/components/ui';
import { fmtDate } from '@/lib/fmt';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Documents to review' };

const ENDED: Record<string, string> = { LOST: 'Lost', CANCELLED: 'Cancelled', HANDED_OVER: 'Handed over' };

export default async function RetentionPage() {
  const { user, ctx } = await requireSession();
  if (!can(user, 'orders.assign')) notFound();
  const { rows, total, settings } = await listRetentionOrders(ctx);

  return (
    <>
      <PageHeader
        title="Documents to review"
        description={`Documents are kept for ${settings.years} year${settings.years === 1 ? '' : 's'} after an order ended, unless their type says otherwise. These orders have documents at or near the end of that period. Open one to keep them for another year or to delete them.`}
      />
      <Card>
        <CardHeader
          title={`${total} order${total === 1 ? '' : 's'} waiting for a decision`}
          description={settings.autoDelete ? 'Automatic deletion is on: what nobody decides about is deleted on the date shown.' : 'Nothing is deleted until someone decides.'}
        />
        {rows.length === 0 ? (
          <EmptyState title="Nothing to review">No order has documents within {settings.reminderDays} days of the end of their retention period.</EmptyState>
        ) : (
          <Table head={['Order', 'Customer', 'Salesperson', 'Ended', 'Period ends', 'Documents', ...(settings.autoDelete ? ['Deleted on'] : [])]}>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  <Link href={`/orders/${r.id}?tab=documents#retention`} className="font-medium text-brand-700 hover:underline">
                    {r.orderNo}
                  </Link>
                </Td>
                <Td className="text-slate-900">{r.customerName}</Td>
                <Td className="text-slate-600">{r.ownerName ?? 'Unassigned'}</Td>
                <Td className="whitespace-nowrap text-slate-600">
                  {ENDED[r.ended]} {fmtDate(r.endedAt)}
                </Td>
                <Td className="whitespace-nowrap">
                  {fmtDate(r.deadline)} {r.past ? <Badge tone="red">Past</Badge> : <Badge tone="amber">Soon</Badge>}
                </Td>
                <Td className="whitespace-nowrap text-slate-600">
                  {r.documents} · {formatBytes(r.sizeBytes)}
                </Td>
                {settings.autoDelete && <Td className="whitespace-nowrap text-slate-600">{r.autoDeleteAt ? fmtDate(r.autoDeleteAt) : ''}</Td>}
              </tr>
            ))}
          </Table>
        )}
        {total > rows.length && <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">The {rows.length} most urgent are shown.</p>}
      </Card>
    </>
  );
}

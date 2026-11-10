import { getOrderAudit, type Ctx } from '@bluven/core';
import { AuditTable } from '@/components/audit-table';
import { Card, CardHeader } from '@/components/ui';

export async function HistoryTab({ ctx, orderId }: { ctx: Ctx; orderId: string }) {
  const rows = await getOrderAudit(ctx, orderId);
  return (
    <Card>
      <CardHeader title="Change history" description="Every change to this order: who, when, and the values before and after. Entries cannot be edited or removed." />
      <AuditTable rows={rows.map((r) => ({ ...r, orderNo: null }))} showOrder={false} />
    </Card>
  );
}

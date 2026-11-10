import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can, listSalespeople } from '@bluven/core';
import { ActionForm, FormMessage, SubmitButton } from '@/components/client';
import { Card, CardBody, CardHeader, Checkbox, Label, LinkButton, PageHeader, Select, Table, Td } from '@/components/ui';
import { requireSession } from '@/lib/session';
import { transferAction } from '../orders/actions';

export const metadata: Metadata = { title: 'Team' };

export default async function TeamPage() {
  const { user, ctx } = await requireSession();
  if (!can(user, 'orders.assign')) notFound();
  const salespeople = await listSalespeople(ctx.db);
  // People who still own orders but can no longer be assigned new ones (left, or role removed).
  const former = await ctx.db.user.findMany({
    where: { ownedOrders: { some: {} }, NOT: { AND: [{ isActive: true }, { roles: { has: 'SALES' } }] } },
    select: { id: true, name: true, isActive: true, _count: { select: { ownedOrders: true } } },
    orderBy: { name: 'asc' },
  });

  return (
    <>
      <PageHeader title="Team" description="Who is carrying what, and a way to move a person's orders to a colleague when they leave or go on holiday." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Salespeople" />
          {salespeople.length === 0 ? (
            <CardBody>
              <p className="text-sm text-slate-500">No active salespeople yet. An administrator can add users under Users.</p>
            </CardBody>
          ) : (
            <Table head={['Name', 'Orders in progress', '']}>
              {salespeople.map((s) => (
                <tr key={s.id}>
                  <Td className="font-medium text-slate-900">{s.name}</Td>
                  <Td className="tabular-nums text-slate-600">{s.openOrders}</Td>
                  <Td className="text-right">
                    <LinkButton href={`/orders?owner=${s.id}`} size="sm" variant="ghost">
                      View orders
                    </LinkButton>
                  </Td>
                </tr>
              ))}
              {former.map((f) => (
                <tr key={f.id}>
                  <Td className="text-slate-500">
                    {f.name} <span className="text-xs">({f.isActive ? 'no longer in sales' : 'deactivated'})</span>
                  </Td>
                  <Td className="tabular-nums text-slate-600">{f._count.ownedOrders} in total</Td>
                  <Td className="text-right">
                    <LinkButton href={`/orders?owner=${f.id}&view=all`} size="sm" variant="ghost">
                      View orders
                    </LinkButton>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Transfer orders" description="Open tasks move with the orders, and both people are notified." />
          <CardBody>
            <ActionForm action={transferAction} className="space-y-4" confirm="Transfer these orders now?">
              <div>
                <Label htmlFor="fromUserId">From</Label>
                <Select id="fromUserId" name="fromUserId" required defaultValue="">
                  <option value="" disabled>
                    Choose a person
                  </option>
                  {[...salespeople.map((s) => ({ id: s.id, label: `${s.name} (${s.openOrders} in progress)` })), ...former.map((f) => ({ id: f.id, label: `${f.name} (${f._count.ownedOrders} in total)` }))].map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="toUserId">To</Label>
                <Select id="toUserId" name="toUserId" required defaultValue="">
                  <option value="" disabled>
                    Choose a salesperson
                  </option>
                  {salespeople.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Checkbox name="onlyOpen" defaultChecked label="Only orders in progress. Leave lost, cancelled and handed-over orders where they are." />
              <FormMessage />
              <SubmitButton pendingLabel="Transferring…">Transfer</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

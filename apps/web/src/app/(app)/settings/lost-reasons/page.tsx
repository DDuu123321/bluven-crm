import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@bluven/core';
import { ActionForm, CancelButton, FieldError, FormMessage, Modal, SubmitButton } from '@/components/client';
import { Badge, Card, Checkbox, Input, Label, PageHeader, Table, Td } from '@/components/ui';
import { requireSession } from '@/lib/session';
import { createLostReasonAction, updateLostReasonAction } from '../actions';

export const metadata: Metadata = { title: 'Lost reasons' };

export default async function LostReasonsPage() {
  const { user, ctx } = await requireSession();
  if (!can(user, 'config.manage')) notFound();
  const reasons = await ctx.db.lostReason.findMany({ orderBy: { sortOrder: 'asc' }, include: { _count: { select: { orders: true } } } });

  return (
    <>
      <PageHeader
        title="Lost reasons"
        description="The reasons sales can choose from when marking an order as lost. They drive the “why orders were lost” figures on the dashboard."
        actions={
          <Modal trigger="Add reason" title="Add a lost reason" variant="primary" size="md">
            <ActionForm action={createLostReasonAction} className="space-y-4">
              <div>
                <Label htmlFor="new-reason">Reason</Label>
                <Input id="new-reason" name="label" required maxLength={100} />
                <FieldError name="label" />
              </div>
              <FormMessage />
              <div className="flex justify-end gap-2">
                <CancelButton />
                <SubmitButton>Add</SubmitButton>
              </div>
            </ActionForm>
          </Modal>
        }
      />
      <Card>
        <Table head={['Reason', 'Orders lost for this reason', 'Status', '']}>
          {reasons.map((r) => (
            <tr key={r.id} className={r.isActive ? '' : 'opacity-60'}>
              <Td className="font-medium text-slate-900">{r.label}</Td>
              <Td className="tabular-nums text-slate-600">{r._count.orders}</Td>
              <Td>{r.isActive ? <Badge tone="green">In use</Badge> : <Badge>Hidden</Badge>}</Td>
              <Td className="text-right">
                <Modal trigger="Edit" title="Edit lost reason" size="sm">
                  <ActionForm action={updateLostReasonAction.bind(null, r.id)} keepValues className="space-y-4">
                    <div>
                      <Label htmlFor={`reason-${r.id}`}>Reason</Label>
                      <Input id={`reason-${r.id}`} name="label" defaultValue={r.label} required maxLength={100} />
                      <FieldError name="label" />
                    </div>
                    <div className="max-w-40">
                      <Label htmlFor={`sort-${r.id}`}>Position in the list</Label>
                      <Input id={`sort-${r.id}`} name="sortOrder" inputMode="numeric" defaultValue={r.sortOrder} />
                    </div>
                    <Checkbox name="isActive" defaultChecked={r.isActive} label="In use. Untick to hide it from the list; orders already lost for this reason keep it." />
                    <FormMessage />
                    <div className="flex justify-end gap-2">
                      <CancelButton />
                      <SubmitButton>Save</SubmitButton>
                    </div>
                  </ActionForm>
                </Modal>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}

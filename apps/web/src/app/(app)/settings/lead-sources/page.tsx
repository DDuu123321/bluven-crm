import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@bluven/core';
import { ActionForm, CancelButton, FieldError, FormMessage, Modal, SubmitButton } from '@/components/client';
import { Badge, Card, Checkbox, Input, Label, PageHeader, Table, Td } from '@/components/ui';
import { requireSession } from '@/lib/session';
import { createLeadOriginAction, updateLeadOriginAction } from '../actions';

export const metadata: Metadata = { title: 'Lead sources' };

export default async function LeadOriginsPage() {
  const { user, ctx } = await requireSession();
  if (!can(user, 'config.manage')) notFound();
  const origins = await ctx.db.leadOrigin.findMany({ orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }], include: { _count: { select: { orders: true } } } });

  return (
    <>
      <PageHeader
        title="Lead sources"
        description="Where a customer came from. The salesperson chooses one from this list when opening a job, and can add who exactly in a note. Partners are paid by it, and the dashboard counts deposits by it. It is never worked out automatically."
        actions={
          <Modal trigger="Add lead source" title="Add a lead source" variant="primary" size="md">
            <ActionForm action={createLeadOriginAction} className="space-y-4">
              <div>
                <Label htmlFor="new-origin">Name</Label>
                <Input id="new-origin" name="label" required maxLength={100} placeholder="For example the name of a partner" />
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
        <Table head={['Lead source', 'Orders', 'Status', '']}>
          {origins.map((o) => (
            <tr key={o.id} className={o.isActive ? '' : 'opacity-60'}>
              <Td className="font-medium text-slate-900">{o.label}</Td>
              <Td className="tabular-nums text-slate-600">{o._count.orders}</Td>
              <Td>{o.isActive ? <Badge tone="green">In use</Badge> : <Badge>Hidden</Badge>}</Td>
              <Td className="text-right">
                <Modal trigger="Edit" title="Edit lead source" size="sm">
                  <ActionForm action={updateLeadOriginAction.bind(null, o.id)} keepValues className="space-y-4">
                    <div>
                      <Label htmlFor={`origin-${o.id}`}>Name</Label>
                      <Input id={`origin-${o.id}`} name="label" defaultValue={o.label} required maxLength={100} />
                      <FieldError name="label" />
                    </div>
                    <div className="max-w-40">
                      <Label htmlFor={`origin-sort-${o.id}`}>Position in the list</Label>
                      <Input id={`origin-sort-${o.id}`} name="sortOrder" inputMode="numeric" defaultValue={o.sortOrder} />
                      <FieldError name="sortOrder" />
                    </div>
                    <Checkbox name="isActive" defaultChecked={o.isActive} label="In use. Untick to take it out of the choices; orders that carry it keep it." />
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

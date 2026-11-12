import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can } from '@bluven/core';
import type { DocumentType } from '@bluven/db';
import { ActionForm, CancelButton, FieldError, FormMessage, Modal, SubmitButton } from '@/components/client';
import { Alert, Badge, Card, Checkbox, Input, Label, PageHeader, Select, Table, Td, Textarea } from '@/components/ui';
import { requireSession } from '@/lib/session';
import { createDocumentTypeAction, updateDocumentTypeAction } from '../actions';

export const metadata: Metadata = { title: 'Handoff checklist' };

function TypeFields({ t }: { t?: DocumentType }) {
  const id = t?.id ?? 'new';
  return (
    <>
      <div>
        <Label htmlFor={`label-${id}`}>Name</Label>
        <Input id={`label-${id}`} name="label" defaultValue={t?.label} required placeholder="For example: Roof photos" />
        <FieldError name="label" />
      </div>
      <div>
        <Label htmlFor={`desc-${id}`} optional>
          Guidance for sales
        </Label>
        <Textarea id={`desc-${id}`} name="description" rows={2} defaultValue={t?.description} placeholder="What a good file looks like" />
      </div>
      <div>
        <Label htmlFor={`scope-${id}`}>These files belong to</Label>
        <Select id={`scope-${id}`} name="scope" defaultValue={t?.scope ?? 'PROPERTY'} disabled={t?.isSystem}>
          <option value="PROPERTY">The property (site photos: a later order at the same address can reuse them)</option>
          <option value="ORDER">The order (bills, paperwork: each order needs its own)</option>
        </Select>
        {t?.isSystem && <input type="hidden" name="scope" value={t.scope} />}
        <FieldError name="scope" />
      </div>
      {!t?.isSystem && <Checkbox name="isRequiredForHandoff" defaultChecked={t?.isRequiredForHandoff ?? true} label="Required before an order can be pushed to operations" />}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`ret-${id}`} optional>
            Keep for (years)
          </Label>
          <Input id={`ret-${id}`} name="retentionYears" inputMode="numeric" defaultValue={t?.retentionYears ?? ''} placeholder="Standard" />
          <p className="mt-1 text-xs text-slate-500">Empty: the standard period set under Rules.</p>
          <FieldError name="retentionYears" />
        </div>
        <div>
          <Label htmlFor={`sort-${id}`}>Position in the list</Label>
          <Input id={`sort-${id}`} name="sortOrder" inputMode="numeric" defaultValue={t?.sortOrder ?? 80} />
        </div>
      </div>
      <Checkbox name="neverAutoDelete" defaultChecked={t?.neverAutoDelete ?? false} label="Never delete automatically, whatever the retention period (contracts, compliance paperwork)" />
      {t && !t.isSystem && <Checkbox name="isActive" defaultChecked={t.isActive} label="In use. Untick to hide this type; existing files stay where they are." />}
      {t?.isSystem && <input type="hidden" name="isActive" value="on" />}
    </>
  );
}

export default async function ChecklistPage() {
  const { user, ctx } = await requireSession();
  if (!can(user, 'config.manage')) notFound();
  const types = await ctx.db.documentType.findMany({ orderBy: { sortOrder: 'asc' }, include: { _count: { select: { documents: true } } } });

  return (
    <>
      <PageHeader
        title="Handoff checklist"
        description="The kinds of file an order can hold, and which of them must be present before sales can push the order to operations."
        actions={
          <Modal trigger="Add document type" title="Add a document type" variant="primary">
            <ActionForm action={createDocumentTypeAction} className="space-y-4">
              <TypeFields />
              <FormMessage />
              <div className="flex justify-end gap-2">
                <CancelButton />
                <SubmitButton>Add</SubmitButton>
              </div>
            </ActionForm>
          </Modal>
        }
      />
      <div className="mb-4">
        <Alert tone="blue">
          Three items are always required and are not configured here: a complete installation address, the signed contract, and a deposit confirmed by finance.
        </Alert>
      </div>
      <Card>
        <Table head={['Document type', 'Belongs to', 'Required for handoff', 'Kept for', 'Files', '']}>
          {types.map((t) => (
            <tr key={t.id} className={t.isActive ? '' : 'opacity-60'}>
              <Td>
                <div className="font-medium text-slate-900">
                  {t.label} {!t.isActive && <Badge>Hidden</Badge>}
                </div>
                {t.description && <div className="max-w-md text-xs text-slate-500">{t.description}</div>}
              </Td>
              <Td className="text-slate-600">{t.scope === 'PROPERTY' ? 'Property' : 'Order'}</Td>
              <Td>{t.isSystem ? <span className="text-xs text-slate-500">built in</span> : t.isRequiredForHandoff ? <Badge tone="amber">Required</Badge> : <span className="text-slate-400">Optional</span>}</Td>
              <Td className="text-slate-600">{t.neverAutoDelete ? 'Never deleted' : t.retentionYears ? `${t.retentionYears} year${t.retentionYears === 1 ? '' : 's'}` : 'Standard period'}</Td>
              <Td className="tabular-nums text-slate-600">{t._count.documents}</Td>
              <Td className="text-right">
                <Modal trigger="Edit" title={`Edit ${t.label}`} size="sm">
                  <ActionForm action={updateDocumentTypeAction.bind(null, t.id)} keepValues className="space-y-4">
                    <TypeFields t={t} />
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

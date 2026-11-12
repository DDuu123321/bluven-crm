import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TEMPLATE_FIELDS, can } from '@bluven/core';
import { listEmailTemplates } from '@bluven/integrations';
import { ActionButton, ActionForm, CancelButton, FieldError, FormMessage, Modal, SubmitButton } from '@/components/client';
import { Badge, Card, CardBody, CardHeader, Checkbox, EmptyState, Input, Label, PageHeader, Table, Td, Textarea } from '@/components/ui';
import { requireSession } from '@/lib/session';
import { deleteTemplateAction, saveTemplateAction } from '../actions';

export const metadata: Metadata = { title: 'Email templates' };

interface TemplateValues {
  id: string;
  name: string;
  subject: string;
  body: string;
  isActive: boolean;
  sortOrder: number;
}

function Fields({ t }: { t: TemplateValues | null }) {
  const id = t?.id ?? 'new';
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <div>
          <Label htmlFor={`tpl-name-${id}`}>Name</Label>
          <Input id={`tpl-name-${id}`} name="name" defaultValue={t?.name} maxLength={80} placeholder="What salespeople see in the list" />
          <FieldError name="name" />
        </div>
        <div>
          <Label htmlFor={`tpl-sort-${id}`}>Position</Label>
          <Input id={`tpl-sort-${id}`} name="sortOrder" inputMode="numeric" defaultValue={t?.sortOrder ?? 50} />
          <FieldError name="sortOrder" />
        </div>
      </div>
      <div>
        <Label htmlFor={`tpl-subject-${id}`} optional>
          Subject
        </Label>
        <Input id={`tpl-subject-${id}`} name="subject" defaultValue={t?.subject} maxLength={300} />
        <p className="mt-1 text-xs text-slate-500">Used for a new e-mail. A reply keeps the subject of the conversation.</p>
        <FieldError name="subject" />
      </div>
      <div>
        <Label htmlFor={`tpl-body-${id}`}>Text</Label>
        <Textarea id={`tpl-body-${id}`} name="body" rows={12} defaultValue={t?.body} />
        <FieldError name="body" />
      </div>
      <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
        <p className="font-medium">Fields that are filled in when the text is used:</p>
        <ul className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
          {Object.entries(TEMPLATE_FIELDS).map(([field, meaning]) => (
            <li key={field}>
              <code className="font-mono text-slate-900">{`{{${field}}}`}</code> {meaning}
            </li>
          ))}
        </ul>
      </div>
      <Checkbox name="isActive" defaultChecked={t?.isActive ?? true} label="In use. Untick to hide it from the list without removing it." />
    </>
  );
}

export default async function EmailTemplatesPage() {
  const { user, ctx } = await requireSession();
  if (!can(user, 'config.manage')) notFound();
  const templates = await listEmailTemplates(ctx);

  return (
    <>
      <PageHeader
        title="Email templates"
        description="Ready-made texts for e-mails to customers. Whoever writes to a customer from an order picks one, gets it with the customer’s name and address filled in, and changes it as needed before sending."
        actions={
          <Modal trigger="Add a template" title="Add a template" variant="primary">
            <ActionForm action={saveTemplateAction.bind(null, 'new')} className="space-y-4">
              <Fields t={null} />
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
        <CardHeader title={`${templates.length} template${templates.length === 1 ? '' : 's'}`} />
        {templates.length === 0 ? (
          <EmptyState title="No templates yet">Add the texts your team writes again and again: the first reply to an enquiry, the request for a bill and photos, the follow-up on a quote.</EmptyState>
        ) : (
          <Table head={['Name', 'Subject', 'Begins', '', '']}>
            {templates.map((t) => (
              <tr key={t.id}>
                <Td className="font-medium whitespace-nowrap text-slate-900">{t.name}</Td>
                <Td className="text-slate-600">{t.subject}</Td>
                <Td className="max-w-md text-slate-500">
                  <span className="line-clamp-2">{t.body.slice(0, 200)}</span>
                </Td>
                <Td>{t.isActive ? <Badge tone="green">In use</Badge> : <Badge>Hidden</Badge>}</Td>
                <Td className="text-right whitespace-nowrap">
                  <span className="inline-flex items-start gap-3">
                    <Modal trigger="Edit" title={`Edit “${t.name}”`} variant="link">
                      <ActionForm action={saveTemplateAction.bind(null, t.id)} keepValues className="space-y-4">
                        <Fields t={t} />
                        <FormMessage />
                        <div className="flex justify-end gap-2">
                          <CancelButton />
                          <SubmitButton>Save</SubmitButton>
                        </div>
                      </ActionForm>
                    </Modal>
                    <ActionButton action={deleteTemplateAction.bind(null, t.id)} variant="link-danger" confirm={`Remove the template “${t.name}”? E-mails that were already sent with it are not affected.`}>
                      Remove
                    </ActionButton>
                  </span>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <CardBody className="px-0 text-xs text-slate-500">A template is a starting point. Nothing is sent until the salesperson has read the e-mail and pressed Send.</CardBody>
    </>
  );
}

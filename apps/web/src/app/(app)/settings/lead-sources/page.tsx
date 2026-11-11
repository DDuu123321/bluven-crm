import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can, getConfig } from '@bluven/core';
import { ActionButton, ActionForm, CancelButton, FieldError, FormMessage, Modal, SubmitButton } from '@/components/client';
import { Badge, Card, CardBody, CardHeader, Checkbox, Input, Label, PageHeader, Select, Table, Td } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/fmt';
import { requireSession } from '@/lib/session';
import { createLeadSourceAction, revokePreviousTokenAction, rotateTokenAction, updateLeadSourceAction } from '../actions';
import { TokenButton } from './token-button';

export const metadata: Metadata = { title: 'Lead sources' };

const KIND_LABEL = { BLUVEN: 'Bluven website', EXTERNAL: 'External system', CSV: 'File import', MANUAL: 'Manual entry' } as const;

export default async function LeadSourcesPage() {
  const { user, ctx } = await requireSession();
  if (!can(user, 'admin.leadSources')) notFound();
  const sources = await ctx.db.leadSource.findMany({ orderBy: [{ kind: 'asc' }, { name: 'asc' }], include: { _count: { select: { orders: true } } } });
  const endpoint = `${getConfig().appUrl}/api/intake/leads`;
  const now = new Date();

  return (
    <>
      <PageHeader
        title="Lead sources"
        description="Where leads come from. Systems that send leads automatically each get their own token, so one source can be switched off without affecting the others."
        actions={
          <Modal trigger="Add source" title="Add a lead source" variant="primary" size="md">
            <ActionForm action={createLeadSourceAction} className="space-y-4">
              <div>
                <Label htmlFor="src-name">Name</Label>
                <Input id="src-name" name="name" required placeholder="For example: Facebook campaign, Partner referrals" />
                <FieldError name="name" />
              </div>
              <div>
                <Label htmlFor="src-kind">How do the leads arrive?</Label>
                <Select id="src-kind" name="kind" defaultValue="EXTERNAL">
                  <option value="EXTERNAL">Sent by another system over the API</option>
                  <option value="CSV">Uploaded as CSV files</option>
                </Select>
                <FieldError name="kind" />
                <p className="mt-1.5 text-xs text-slate-500">
                  Another company&rsquo;s system gets its own token and can only hand leads in. When one of its leads is a repeat of a customer you already have, it is told so but not which order, and the details it sent go on the timeline without
                  changing the customer&rsquo;s contact details. Previews and history loads are reserved for the Bluven website.
                </p>
              </div>
              <FormMessage />
              <div className="flex justify-end gap-2">
                <CancelButton />
                <SubmitButton>Add source</SubmitButton>
              </div>
            </ActionForm>
          </Modal>
        }
      />

      <Card className="mb-4">
        <CardHeader title="Sending leads to the CRM" />
        <CardBody className="space-y-1.5 text-sm text-slate-600">
          <p>
            Endpoint: <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-900">POST {endpoint}</code>
          </p>
          <p>
            Header: <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-900">Authorization: Bearer &lt;token&gt;</code>
          </p>
          <p>The full contract, including the fields, limits and retry rules, is in docs/bluven-lead-forwarding-spec.md in the repository.</p>
        </CardBody>
      </Card>

      <Card>
        <Table head={['Source', 'Type', 'Leads', 'Token', 'Status', '']}>
          {sources.map((s) => {
            const api = s.kind === 'BLUVEN' || s.kind === 'EXTERNAL';
            const overlap = s.prevTokenHash && s.prevTokenExpiresAt && s.prevTokenExpiresAt > now;
            return (
              <tr key={s.id}>
                <Td>
                  <div className="font-medium text-slate-900">{s.name}</div>
                  <div className="font-mono text-xs text-slate-400">{s.key}</div>
                </Td>
                <Td className="text-slate-600">{KIND_LABEL[s.kind]}</Td>
                <Td className="tabular-nums text-slate-600">{s._count.orders}</Td>
                <Td className="text-slate-600">
                  {!api ? (
                    <span className="text-slate-300">not needed</span>
                  ) : s.tokenHash ? (
                    <>
                      <span className="font-mono text-xs">…{s.tokenLast4}</span>
                      <div className="text-xs text-slate-500">issued {fmtDate(s.tokenCreatedAt)}</div>
                      {overlap && (
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-amber-700">
                          Previous token valid until {fmtDateTime(s.prevTokenExpiresAt)}
                          <ActionButton action={revokePreviousTokenAction.bind(null, s.id)} size="sm" variant="ghost" confirm="Stop accepting the previous token now?">
                            Revoke now
                          </ActionButton>
                        </div>
                      )}
                    </>
                  ) : (
                    <Badge tone="amber">No token yet</Badge>
                  )}
                </Td>
                <Td>{s.isActive ? <Badge tone="green">Active</Badge> : <Badge tone="red">Switched off</Badge>}</Td>
                <Td>
                  <div className="flex flex-wrap items-start justify-end gap-1.5">
                    {api && <TokenButton action={rotateTokenAction.bind(null, s.id)} hasToken={!!s.tokenHash} sourceName={s.name} />}
                    <Modal trigger="Edit" title={`Edit ${s.name}`} size="sm">
                      <ActionForm action={updateLeadSourceAction.bind(null, s.id)} keepValues className="space-y-4">
                        <div>
                          <Label htmlFor={`src-${s.id}`}>Name</Label>
                          <Input id={`src-${s.id}`} name="name" defaultValue={s.name} required />
                          <FieldError name="name" />
                        </div>
                        <Checkbox name="isActive" defaultChecked={s.isActive} disabled={s.kind === 'MANUAL'} label="Active. Untick to stop accepting leads from this source; its token is refused at once." />
                        {s.kind === 'MANUAL' && <input type="hidden" name="isActive" value="on" />}
                        <FormMessage />
                        <div className="flex justify-end gap-2">
                          <CancelButton />
                          <SubmitButton>Save</SubmitButton>
                        </div>
                      </ActionForm>
                    </Modal>
                  </div>
                </Td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}

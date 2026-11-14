import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can, getConfig } from '@bluven/core';
import { getBluvenPullState } from '@bluven/integrations';
import { ActionButton, ActionForm, CancelButton, FieldError, FormMessage, Modal, SubmitButton } from '@/components/client';
import { Badge, Card, CardBody, CardHeader, Checkbox, Input, Label, PageHeader, Select, Table, Td } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/fmt';
import { requireSession } from '@/lib/session';
import { createLeadSourceAction, revokePreviousTokenAction, rotateTokenAction, updateLeadSourceAction } from '../actions';
import { TokenButton } from './token-button';

export const metadata: Metadata = { title: 'Intake channels' };

const KIND_LABEL = { BLUVEN: 'Bluven website', EXTERNAL: 'External system', CSV: 'File import', MANUAL: 'Manual entry' } as const;

export default async function IntakeChannelsPage() {
  const { user, ctx } = await requireSession();
  if (!can(user, 'admin.leadSources')) notFound();
  const sources = await ctx.db.leadSource.findMany({ orderBy: [{ kind: 'asc' }, { name: 'asc' }], include: { _count: { select: { orders: true } } } });
  const endpoint = `${getConfig().appUrl}/api/intake/leads`;
  const now = new Date();
  const website = getConfig().bluvenLeads;
  const pulling = !!(website.url && website.key);
  const pull = pulling ? await getBluvenPullState(ctx.db) : null;
  // The worker asks once a minute. Several minutes of silence mean it is not running.
  const stale = !!pull?.lastRunAt && now.getTime() - new Date(pull.lastRunAt).getTime() > 5 * 60_000;

  return (
    <>
      <PageHeader
        title="Intake channels"
        description="How leads get into the CRM: from the Bluven website, from other systems, from files and by hand. Systems that send leads automatically each get their own token, so one channel can be switched off without affecting the others. Where a customer heard of Bluven is a different list: the salesperson chooses it from the lead sources when opening the job."
        actions={
          <Modal trigger="Add channel" title="Add an intake channel" variant="primary" size="md">
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
                <SubmitButton>Add channel</SubmitButton>
              </div>
            </ActionForm>
          </Modal>
        }
      />

      <Card className="mb-4">
        <CardHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              Bluven website
              {!pulling ? <Badge>Not connected</Badge> : !pull ? <Badge tone="amber">Waiting for the first check</Badge> : pull.lastError ? <Badge tone="red">Failing</Badge> : stale ? <Badge tone="amber">Not checking</Badge> : <Badge tone="green">Connected</Badge>}
            </span>
          }
          description="The CRM collects new quote requests and assessments from the website once a minute. The website keeps every lead, so nothing is lost while the CRM is offline."
        />
        <CardBody className="space-y-1.5 text-sm text-slate-600">
          {!pulling ? (
            <p>
              To connect, set <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-900">BLUVEN_LEADS_URL</code> and <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-900">BLUVEN_LEADS_KEY</code> on
              the CRM server, with the key equal to <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-900">CRM_SYNC_KEY</code> on the website. The steps are in docs/deployment-guide.md.
            </p>
          ) : (
            <>
              <p>
                Collecting from <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-900">{new URL(website.url).host}</code>
                {pull?.lastOkAt ? ` · last successful check ${fmtDateTime(new Date(pull.lastOkAt))}` : ''}
                {pull?.lastLeadAt ? ` · last lead received ${fmtDateTime(new Date(pull.lastLeadAt))}` : ''}
                {pull ? ` · ${pull.imported} lead${pull.imported === 1 ? '' : 's'} taken over so far` : ''}
              </p>
              {pull?.lastError && (
                <p className="font-medium text-red-700">
                  {pull.lastError} ({pull.consecutiveFailures} failed check{pull.consecutiveFailures === 1 ? '' : 's'} in a row)
                </p>
              )}
              {!pull?.lastError && stale && <p className="font-medium text-amber-700">No check for more than five minutes. Is the worker process running?</p>}
            </>
          )}
        </CardBody>
      </Card>

      <Card className="mb-4">
        <CardHeader title="Sending leads to the CRM" description="For other systems, and as an alternative way for the website to hand leads over." />
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
        <Table head={['Channel', 'Type', 'Leads', 'Token', 'Status', '']}>
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

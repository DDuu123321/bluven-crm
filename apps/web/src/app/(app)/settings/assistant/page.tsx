import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can, getConfig, isManager } from '@bluven/core';
import { AI_KIND_LABEL, ASSISTANT_LANGUAGES, assistantConfigured, getAssistantSettings, getAssistantUsage, recentSetupProblem } from '@bluven/integrations';
import { ActionForm, FieldError, FormMessage, SubmitButton } from '@/components/client';
import { Alert, Badge, Card, CardBody, CardHeader, Checkbox, Dl, EmptyState, Input, Label, PageHeader, Select, Table, Td } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import { requireSession } from '@/lib/session';
import { updateAssistantAction } from '../actions';

export const metadata: Metadata = { title: 'AI assistant' };

const count = (n: number): string => n.toLocaleString('en-AU');
const usd = (n: number | null): string => (n === null ? 'not known' : n < 0.005 ? 'under US$0.01' : `about US$${n.toFixed(2)}`);

const FAILURE_WORD: Record<string, string> = {
  refused: 'Declined by the model',
  unavailable: 'Service not reachable or busy',
  rejected: 'Material not accepted',
  unreadable: 'Answer not usable',
  setup: 'Key or account problem',
};

export default async function AssistantSettingsPage() {
  const { user, ctx } = await requireSession();
  if (!isManager(user)) notFound();
  const config = getConfig();
  const configured = assistantConfigured();
  const canEdit = can(user, 'admin.settings');
  const [settings, usage, problem] = await Promise.all([getAssistantSettings(ctx.db), getAssistantUsage(ctx, 30), recentSetupProblem(ctx.db, new Date())]);

  return (
    <>
      <PageHeader
        title="AI assistant"
        description="Summaries of orders, drafts for e-mails, a first look at what customers attach, reading electricity bills, and the brief operations get with each order. Everything it writes is marked as written by AI and is checked by a person before it is used."
      />
      <div className="mb-4 space-y-2">
        {!configured && (
          <Alert tone="amber" title="The assistant is switched off">
            Set ANTHROPIC_API_KEY in the server environment and restart the web and worker processes. Until then the buttons for it do not appear and everything else works as before.
          </Alert>
        )}
        {configured && problem && (
          <Alert tone="red" title="The assistant is not working">
            The service did not accept the key or the account: {problem}. Automatic work is paused and tried again every quarter of an hour.
          </Alert>
        )}
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Connection" />
          <CardBody>
            <Dl
              rows={[
                ['Key', configured ? <Badge key="k" tone="green">Configured</Badge> : <Badge key="k" tone="amber">Missing</Badge>],
                ['Model', config.ai.model],
                ['Automatic requests, last 24 hours', `${count(usage.automaticLast24h)} of at most ${count(settings.dailyAutomaticLimit)}`],
              ]}
            />
            <p className="mt-3 text-xs text-slate-500">
              What is sent to the model: the record of the one order being worked on (enquiry, notes, timeline, e-mails with that customer, quote figures) and, for a bill or an attachment, the file itself. The phone numbers and e-mail addresses on the customer’s record are
              left out, though an e-mail or a bill can of course contain them. Nothing about other customers is sent.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="What it does by itself" description={canEdit ? 'Work a person asks for with a button is always available and does not count towards the daily limit.' : 'Only an administrator can change these.'} />
          <CardBody>
            <ActionForm action={updateAssistantAction} keepValues stayOpen className="space-y-3">
              <fieldset disabled={!canEdit} className="space-y-3">
                <Checkbox name="autoBrief" defaultChecked={settings.autoBrief} label="Write the brief for operations when an order is pushed" />
                <Checkbox name="readAttachments" defaultChecked={settings.readAttachments} label="Look at what customers attach to their e-mails and suggest the folder" />
                <Checkbox name="readBills" defaultChecked={settings.readBills} label="Read electricity bills as they are filed, and fill in an empty NMI and retailer" />
                <Checkbox name="autoSummary" defaultChecked={settings.autoSummary} label="Rewrite an order’s summary when the customer writes" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="language">Summaries and briefs are written in</Label>
                    <Select id="language" name="language" defaultValue={settings.language}>
                      {Object.entries(ASSISTANT_LANGUAGES).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </Select>
                    <p className="mt-1 text-xs text-slate-500">Drafts for e-mails follow the customer’s language.</p>
                    <FieldError name="language" />
                  </div>
                  <div>
                    <Label htmlFor="dailyAutomaticLimit">Automatic requests in 24 hours, at most</Label>
                    <Input id="dailyAutomaticLimit" name="dailyAutomaticLimit" inputMode="numeric" defaultValue={settings.dailyAutomaticLimit} className="w-28" />
                    <p className="mt-1 text-xs text-slate-500">A ceiling on what it may spend unattended.</p>
                    <FieldError name="dailyAutomaticLimit" />
                  </div>
                </div>
              </fieldset>
              <FormMessage />
              {canEdit && <SubmitButton>Save</SubmitButton>}
            </ActionForm>
          </CardBody>
        </Card>
      </div>

      <Card className="mb-4">
        <CardHeader title="Use in the last 30 days" description="Tokens are what the service charges by. The cost is a rough figure from list prices; the bill from the provider is what counts." />
        <Table head={['Work', 'Requests', 'Failed', 'Tokens read', 'Tokens written', 'Cost']}>
          {[...usage.byKind.map((k) => ({ ...k, label: AI_KIND_LABEL[k.kind], total: false })), { ...usage.total, label: 'All together', total: true }].map((row) => (
            <tr key={row.label} className={row.total ? 'font-medium' : undefined}>
              <Td className="text-slate-900">{row.label}</Td>
              <Td className="tabular-nums">{count(row.requests)}</Td>
              <Td className="tabular-nums">{row.failed > 0 ? <span className="text-amber-700">{count(row.failed)}</span> : '0'}</Td>
              <Td className="tabular-nums">{count(row.inputTokens)}</Td>
              <Td className="tabular-nums">{count(row.outputTokens)}</Td>
              <Td className="tabular-nums">{row.requests === 0 ? '' : usd(row.costUsd)}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card>
        <CardHeader title="Requests that did not succeed" description="The latest of the last 30 days." />
        {usage.recentFailures.length === 0 ? (
          <EmptyState title="None" />
        ) : (
          <Table head={['When', 'Work', 'Order', 'What went wrong', 'Detail']}>
            {usage.recentFailures.map((f) => (
              <tr key={f.id}>
                <Td className="whitespace-nowrap text-slate-600">{fmtDateTime(f.at)}</Td>
                <Td>
                  {AI_KIND_LABEL[f.kind as keyof typeof AI_KIND_LABEL] ?? f.kind}
                  <div className="text-xs text-slate-500">{f.automatic ? 'automatic' : 'asked for by a person'}</div>
                </Td>
                <Td>
                  {f.orderId && f.orderNo ? (
                    <Link href={`/orders/${f.orderId}`} className="text-brand-700 hover:underline">
                      {f.orderNo}
                    </Link>
                  ) : (
                    ''
                  )}
                </Td>
                <Td>{FAILURE_WORD[f.failure ?? ''] ?? 'Failed'}</Td>
                <Td className="max-w-md text-xs break-words text-slate-600">{f.error}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

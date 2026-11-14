import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NOTICE_FIELDS, NOTICE_KINDS, NOTICE_KIND_LABEL, can, getOperationsSettings, type NoticeKind } from '@bluven/core';
import { ActionForm, FieldError, FormMessage, SubmitButton } from '@/components/client';
import { Alert, Card, CardBody, CardHeader, Checkbox, Input, Label, PageHeader, Select, Textarea } from '@/components/ui';
import { requireSession } from '@/lib/session';
import { updateOperationsAction } from '../actions';

export const metadata: Metadata = { title: 'Operations and customer e-mails' };

const WHEN: Record<NoticeKind, string> = {
  WELCOME: 'Goes out when operations accepts an order for the first time.',
  SCHEDULE: 'Goes out when operations presses “Send the dates to the customer”, once the installation date and the delivery are settled, and again whenever they send changed dates.',
  JOB_DONE: 'Goes out when operations marks the job as done.',
};

export default async function OperationsSettingsPage() {
  const { user, ctx } = await requireSession();
  if (!can(user, 'admin.settings')) notFound();
  const [settings, mailboxes] = await Promise.all([
    getOperationsSettings(ctx.db),
    ctx.db.emailAccount.findMany({ select: { userId: true, address: true, user: { select: { name: true } } }, orderBy: { address: 'asc' } }),
  ]);
  const chosenGone = !!settings.mailboxUserId && !mailboxes.some((m) => m.userId === settings.mailboxUserId);

  return (
    <>
      <PageHeader
        title="Operations and customer e-mails"
        description="The reminders that follow a finished job, and the e-mails customers receive by themselves while operations has their order."
      />
      <ActionForm action={updateOperationsAction} keepValues stayOpen className="max-w-3xl space-y-4">
        <Card>
          <CardHeader title="After the job is done" description="Counted in working days from the day operations marks the job as done. Saturdays and Sundays are skipped; public holidays are not." />
          <CardBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="rebateReminderDays">Remind operations to apply for the rebate after</Label>
                <div className="flex items-center gap-2">
                  <Input id="rebateReminderDays" name="rebateReminderDays" inputMode="numeric" defaultValue={settings.rebateReminderDays} className="w-20" />
                  <span className="text-sm text-slate-500">working days</span>
                </div>
                <FieldError name="rebateReminderDays" />
              </div>
              <div>
                <Label htmlFor="balanceDays">The customer is asked to pay the balance within</Label>
                <div className="flex items-center gap-2">
                  <Input id="balanceDays" name="balanceDays" inputMode="numeric" defaultValue={settings.balanceDays} className="w-20" />
                  <span className="text-sm text-slate-500">working days</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">When they have passed and the job is not closed, operations is reminded to look at the account and, if the money is not there, to ask the salesperson to chase it.</p>
                <FieldError name="balanceDays" />
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Which mailbox sends them" description="The e-mails go out through a mailbox that is connected to the CRM, so replies arrive there and appear on the order." />
          <CardBody className="space-y-2">
            <Label htmlFor="mailboxUserId">Send from</Label>
            <Select id="mailboxUserId" name="mailboxUserId" defaultValue={chosenGone ? '' : (settings.mailboxUserId ?? '')} className="max-w-md">
              <option value="">The mailbox of whoever takes the step</option>
              {mailboxes.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.address} ({m.user.name})
                </option>
              ))}
            </Select>
            <FieldError name="mailboxUserId" />
            {chosenGone && <Alert tone="amber">The mailbox chosen before is no longer connected. Until another one is chosen, the e-mails go out from the mailbox of whoever takes the step.</Alert>}
            {mailboxes.length === 0 && (
              <p className="text-xs text-slate-500">Nobody has connected a mailbox yet. Until someone in operations does, these e-mails are written and kept on the order with the reason they were not sent, and can be sent from there later.</p>
            )}
            <p className="text-xs text-slate-500">A shared operations address works best: connect it under “My account → Email” while signed in as the person who looks after it, then choose it here.</p>
          </CardBody>
        </Card>

        {NOTICE_KINDS.map((kind) => (
          <Card key={kind}>
            <CardHeader title={`E-mail: ${NOTICE_KIND_LABEL[kind]}`} description={WHEN[kind]} />
            <CardBody className="space-y-3">
              <Checkbox name={`${kind}.enabled`} defaultChecked={settings.notices[kind].enabled} label="Send this e-mail" />
              <div>
                <Label htmlFor={`${kind}-subject`}>Subject</Label>
                <Input id={`${kind}-subject`} name={`${kind}.subject`} defaultValue={settings.notices[kind].subject} maxLength={200} />
                <FieldError name={`${kind}.subject`} />
              </div>
              <div>
                <Label htmlFor={`${kind}-body`}>Text</Label>
                <Textarea id={`${kind}-body`} name={`${kind}.body`} rows={12} defaultValue={settings.notices[kind].body} className="font-mono text-[13px]" />
                <FieldError name={`${kind}.body`} />
              </div>
            </CardBody>
          </Card>
        ))}

        <Card>
          <CardHeader title="Fields" description="Written in double braces, they are replaced with the order’s own details when the e-mail is written. The text is fixed at that moment: a later change here does not alter an e-mail that is already on an order." />
          <CardBody>
            <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
              {Object.entries(NOTICE_FIELDS).map(([field, meaning]) => (
                <div key={field} className="contents">
                  <dt className="font-mono text-[13px] text-slate-900">{`{{${field}}}`}</dt>
                  <dd className="text-slate-600">{meaning}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>

        <FormMessage />
        <SubmitButton>Save</SubmitButton>
      </ActionForm>
    </>
  );
}

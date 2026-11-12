import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { can, getSettings } from '@bluven/core';
import { ActionForm, FieldError, FormMessage, SubmitButton } from '@/components/client';
import { Card, CardBody, CardHeader, Checkbox, Input, Label, PageHeader } from '@/components/ui';
import { requireSession } from '@/lib/session';
import { updateRulesAction } from '../actions';

export const metadata: Metadata = { title: 'Rules' };

export default async function RulesPage() {
  const { user, ctx } = await requireSession();
  if (!can(user, 'admin.settings')) notFound();
  const settings = await getSettings(ctx.db);

  return (
    <>
      <PageHeader title="Rules" description="The numbers behind the automatic reminders and suggestions." />
      <ActionForm action={updateRulesAction} keepValues stayOpen className="max-w-2xl space-y-4">
        <Card>
          <CardHeader
            title="Idle orders"
            description="Counted from the last thing the salesperson or a manager did on the order. Customer emails and system reminders do not reset the clock. Time spent waiting for finance or operations is not counted."
          />
          <CardBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="remindOwnerDays">Remind the salesperson after</Label>
                <div className="flex items-center gap-2">
                  <Input id="remindOwnerDays" name="remindOwnerDays" inputMode="numeric" defaultValue={settings.idle.remindOwnerDays} className="w-20" />
                  <span className="text-sm text-slate-500">days</span>
                </div>
                <FieldError name="remindOwnerDays" />
              </div>
              <div>
                <Label htmlFor="remindManagerDays">Tell the managers after</Label>
                <div className="flex items-center gap-2">
                  <Input id="remindManagerDays" name="remindManagerDays" inputMode="numeric" defaultValue={settings.idle.remindManagerDays} className="w-20" />
                  <span className="text-sm text-slate-500">days</span>
                </div>
                <FieldError name="remindManagerDays" />
              </div>
              <div>
                <Label htmlFor="returnToPoolDays">Return to the pool after</Label>
                <div className="flex items-center gap-2">
                  <Input id="returnToPoolDays" name="returnToPoolDays" inputMode="numeric" defaultValue={settings.idle.returnToPoolDays} className="w-20" />
                  <span className="text-sm text-slate-500">days</span>
                </div>
                <FieldError name="returnToPoolDays" />
              </div>
            </div>
            <p className="text-xs text-slate-500">Only orders that have not been signed yet are returned to the pool automatically. Signed orders are never taken away from their salesperson: the reminders continue and a manager decides.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Deposit" description="Suggested when sales records a deposit and the quote does not state one." />
          <CardBody>
            <Label htmlFor="defaultDepositPercent">Suggested deposit</Label>
            <div className="flex items-center gap-2">
              <Input id="defaultDepositPercent" name="defaultDepositPercent" inputMode="decimal" defaultValue={settings.defaultDepositPercent} className="w-20" />
              <span className="text-sm text-slate-500">% of the total price</span>
            </div>
            <FieldError name="defaultDepositPercent" />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Keeping documents"
            description="Counted from the day an order ended: handed over to operations, lost or cancelled. Nothing of an open order ever expires. Signed contracts, deposit proofs and every document type marked “never delete automatically” are kept for good."
          />
          <CardBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="retentionYears">Keep documents for</Label>
                <div className="flex items-center gap-2">
                  <Input id="retentionYears" name="retentionYears" inputMode="numeric" defaultValue={settings.retention.years} className="w-20" />
                  <span className="text-sm text-slate-500">years after the order ended</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">A document type can have a period of its own, set under Handoff checklist.</p>
                <FieldError name="retentionYears" />
              </div>
              <div>
                <Label htmlFor="retentionReminderDays">Remind the salesperson and the managers</Label>
                <div className="flex items-center gap-2">
                  <Input id="retentionReminderDays" name="retentionReminderDays" inputMode="numeric" defaultValue={settings.retention.reminderDays} className="w-20" />
                  <span className="text-sm text-slate-500">days before the end</span>
                </div>
                <FieldError name="retentionReminderDays" />
              </div>
            </div>
            <Checkbox
              name="retentionAutoDelete"
              defaultChecked={settings.retention.autoDelete}
              label="Delete automatically at the end of the period when nobody has decided. Left off, nothing is deleted until a person chooses to, and the managers are reminded every week."
            />
            <FieldError name="retentionAutoDelete" />
            <p className="text-xs text-slate-500">A deleted document disappears from the order at once. Its file is removed from the server 30 days later; until then a mistake can still be undone by a developer.</p>
          </CardBody>
        </Card>
        <FormMessage />
        <SubmitButton>Save rules</SubmitButton>
      </ActionForm>
    </>
  );
}

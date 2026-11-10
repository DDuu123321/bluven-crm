import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AU_STATES, BEST_TIMES, BEST_TIME_LABEL, COMPONENTS, PROPERTY_TYPES, TIMELINES, TIMELINE_LABEL, can, isManager, listSalespeople } from '@bluven/core';
import { ActionForm, FieldError, FormMessage, SubmitButton } from '@/components/client';
import { Card, CardBody, CardHeader, Checkbox, Input, Label, LinkButton, PageHeader, Select, Textarea } from '@/components/ui';
import { requireSession } from '@/lib/session';
import { createLeadAction } from '../actions';
import { DuplicateWatch } from './duplicate-hint';

export const metadata: Metadata = { title: 'New lead' };

export default async function NewLeadPage() {
  const { user, ctx } = await requireSession();
  if (!can(user, 'orders.create')) notFound();
  const manager = isManager(user);
  const salespeople = manager ? await listSalespeople(ctx.db) : [];

  return (
    <>
      <PageHeader title="New lead" description="For enquiries that reach you directly, for example by phone or referral." back={{ href: '/orders', label: 'Orders' }} />
      <ActionForm action={createLeadAction} keepValues className="max-w-3xl space-y-4">
        <Card>
          <CardHeader title="Contact" />
          <CardBody>
            <DuplicateWatch>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="firstName">First name</Label>
                  <Input id="firstName" name="firstName" required autoComplete="off" />
                  <FieldError name="firstName" />
                </div>
                <div>
                  <Label htmlFor="lastName" optional>
                    Last name
                  </Label>
                  <Input id="lastName" name="lastName" autoComplete="off" />
                  <FieldError name="lastName" />
                </div>
                <div>
                  <Label htmlFor="phone">Phone</Label>
                  <Input id="phone" name="phone" type="tel" required autoComplete="off" placeholder="0412 345 678" />
                  <FieldError name="phone" />
                </div>
                <div>
                  <Label htmlFor="email" optional>
                    Email
                  </Label>
                  <Input id="email" name="email" type="email" autoComplete="off" />
                  <FieldError name="email" />
                </div>
              </div>
            </DuplicateWatch>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Property" description="Leave empty if you do not know it yet. It is needed before the order can go to operations." />
          <CardBody className="grid gap-4 sm:grid-cols-6">
            <div className="sm:col-span-6">
              <Label htmlFor="address" optional>
                Street address
              </Label>
              <Input id="address" name="address" autoComplete="off" placeholder="12 Sample St" />
              <FieldError name="address" />
            </div>
            <div className="sm:col-span-3">
              <Label htmlFor="suburb" optional>
                Suburb
              </Label>
              <Input id="suburb" name="suburb" autoComplete="off" />
              <FieldError name="suburb" />
            </div>
            <div className="sm:col-span-1">
              <Label htmlFor="state" optional>
                State
              </Label>
              <Select id="state" name="state" defaultValue="">
                <option value=""></option>
                {AU_STATES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </Select>
              <FieldError name="state" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="postcode" optional>
                Postcode
              </Label>
              <Input id="postcode" name="postcode" inputMode="numeric" maxLength={4} autoComplete="off" />
              <FieldError name="postcode" />
            </div>
            <div className="sm:col-span-3">
              <Label htmlFor="propertyType" optional>
                Property type
              </Label>
              <Select id="propertyType" name="propertyType" defaultValue="">
                <option value=""></option>
                {PROPERTY_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
              <FieldError name="propertyType" />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Enquiry" />
          <CardBody className="grid gap-4 sm:grid-cols-3">
            <fieldset className="sm:col-span-3">
              <legend className="mb-1.5 text-xs font-medium text-slate-600">Interested in</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {COMPONENTS.map((c) => (
                  <Checkbox key={c} name="components" value={c} label={c} />
                ))}
              </div>
              <FieldError name="components" />
            </fieldset>
            <div>
              <Label htmlFor="systemKw" optional>
                Solar size wanted (kW)
              </Label>
              <Input id="systemKw" name="systemKw" inputMode="decimal" />
              <FieldError name="systemKw" />
            </div>
            <div>
              <Label htmlFor="batteryKwh" optional>
                Battery wanted (kWh)
              </Label>
              <Input id="batteryKwh" name="batteryKwh" inputMode="decimal" />
              <FieldError name="batteryKwh" />
            </div>
            <div>
              <Label htmlFor="monthlyBill" optional>
                Monthly bill ($)
              </Label>
              <Input id="monthlyBill" name="monthlyBill" inputMode="decimal" />
              <FieldError name="monthlyBill" />
            </div>
            <div>
              <Label htmlFor="timeline" optional>
                Timeline
              </Label>
              <Select id="timeline" name="timeline" defaultValue="">
                <option value=""></option>
                {TIMELINES.map((t) => (
                  <option key={t} value={t}>
                    {TIMELINE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="bestTime" optional>
                Best time to contact
              </Label>
              <Select id="bestTime" name="bestTime" defaultValue="">
                <option value=""></option>
                {BEST_TIMES.map((t) => (
                  <option key={t} value={t}>
                    {BEST_TIME_LABEL[t]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="sm:col-span-3">
              <Label htmlFor="notes" optional>
                Notes
              </Label>
              <Textarea id="notes" name="notes" maxLength={5000} />
              <FieldError name="notes" />
            </div>
          </CardBody>
        </Card>

        {manager && (
          <Card>
            <CardHeader title="Salesperson" />
            <CardBody>
              <Select name="ownerId" aria-label="Salesperson" defaultValue="__auto__" className="max-w-sm">
                <option value="__auto__">Decide automatically (previous salesperson, otherwise the pool)</option>
                <option value="__pool__">Leave unassigned</option>
                {salespeople.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.openOrders} open)
                  </option>
                ))}
              </Select>
              <FieldError name="ownerId" />
            </CardBody>
          </Card>
        )}

        <FormMessage />
        <div className="flex gap-2">
          <SubmitButton pendingLabel="Saving…">Save lead</SubmitButton>
          <LinkButton href="/orders" variant="ghost">
            Cancel
          </LinkButton>
        </div>
      </ActionForm>
    </>
  );
}

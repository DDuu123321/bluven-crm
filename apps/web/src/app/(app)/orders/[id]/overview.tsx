import Link from 'next/link';
import {
  AU_STATES,
  BEST_TIME_LABEL,
  PHASES,
  PROPERTY_TYPES,
  TIMELINE_LABEL,
  formatAddress,
  getOrderTasks,
  getOrderTimeline,
  readFieldSources,
  type Ctx,
  type LeadDetails,
  type OrderHeader,
} from '@bluven/core';
import { assistantConfigured, getOrderBills, getOrderSummary } from '@bluven/integrations';
import { BillsCard, SummaryCard } from '@/components/assistant';
import { ActionButton, ActionForm, CancelButton, FieldError, FormMessage, Modal, SubmitButton } from '@/components/client';
import { Timeline } from '@/components/timeline';
import { Card, CardBody, CardHeader, Dl, Input, Label, Select, StageBadge, Textarea, cx } from '@/components/ui';
import { fmtDateTime, inputDateTime } from '@/lib/fmt';
import { completeTaskAction, createTaskAction } from '../../tasks/actions';
import { logActivityAction, movePropertyAction, readBillAction, summariseAction, summaryHintAction, updateCustomerAction, updatePropertyAction, billValueAction } from './actions';
import { ActivityFields } from './activity-fields';

export async function OverviewTab({ ctx, header, editable, staff }: { ctx: Ctx; header: OrderHeader; editable: boolean; staff: boolean }) {
  const { order } = header;
  const [timeline, tasks, summary, bills] = await Promise.all([getOrderTimeline(ctx, order.id), getOrderTasks(ctx, order.id), getOrderSummary(ctx, order.id), getOrderBills(ctx, order.id)]);
  const assistant = assistantConfigured();
  const sources = readFieldSources(order.property.fieldSources);
  /** A property value with a mark saying it was not typed by a person, when that is the case. */
  const sourced = (field: string, value: string) =>
    value && sources[field] ? (
      <span key={field}>
        {value}{' '}
        <span className="text-xs text-violet-700" title={sources[field].source === 'bill' ? 'Read from the electricity bill by the assistant' : 'Suggested by the assistant from the correspondence and taken over by a colleague'}>
          · {sources[field].source === 'bill' ? 'from the bill' : 'from the summary'}
        </span>
      </span>
    ) : (
      value
    );
  const now = new Date();
  const details = order.leadDetails as LeadDetails;
  const attribution = order.attribution as Record<string, string>;
  const c = order.customer;
  const p = order.property;
  const openTasks = tasks.filter((t) => t.status === 'OPEN');
  const doneTasks = tasks.filter((t) => t.status === 'DONE').slice(0, 3);
  // Tomorrow at 9 am, as a sensible default due time.
  const tomorrowNine = `${inputDateTime(new Date(now.getTime() + 86_400_000)).slice(0, 10)}T09:00`;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <SummaryCard summary={summary} available={assistant} write={staff ? summariseAction.bind(null, order.id) : undefined} hintAction={editable ? summaryHintAction.bind(null, order.id) : undefined} />
        {staff && (
          <Card>
            <CardHeader title="Log activity" description="Calls and messages are not captured automatically. Record them here so the timeline tells the whole story." />
            <CardBody>
              <ActionForm action={logActivityAction.bind(null, order.id)} className="space-y-3">
                <ActivityFields nowLocal={inputDateTime(now)} />
                <FormMessage />
                <SubmitButton pendingLabel="Saving…">Add to timeline</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
        )}
        <Card>
          <CardHeader title="Timeline" />
          <Timeline entries={timeline} />
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader
            title="Tasks"
            actions={
              staff && (
                <Modal trigger="Add task" title="Add a follow-up task" size="sm">
                  <ActionForm action={createTaskAction.bind(null, order.id)} className="space-y-4">
                    <div>
                      <Label htmlFor="task-title">What needs doing?</Label>
                      <Input id="task-title" name="title" required maxLength={200} placeholder="Call back about the battery option" />
                      <FieldError name="title" />
                    </div>
                    <div>
                      <Label htmlFor="task-due">Due</Label>
                      <Input id="task-due" name="dueAt" type="datetime-local" required defaultValue={tomorrowNine} className="max-w-60" />
                      <FieldError name="dueAt" />
                    </div>
                    <div>
                      <Label htmlFor="task-notes" optional>
                        Notes
                      </Label>
                      <Textarea id="task-notes" name="notes" rows={2} />
                    </div>
                    <FormMessage />
                    <div className="flex justify-end gap-2">
                      <CancelButton />
                      <SubmitButton>Add task</SubmitButton>
                    </div>
                  </ActionForm>
                </Modal>
              )
            }
          />
          {openTasks.length === 0 && doneTasks.length === 0 ? (
            <CardBody>
              <p className="text-sm text-slate-500">No tasks. Add one to be reminded when it is due.</p>
            </CardBody>
          ) : (
            <ul className="divide-y divide-slate-100">
              {openTasks.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-900">{t.title}</p>
                    {t.notes && <p className="mt-0.5 text-xs whitespace-pre-wrap text-slate-500">{t.notes}</p>}
                    <p className={cx('mt-0.5 text-xs', t.dueAt <= now ? 'font-medium text-red-600' : 'text-slate-500')}>
                      {t.dueAt <= now ? 'Overdue since' : 'Due'} {fmtDateTime(t.dueAt)}
                    </p>
                  </div>
                  {staff && (
                    <ActionButton action={completeTaskAction.bind(null, t.id)} size="sm">
                      Done
                    </ActionButton>
                  )}
                </li>
              ))}
              {doneTasks.map((t) => (
                <li key={t.id} className="px-4 py-2 text-sm text-slate-400 line-through">
                  {t.title}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Customer"
            actions={
              editable && (
                <Modal trigger="Edit" title="Edit customer" size="sm">
                  <ActionForm action={updateCustomerAction.bind(null, order.id)} keepValues className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="c-first">First name</Label>
                        <Input id="c-first" name="firstName" defaultValue={c.firstName} required />
                        <FieldError name="firstName" />
                      </div>
                      <div>
                        <Label htmlFor="c-last">Last name</Label>
                        <Input id="c-last" name="lastName" defaultValue={c.lastName} />
                      </div>
                    </div>
                    <fieldset>
                      <legend className="mb-1 text-xs font-medium text-slate-600">Phone numbers (the first is the main one)</legend>
                      <div className="space-y-2">
                        {[...c.phones.map((ph) => ph.raw), ''].slice(0, 4).map((value, i) => (
                          <div key={i}>
                            <Input name="phone" type="tel" defaultValue={value} aria-label={`Phone ${i + 1}`} placeholder={value ? undefined : 'Add another number'} />
                            <FieldError name={`phones.${i}`} />
                          </div>
                        ))}
                      </div>
                    </fieldset>
                    <fieldset>
                      <legend className="mb-1 text-xs font-medium text-slate-600">Email addresses (the first is the main one)</legend>
                      <div className="space-y-2">
                        {[...c.emails.map((e) => e.email), ''].slice(0, 4).map((value, i) => (
                          <div key={i}>
                            <Input name="email" type="email" defaultValue={value} aria-label={`Email ${i + 1}`} placeholder={value ? undefined : 'Add another address'} />
                            <FieldError name={`emails.${i}`} />
                          </div>
                        ))}
                      </div>
                    </fieldset>
                    <div>
                      <Label htmlFor="c-notes" optional>
                        Notes about the customer
                      </Label>
                      <Textarea id="c-notes" name="notes" rows={3} defaultValue={c.notes} />
                    </div>
                    <FormMessage />
                    <div className="flex justify-end gap-2">
                      <CancelButton />
                      <SubmitButton>Save</SubmitButton>
                    </div>
                  </ActionForm>
                </Modal>
              )
            }
          />
          <CardBody>
            <Dl
              rows={[
                ['Phone', c.phones.length ? <ContactList items={c.phones.map((ph) => ({ key: ph.id, text: ph.raw, href: `tel:${ph.normalized}` }))} /> : null],
                ['Email', c.emails.length ? <ContactList items={c.emails.map((e) => ({ key: e.id, text: e.email, href: `mailto:${e.email}` }))} /> : null],
                ['Notes', c.notes ? <span className="whitespace-pre-wrap">{c.notes}</span> : null],
              ]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Property"
            description="Shared by every order at this address."
            actions={
              editable && (
                <Modal trigger="Edit" title="Edit property" size="sm">
                  <ActionForm action={updatePropertyAction.bind(null, order.id)} keepValues className="space-y-4">
                    <PropertyFields p={p} full />
                    <FormMessage />
                    <div className="flex justify-end gap-2">
                      <CancelButton />
                      <SubmitButton>Save</SubmitButton>
                    </div>
                  </ActionForm>
                </Modal>
              )
            }
          />
          <CardBody>
            <Dl
              rows={[
                ['Address', formatAddress(p)],
                ['Type', sourced('propertyType', p.propertyType)],
                ['NMI', sourced('nmi', p.nmi)],
                ['Retailer', sourced('retailer', p.retailer)],
                ['Supply', sourced('phase', p.phase)],
                ['Roof', sourced('roofType', p.roofType)],
                ['Storeys', sourced('storeys', p.storeys)],
                ['Notes', p.notes ? <span className="whitespace-pre-wrap">{p.notes}</span> : null],
              ]}
            />
            {editable && (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <Modal
                  trigger="This order is for a different address"
                  title="Move this order to another address"
                  description="Use this when the enquiry was attached to an address the customer already had on file but is really for another property. The existing address stays with the customer's other orders."
                  variant="link"
                  triggerClassName="text-xs font-medium text-brand-700 hover:underline"
                >
                  <ActionForm action={movePropertyAction.bind(null, order.id)} keepValues className="space-y-4">
                    <PropertyFields p={null} />
                    <FormMessage />
                    <div className="flex justify-end gap-2">
                      <CancelButton />
                      <SubmitButton>Move order</SubmitButton>
                    </div>
                  </ActionForm>
                </Modal>
              </div>
            )}
          </CardBody>
        </Card>

        <BillsCard
          bills={bills}
          available={assistant}
          read={staff ? (documentId) => readBillAction.bind(null, documentId) : undefined}
          takeValue={editable ? (readingId, field) => billValueAction.bind(null, readingId, field) : undefined}
        />

        <Card>
          <CardHeader title="Enquiry" />
          <CardBody>
            <Dl
              rows={[
                ['Source', `${order.source.name}${order.sourceDetail ? ` · ${order.sourceDetail}` : ''}`],
                ['Received', fmtDateTime(order.leadCreatedAt)],
                ['Interested in', details.components?.join(', ')],
                ['Solar wanted', details.systemKw !== undefined ? `${details.systemKw} kW` : null],
                ['Battery wanted', details.batteryKwh !== undefined ? `${details.batteryKwh} kWh` : null],
                ['Monthly bill', details.monthlyBill !== undefined ? `$${details.monthlyBill}` : null],
                ['Timeline', details.timeline ? (TIMELINE_LABEL[details.timeline as keyof typeof TIMELINE_LABEL] ?? details.timeline) : null],
                ['Best time', details.bestTime ? (BEST_TIME_LABEL[details.bestTime as keyof typeof BEST_TIME_LABEL] ?? details.bestTime) : null],
                ['Household', details.householdSize],
                ['Goals', details.goals],
                ['Preference', details.productPreference],
                ['Their notes', details.notes ? <span className="whitespace-pre-wrap">{details.notes}</span> : null],
                ...(attribution.utmSource || attribution.utmCampaign ? [['Campaign', [attribution.utmSource, attribution.utmMedium, attribution.utmCampaign].filter(Boolean).join(' / ')] as [string, string]] : []),
              ]}
            />
          </CardBody>
        </Card>

        {header.siblings.length > 0 && (
          <Card>
            <CardHeader title="Other orders of this customer" />
            <ul className="divide-y divide-slate-100">
              {header.siblings.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <Link href={`/orders/${s.id}`} className="font-medium text-brand-700 hover:underline">
                    {s.orderNo}
                  </Link>
                  <span className="text-slate-500">{s.address}</span>
                  <StageBadge stage={s.stage} sideState={s.sideState} />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

function ContactList({ items }: { items: { key: string; text: string; href: string }[] }) {
  return (
    <ul>
      {items.map((item, i) => (
        <li key={item.key}>
          <a href={item.href} className="text-brand-700 hover:underline">
            {item.text}
          </a>
          {i === 0 && items.length > 1 && <span className="ml-1.5 text-xs text-slate-400">main</span>}
        </li>
      ))}
    </ul>
  );
}

type PropertyValues = { addressLine1: string; addressLine2: string; suburb: string; state: string; postcode: string; propertyType: string; nmi: string; retailer: string; phase: string; roofType: string; storeys: string; notes: string };

function PropertyFields({ p, full }: { p: PropertyValues | null; full?: boolean }) {
  return (
    <>
      <div>
        <Label htmlFor={`p-line1-${full}`}>Street address</Label>
        <Input id={`p-line1-${full}`} name="addressLine1" defaultValue={p?.addressLine1} />
        <FieldError name="addressLine1" />
      </div>
      <div>
        <Label htmlFor={`p-line2-${full}`} optional>
          Unit, building or lot
        </Label>
        <Input id={`p-line2-${full}`} name="addressLine2" defaultValue={p?.addressLine2} />
      </div>
      <div className="grid grid-cols-6 gap-3">
        <div className="col-span-3">
          <Label htmlFor={`p-suburb-${full}`}>Suburb</Label>
          <Input id={`p-suburb-${full}`} name="suburb" defaultValue={p?.suburb} />
        </div>
        <div className="col-span-1">
          <Label htmlFor={`p-state-${full}`}>State</Label>
          <Select id={`p-state-${full}`} name="state" defaultValue={p?.state ?? ''} className="px-1.5">
            <option value=""></option>
            {AU_STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
          <FieldError name="state" />
        </div>
        <div className="col-span-2">
          <Label htmlFor={`p-postcode-${full}`}>Postcode</Label>
          <Input id={`p-postcode-${full}`} name="postcode" defaultValue={p?.postcode} inputMode="numeric" maxLength={4} />
          <FieldError name="postcode" />
        </div>
      </div>
      <div>
        <Label htmlFor={`p-type-${full}`} optional>
          Property type
        </Label>
        <Select id={`p-type-${full}`} name="propertyType" defaultValue={p?.propertyType ?? ''}>
          <option value=""></option>
          {PROPERTY_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </Select>
        <FieldError name="propertyType" />
      </div>
      {full && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="p-nmi" optional>
                NMI (meter number)
              </Label>
              <Input id="p-nmi" name="nmi" defaultValue={p?.nmi} />
              <FieldError name="nmi" />
            </div>
            <div>
              <Label htmlFor="p-retailer" optional>
                Electricity retailer
              </Label>
              <Input id="p-retailer" name="retailer" defaultValue={p?.retailer} />
            </div>
            <div>
              <Label htmlFor="p-phase" optional>
                Supply
              </Label>
              <Select id="p-phase" name="phase" defaultValue={p?.phase ?? ''}>
                <option value=""></option>
                {PHASES.map((ph) => (
                  <option key={ph}>{ph}</option>
                ))}
              </Select>
              <FieldError name="phase" />
            </div>
            <div>
              <Label htmlFor="p-storeys" optional>
                Storeys
              </Label>
              <Input id="p-storeys" name="storeys" defaultValue={p?.storeys} placeholder="Single, double…" />
            </div>
          </div>
          <div>
            <Label htmlFor="p-roof" optional>
              Roof
            </Label>
            <Input id="p-roof" name="roofType" defaultValue={p?.roofType} placeholder="Tile, tin, flat…" />
          </div>
          <div>
            <Label htmlFor="p-notes" optional>
              Site notes
            </Label>
            <Textarea id="p-notes" name="notes" rows={3} defaultValue={p?.notes} placeholder="Access, pets, shading, anything the installers should know" />
          </div>
        </>
      )}
    </>
  );
}

import type { Metadata } from 'next';
import Form from 'next/form';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ORDER_STAGES, STAGE_LABEL, can, getConfig, getDashboard, isManager, localDateString, parseDateOnly, type OrderStage } from '@bluven/core';
import { Card, CardBody, CardHeader, EmptyState, Input, PageHeader, Stat, Table, Td, buttonClass, cx } from '@/components/ui';
import { one, withParams } from '@/lib/params';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Dashboard' };

function Bar({ value, max, tone = 'bg-brand-500' }: { value: number; max: number; tone?: string }) {
  const width = max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100)) : 0;
  return (
    <span className="block h-2 w-full overflow-hidden rounded bg-slate-100" aria-hidden>
      <span className={cx('block h-full rounded', tone)} style={{ width: `${width}%` }} />
    </span>
  );
}

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

/** Shorter headings for the per-person table, which has one column per stage. */
const STAGE_COLUMN: Partial<Record<OrderStage, string>> = { DEPOSIT_PENDING: 'Dep. pending', DEPOSIT_CONFIRMED: 'Dep. confirmed', PUSHED: 'With Ops', RETURNED: 'Returned' };

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, ctx } = await requireSession();
  // Managers see the whole team. A salesperson sees the same figures for their own orders only.
  if (!can(user, 'orders.work')) notFound();
  const manager = isManager(user);
  const sp = await searchParams;
  const tz = getConfig().timeZone;
  const now = new Date();
  const today = localDateString(now, tz);
  const daysAgo = (n: number) => localDateString(new Date(now.getTime() - n * 86_400_000), tz);
  const from = parseDateOnly(one(sp.from) ?? '') ? one(sp.from)! : daysAgo(29);
  const to = parseDateOnly(one(sp.to) ?? '') ? one(sp.to)! : today;
  const d = await getDashboard(ctx, from <= to ? { from, to } : { from: to, to: from });
  const maxSource = Math.max(1, ...d.bySource.map((s) => s.leads));
  const maxWeek = Math.max(1, ...d.weekly.map((w) => Math.max(w.leads, w.signed)));
  const maxMonth = Math.max(1, ...d.monthly.map((m) => Math.max(m.leads, m.signed)));
  const days = (n: number | null) => (n === null ? null : Number.isInteger(n) || n >= 10 ? String(Math.round(n)) : n.toFixed(1));
  const monthName = (month: string) => new Intl.DateTimeFormat('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
  const maxLost = Math.max(1, ...d.lostReasons.map((l) => l.count));
  const activeStages = ORDER_STAGES.filter((s) => s !== 'HANDED_OVER');

  return (
    <>
      <PageHeader
        title={manager ? 'Dashboard' : 'My numbers'}
        description={manager ? 'How leads are coming in, how they are converting, and where things are waiting.' : 'Your own leads and orders: how they are converting, and what is waiting on you.'}
        actions={
          <Form action="/dashboard" className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="from" className="mb-1 block text-xs font-medium text-slate-600">
                From
              </label>
              <Input id="from" name="from" type="date" defaultValue={d.range.from} max={today} />
            </div>
            <div>
              <label htmlFor="to" className="mb-1 block text-xs font-medium text-slate-600">
                To
              </label>
              <Input id="to" name="to" type="date" defaultValue={d.range.to} max={today} />
            </div>
            <button type="submit" className={buttonClass('secondary')}>
              Apply
            </button>
            <span className="flex gap-2 pb-2 text-xs">
              {[7, 30, 90, 365].map((n) => (
                <Link key={n} href={withParams('/dashboard', { from: daysAgo(n - 1), to: today })} className="text-slate-500 hover:text-slate-800">
                  {n === 365 ? '12 months' : `${n} days`}
                </Link>
              ))}
            </span>
            {/* A plain link: the browser downloads the file. */}
            <a href={withParams('/api/reports/orders', { from: d.range.from, to: d.range.to })} className={buttonClass('secondary')} title="One row per order whose enquiry was received in the period, with the date it reached each stage">
              Export orders (CSV)
            </a>
          </Form>
        }
      />

      <div className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">In the selected period</div>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="New leads" value={d.totals.leads} />
        <Stat
          label="Contracts signed"
          value={d.totals.signed}
          hint={`${pct(d.totals.signed, d.totals.leads)} of new leads${d.totals.avgDaysToSign === null ? '' : ` · ${days(d.totals.avgDaysToSign)} days from enquiry to signature on average`}`}
        />
        <Stat label="Handed over to operations" value={d.totals.handedOver} />
        <Stat label="Lost" value={d.totals.lost} />
      </div>
      <div className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">Right now</div>
      <div className={cx('mb-6 grid grid-cols-2 gap-3', manager ? 'lg:grid-cols-6' : 'lg:grid-cols-5')}>
        {manager && <Stat label="Unassigned leads" value={d.totals.unassigned} href="/orders/unassigned" tone={d.totals.unassigned > 0 ? 'warn' : undefined} />}
        <Stat label="Deposits waiting for finance" value={d.totals.pendingDeposits} href="/orders?stage=DEPOSIT_PENDING" />
        <Stat label="Returned by operations" value={d.totals.returned} href="/orders?stage=RETURNED" tone={d.totals.returned > 0 ? 'bad' : undefined} />
        {/* Three tiers of one count: each includes the ones to its right, and each opens exactly the orders it counts. */}
        <Stat label={`Idle ${d.idleDays[0]}+ days`} value={d.totals.idle[0]} href="/orders?idle=1" tone={d.totals.idle[0] > 0 ? 'warn' : undefined} hint="The salesperson is reminded" />
        <Stat label={`Idle ${d.idleDays[1]}+ days`} value={d.totals.idle[1]} href="/orders?idle=2" tone={d.totals.idle[1] > 0 ? 'bad' : undefined} hint="The managers are told" />
        <Stat label={`Idle ${d.idleDays[2]}+ days`} value={d.totals.idle[2]} href="/orders?idle=3" tone={d.totals.idle[2] > 0 ? 'bad' : undefined} hint="Unsigned ones go back to the pool" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="xl:col-span-2">
          <CardHeader title="Leads by source" description="Of the leads received in the period: how far they have got so far, and how many days the ones that signed took from enquiry to signature." />
          {d.bySource.length === 0 ? (
            <EmptyState title="No leads in this period" />
          ) : (
            <Table head={['Source', 'Leads', '', 'Contacted', 'Quoted', 'Signed', 'Lost', 'Days to sign']}>
              {d.bySource.map((s) => (
                <tr key={s.sourceId}>
                  <Td className="font-medium text-slate-900">{s.name}</Td>
                  <Td className="tabular-nums text-slate-900">{s.leads}</Td>
                  <Td className="w-32">
                    <Bar value={s.leads} max={maxSource} />
                  </Td>
                  <Td className="tabular-nums text-slate-600">
                    {s.contacted} <span className="text-xs text-slate-400">{pct(s.contacted, s.leads)}</span>
                  </Td>
                  <Td className="tabular-nums text-slate-600">
                    {s.quoted} <span className="text-xs text-slate-400">{pct(s.quoted, s.leads)}</span>
                  </Td>
                  <Td className="tabular-nums font-medium text-emerald-700">
                    {s.signed} <span className="text-xs font-normal text-slate-400">{pct(s.signed, s.leads)}</span>
                  </Td>
                  <Td className="tabular-nums text-slate-600">{s.lost}</Td>
                  <Td className="tabular-nums text-slate-600" title="Average days from the enquiry to the signature, for the leads of this period that have signed">
                    {days(s.avgDaysToSign) ?? <span className="text-slate-300">—</span>}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="Last eight weeks" description="Leads received and contracts signed per week (weeks start on Monday)." />
          <CardBody>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-medium text-slate-500">
                  <th scope="col" className="pb-2 font-medium">
                    Week of
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Leads
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Signed
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.weekly.map((w) => (
                  <tr key={w.weekStart}>
                    <td className="py-1 pr-3 whitespace-nowrap text-slate-600">{w.weekStart}</td>
                    <td className="w-1/2 py-1 pr-4">
                      <span className="flex items-center gap-2">
                        <span className="w-6 text-right tabular-nums text-slate-900">{w.leads}</span>
                        <Bar value={w.leads} max={maxWeek} />
                      </span>
                    </td>
                    <td className="w-1/3 py-1">
                      <span className="flex items-center gap-2">
                        <span className="w-6 text-right tabular-nums text-slate-900">{w.signed}</span>
                        <Bar value={w.signed} max={maxWeek} tone="bg-emerald-500" />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Why orders were lost" description="Orders marked as lost in the period." />
          {d.lostReasons.length === 0 ? (
            <EmptyState title="Nothing was lost in this period" />
          ) : (
            <CardBody>
              <ul className="space-y-2">
                {d.lostReasons.map((l) => (
                  <li key={l.label} className="grid grid-cols-[minmax(0,1fr)_2rem_40%] items-center gap-3 text-sm">
                    <span className="truncate text-slate-700">{l.label}</span>
                    <span className="text-right tabular-nums text-slate-900">{l.count}</span>
                    <Bar value={l.count} max={maxLost} tone="bg-red-400" />
                  </li>
                ))}
              </ul>
            </CardBody>
          )}
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader title="Last twelve months" description="Per calendar month: enquiries received, contracts signed, orders handed over to operations and orders lost. Not affected by the period chosen above." />
          <Table head={['Month', 'Leads', '', 'Signed', '', 'Signed of leads', 'Handed over', 'Lost']}>
            {d.monthly.map((m) => (
              <tr key={m.month}>
                <Td className="whitespace-nowrap text-slate-600">{monthName(m.month)}</Td>
                <Td className="w-12 tabular-nums text-slate-900">{m.leads}</Td>
                <Td className="w-1/4">
                  <Bar value={m.leads} max={maxMonth} />
                </Td>
                <Td className="w-12 tabular-nums text-slate-900">{m.signed}</Td>
                <Td className="w-1/4">
                  <Bar value={m.signed} max={maxMonth} tone="bg-emerald-500" />
                </Td>
                <Td className="tabular-nums text-slate-600">{pct(m.signed, m.leads)}</Td>
                <Td className="tabular-nums text-slate-600">{m.handedOver}</Td>
                <Td className="tabular-nums text-slate-600">{m.lost}</Td>
              </tr>
            ))}
          </Table>
          <CardBody className="border-t border-slate-100 py-2 text-xs text-slate-500">
            “Signed of leads” compares the contracts signed in a month with the enquiries received in the same month. A contract usually belongs to an enquiry from an earlier month, so read it as a trend, not as a conversion rate.
          </CardBody>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader title={manager ? 'By salesperson' : 'Your pipeline'} description="Orders in progress by stage, contracts signed in the period, and how quickly new assignments got a first call or message." />
          {d.bySalesperson.length === 0 ? (
            <EmptyState title="No salespeople yet" />
          ) : (
            <Table className="[&_td]:px-3 [&_th]:px-3" head={['Salesperson', 'Open', ...activeStages.map((s) => STAGE_COLUMN[s] ?? STAGE_LABEL[s]), 'Signed in period', 'First response', 'Idle']}>
              {d.bySalesperson.map((p) => (
                <tr key={p.userId}>
                  <Td>
                    <Link href={manager ? `/orders?owner=${p.userId}` : '/orders'} className="font-medium text-slate-900 hover:text-brand-700">
                      {p.name}
                    </Link>
                  </Td>
                  <Td className="font-medium tabular-nums text-slate-900">{p.open}</Td>
                  {activeStages.map((s) => (
                    <Td key={s} className="tabular-nums text-slate-600">
                      {p.stages[s] ?? <span className="text-slate-300">0</span>}
                    </Td>
                  ))}
                  <Td className="font-medium tabular-nums text-emerald-700">{p.signedInRange}</Td>
                  <Td className="tabular-nums text-slate-600">
                    {p.avgFirstResponseHours === null ? <span className="text-slate-300">—</span> : p.avgFirstResponseHours < 1 ? `${Math.round(p.avgFirstResponseHours * 60)} min` : `${p.avgFirstResponseHours.toFixed(1)} h`}
                  </Td>
                  <Td className={cx('tabular-nums', p.idle > 0 ? 'font-medium text-amber-700' : 'text-slate-300')} title={`Idle ${d.idleDays[0]} days or more${p.idleLong > 0 ? `; ${p.idleLong} of them ${d.idleDays[1]} days or more` : ''}`}>
                    {p.idle}
                    {p.idleLong > 0 && <span className="ml-1 text-xs font-normal text-red-600">({p.idleLong} long)</span>}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

      </div>
    </>
  );
}

import type { Metadata } from 'next';
import Form from 'next/form';
import Link from 'next/link';
import { can, formatAddress, fullName, listSalespeople, listUnassignedOrders, relativeTime, type LeadDetails } from '@bluven/core';
import { notFound } from 'next/navigation';
import { ActionForm, FormMessage, SubmitButton } from '@/components/client';
import { Badge, Card, EmptyState, Input, PageHeader, Pagination, Select, Table, Tabs, Td, buttonClass } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import { one, withParams } from '@/lib/params';
import { requireSession } from '@/lib/session';
import { assignAction } from '../actions';

export const metadata: Metadata = { title: 'Unassigned leads' };

export default async function UnassignedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, ctx } = await requireSession();
  if (!can(user, 'orders.assign')) notFound();
  const sp = await searchParams;
  const history = one(sp.tab) === 'history';
  const q = one(sp.q) ?? '';
  const page = Number(one(sp.page) ?? '1') || 1;
  const [result, salespeople] = await Promise.all([listUnassignedOrders(ctx, { history, q, page, pageSize: 50 }), listSalespeople(ctx.db)]);
  const now = new Date();

  return (
    <>
      <PageHeader title="Unassigned leads" description="Leads that nobody is working on yet. Tick the ones to hand out, choose a salesperson, and assign." />
      <Tabs
        current={history ? 'history' : 'new'}
        tabs={[
          { key: 'new', label: 'Waiting for a salesperson', href: '/orders/unassigned' },
          { key: 'history', label: 'Imported history', href: '/orders/unassigned?tab=history' },
        ]}
      />
      <Card className="mb-4">
        <Form action="/orders/unassigned" className="flex flex-wrap items-end gap-3 px-4 py-3">
          {history && <input type="hidden" name="tab" value="history" />}
          <div className="min-w-56 flex-1">
            <label htmlFor="q" className="mb-1 block text-xs font-medium text-slate-600">
              Search
            </label>
            <Input id="q" name="q" type="search" defaultValue={q} placeholder="Name, phone, email or address" />
          </div>
          <button type="submit" className={buttonClass('secondary')}>
            Search
          </button>
        </Form>
      </Card>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyState title={history ? 'No imported history' : 'The pool is empty'}>
            {history ? 'Leads imported in backfill mode appear here.' : 'New leads from the Bluven website and other sources will appear here as they arrive.'}
          </EmptyState>
        ) : (
          <ActionForm action={assignAction}>
            <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-4 py-3">
              <div>
                <label htmlFor="ownerId" className="mb-1 block text-xs font-medium text-slate-600">
                  Assign selected to
                </label>
                <Select id="ownerId" name="ownerId" required defaultValue="">
                  <option value="" disabled>
                    Choose a salesperson
                  </option>
                  {salespeople.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.openOrders} open)
                    </option>
                  ))}
                </Select>
              </div>
              <SubmitButton pendingLabel="Assigning…">Assign</SubmitButton>
              <FormMessage className="flex-1" />
            </div>
            <Table head={['', 'Lead', 'Contact', 'Address', 'Interested in', 'Source', 'Received']}>
              {result.rows.map((o) => {
                const details = o.leadDetails as LeadDetails;
                return (
                  <tr key={o.id} className="hover:bg-slate-50/60">
                    <Td className="w-8">
                      <input type="checkbox" name="orderId" value={o.id} aria-label={`Select ${fullName(o.customer)}`} className="size-4 rounded border-slate-300 accent-brand-600" />
                    </Td>
                    <Td>
                      <Link href={`/orders/${o.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                        {fullName(o.customer)}
                      </Link>
                      <div className="text-xs text-slate-500">{o.orderNo}</div>
                      {o.possibleDuplicateOfId && !o.duplicateDismissedAt && (
                        <div className="mt-1">
                          <Badge tone="amber">Possible duplicate</Badge>
                        </div>
                      )}
                    </Td>
                    <Td className="text-slate-600">
                      <div>{o.customer.phones[0]?.raw}</div>
                      <div className="text-xs text-slate-500">{o.customer.emails[0]?.email}</div>
                    </Td>
                    <Td className="max-w-56 text-slate-600">{formatAddress(o.property) || <span className="text-slate-300">—</span>}</Td>
                    <Td className="text-slate-600">
                      {details.components?.join(', ') || <span className="text-slate-300">—</span>}
                      {details.monthlyBill !== undefined && <div className="text-xs text-slate-500">Bill about ${details.monthlyBill}/month</div>}
                    </Td>
                    <Td className="text-slate-600">{o.source.name}</Td>
                    <Td className="text-slate-600">
                      <span title={fmtDateTime(o.leadCreatedAt)}>{relativeTime(o.leadCreatedAt, now)}</span>
                    </Td>
                  </tr>
                );
              })}
            </Table>
          </ActionForm>
        )}
        <Pagination
          page={result.page}
          pageCount={result.pageCount}
          total={result.total}
          hrefFor={(p) => withParams('/orders/unassigned', { tab: history ? 'history' : undefined, q: q || undefined, page: p > 1 ? String(p) : undefined })}
        />
      </Card>
    </>
  );
}

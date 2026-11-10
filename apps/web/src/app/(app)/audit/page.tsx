import type { Metadata } from 'next';
import Form from 'next/form';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { auditFacets, can, searchAudit, type AuditFilters } from '@bluven/core';
import { AuditTable } from '@/components/audit-table';
import { Card, Input, PageHeader, Pagination, Select, buttonClass } from '@/components/ui';
import { one, withParams } from '@/lib/params';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Audit log' };

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, ctx } = await requireSession();
  if (!can(user, 'audit.view')) notFound();
  const sp = await searchParams;
  const filters: AuditFilters = {
    actorId: one(sp.actor) || null,
    action: one(sp.action) || null,
    entityType: one(sp.entity) || null,
    orderNo: one(sp.order) || null,
    q: one(sp.q) || null,
    from: one(sp.from) || null,
    to: one(sp.to) || null,
    page: Number(one(sp.page) ?? '1') || 1,
  };
  const [result, facets] = await Promise.all([searchAudit(ctx, filters), auditFacets(ctx)]);
  const query = { actor: filters.actorId ?? undefined, action: filters.action ?? undefined, entity: filters.entityType ?? undefined, order: filters.orderNo ?? undefined, q: filters.q ?? undefined, from: filters.from ?? undefined, to: filters.to ?? undefined };
  const groups = [...new Set(facets.actions.map((a) => a.split('.')[0]!))];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change in the CRM: who did it, when, from where, and the values before and after. Entries cannot be edited or deleted."
        actions={
          <a href={withParams('/api/audit/export', query)} className={buttonClass('secondary')}>
            Export as CSV
          </a>
        }
      />
      <Card className="mb-4">
        <Form action="/audit" className="grid gap-3 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
          <div className="xl:col-span-2">
            <label htmlFor="q" className="mb-1 block text-xs font-medium text-slate-600">
              Text
            </label>
            <Input id="q" name="q" type="search" defaultValue={filters.q ?? ''} placeholder="Words in the description" />
          </div>
          <div>
            <label htmlFor="order" className="mb-1 block text-xs font-medium text-slate-600">
              Order number
            </label>
            <Input id="order" name="order" defaultValue={filters.orderNo ?? ''} placeholder="BLV-2026-…" />
          </div>
          <div>
            <label htmlFor="actor" className="mb-1 block text-xs font-medium text-slate-600">
              Who
            </label>
            <Select id="actor" name="actor" defaultValue={filters.actorId ?? ''}>
              <option value="">Anyone</option>
              <option value="system">System and integrations</option>
              {facets.actors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="action" className="mb-1 block text-xs font-medium text-slate-600">
              What
            </label>
            <Select id="action" name="action" defaultValue={filters.action ?? ''}>
              <option value="">Anything</option>
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  <option value={`${g}.`}>All {g} events</option>
                  {facets.actions
                    .filter((a) => a.startsWith(`${g}.`))
                    .map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="from" className="mb-1 block text-xs font-medium text-slate-600">
              From
            </label>
            <Input id="from" name="from" type="date" defaultValue={filters.from ?? ''} />
          </div>
          <div>
            <label htmlFor="to" className="mb-1 block text-xs font-medium text-slate-600">
              To
            </label>
            <Input id="to" name="to" type="date" defaultValue={filters.to ?? ''} />
          </div>
          <div className="flex items-end gap-3">
            <button type="submit" className={buttonClass('secondary')}>
              Search
            </button>
            <Link href="/audit" className="pb-2 text-xs text-slate-500 hover:text-slate-800">
              Clear
            </Link>
          </div>
        </Form>
      </Card>
      <Card>
        <AuditTable rows={result.rows} />
        <Pagination page={result.page} pageCount={result.pageCount} total={result.total} hrefFor={(p) => withParams('/audit', { ...query, page: p > 1 ? String(p) : undefined })} />
      </Card>
    </>
  );
}

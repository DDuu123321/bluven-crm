import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CSV_MAX_ROWS, can } from '@bluven/core';
import { ActionForm, FieldError, FormMessage, SubmitButton } from '@/components/client';
import { Card, CardBody, CardHeader, Checkbox, Label, PageHeader, Select } from '@/components/ui';
import { requireSession } from '@/lib/session';
import { importCsvAction } from './actions';
import { ImportResult } from './result';

export const metadata: Metadata = { title: 'Import leads' };

export default async function ImportPage() {
  const { user, ctx } = await requireSession();
  if (!can(user, 'leads.import')) notFound();
  const sources = await ctx.db.leadSource.findMany({ where: { isActive: true, kind: { not: 'MANUAL' } }, orderBy: [{ kind: 'desc' }, { name: 'asc' }] });

  return (
    <>
      <PageHeader title="Import leads" description="Upload a CSV of leads from an outside source. Preview first: nothing is saved until you choose Import." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardBody>
            <ActionForm action={importCsvAction} keepValues stayOpen className="space-y-4">
              <div>
                <Label htmlFor="file">CSV file</Label>
                <input id="file" name="file" type="file" accept=".csv,text/csv" required className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50" />
                <FieldError name="file" />
              </div>
              <div className="max-w-sm">
                <Label htmlFor="sourceId">Where did these leads come from?</Label>
                <Select id="sourceId" name="sourceId" required defaultValue={sources.find((s) => s.kind === 'CSV')?.id ?? ''}>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                <FieldError name="sourceId" />
              </div>
              <Checkbox name="backfill" label="These are old leads, for the record only. Do not put them in the pool and do not notify anyone." />
              <FormMessage />
              <ImportResult />
              <div className="flex gap-2">
                <SubmitButton name="mode" value="preview" variant="secondary" pendingLabel="Checking…">
                  Preview
                </SubmitButton>
                <SubmitButton name="mode" value="import" pendingLabel="Importing…">
                  Import
                </SubmitButton>
              </div>
            </ActionForm>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="File format" />
          <CardBody className="space-y-3 text-sm text-slate-600">
            <p>
              The first row holds the column names. <strong className="font-medium text-slate-800">firstName</strong> and <strong className="font-medium text-slate-800">phone</strong> are required; everything else is optional.
            </p>
            <p>
              Recognised columns: externalId, createdAt, firstName, lastName, phone, email, address, suburb, state, postcode, propertyType, components, systemKw, batteryKwh, monthlyBill, timeline, bestTime, notes.
            </p>
            <p>Several products go in one cell separated by semicolons, for example “Solar; Battery”. Up to {CSV_MAX_ROWS} rows per file.</p>
            <p>A lead for someone who already has an order in progress at the same address joins that order as a note instead of creating a second one.</p>
            <a href="/api/leads/template" className="inline-block font-medium text-brand-700 hover:underline">
              Download a template
            </a>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

'use client';

import { useFormResult } from '@/components/client';

interface ImportData {
  dryRun: boolean;
  fileName: string;
  received: number;
  created: number;
  duplicates: number;
  alreadyReceived: number;
  failed: number;
  ignoredColumns: string[];
  problems: { row: number; error: string }[];
}

/** Shows what a preview found, or what an import did. */
export function ImportResult() {
  const result = useFormResult();
  if (!result?.ok || !result.data) return null;
  const d = result.data as unknown as ImportData;
  return (
    <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
      <p className="font-medium text-slate-900">
        {d.dryRun ? 'Preview of' : 'Imported'} {d.fileName}: {d.received} row{d.received === 1 ? '' : 's'}
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
        <Figure label={d.dryRun ? 'Would be created' : 'Created'} value={d.created} />
        <Figure label="Join an open order" value={d.duplicates} />
        <Figure label="Already received" value={d.alreadyReceived} />
        <Figure label="Rejected" value={d.failed} bad={d.failed > 0} />
      </dl>
      {d.ignoredColumns.length > 0 && <p className="text-slate-600">Columns that were not recognised and are ignored: {d.ignoredColumns.join(', ')}.</p>}
      {d.problems.length > 0 && (
        <div>
          <p className="font-medium text-red-700">Rows that {d.dryRun ? 'would be' : 'were'} rejected</p>
          <ul className="mt-1 max-h-60 overflow-y-auto text-slate-700">
            {d.problems.map((p) => (
              <li key={p.row}>
                Row {p.row}: {p.error}
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.dryRun && d.created + d.duplicates > 0 && <p className="text-slate-600">Nothing has been saved yet. Choose “Import” to go ahead.</p>}
    </div>
  );
}

function Figure({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${bad ? 'text-red-700' : 'text-slate-900'}`}>{value}</dd>
    </div>
  );
}

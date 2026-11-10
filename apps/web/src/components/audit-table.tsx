import Link from 'next/link';
import { fmtDateTime } from '@/lib/fmt';
import { EmptyState, Table, Td } from './ui';

export interface AuditRow {
  id: string;
  at: Date;
  actorLabel: string;
  action: string;
  entityType: string;
  summary: string;
  before: unknown;
  after: unknown;
  meta: unknown;
  ip: string | null;
  orderId: string | null;
  orderNo: string | null;
}

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div>
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <pre className="mt-0.5 max-h-64 overflow-auto rounded bg-slate-50 px-2 py-1.5 text-xs break-words whitespace-pre-wrap text-slate-700">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

/** Audit entries with the recorded before / after values behind a disclosure. */
export function AuditTable({ rows, showOrder = true }: { rows: AuditRow[]; showOrder?: boolean }) {
  if (rows.length === 0) return <EmptyState title="No entries" />;
  return (
    <Table head={['When', 'Who', 'What', ...(showOrder ? ['Order'] : []), 'Details']}>
      {rows.map((r) => {
        const hasDetails = r.before != null || r.after != null || r.meta != null;
        return (
          <tr key={r.id}>
            <Td className="whitespace-nowrap text-slate-600">{fmtDateTime(r.at)}</Td>
            <Td className="text-slate-900">
              {r.actorLabel}
              {r.ip && <div className="text-xs text-slate-400">{r.ip}</div>}
            </Td>
            <Td className="max-w-md">
              <div className="text-slate-900">{r.summary || r.action}</div>
              <div className="font-mono text-xs text-slate-400">{r.action}</div>
            </Td>
            {showOrder && (
              <Td>
                {r.orderId && r.orderNo ? (
                  <Link href={`/orders/${r.orderId}?tab=history`} className="text-brand-700 hover:underline">
                    {r.orderNo}
                  </Link>
                ) : (
                  <span className="text-slate-300">—</span>
                )}
              </Td>
            )}
            <Td className="min-w-64">
              {hasDetails ? (
                <details>
                  <summary className="cursor-pointer text-xs font-medium text-brand-700 hover:underline">Show values</summary>
                  <div className="mt-1.5 space-y-1.5">
                    <Json label="Before" value={r.before} />
                    <Json label="After" value={r.after} />
                    <Json label="Context" value={r.meta} />
                  </div>
                </details>
              ) : (
                <span className="text-slate-300">—</span>
              )}
            </Td>
          </tr>
        );
      })}
    </Table>
  );
}

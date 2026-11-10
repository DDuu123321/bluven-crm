import { BEST_TIME_LABEL, TIMELINE_LABEL, fullName, relativeTime, type LeadInput, type TimelineEntry } from '@bluven/core';
import { fmtDateTime } from '@/lib/fmt';
import { EmptyState, cx } from './ui';

const TYPE_STYLE: Record<string, { label: string; dot: string }> = {
  NOTE: { label: 'Note', dot: 'bg-slate-400' },
  CALL: { label: 'Call', dot: 'bg-brand-500' },
  MEETING: { label: 'Meeting', dot: 'bg-brand-500' },
  MESSAGE: { label: 'Message', dot: 'bg-brand-500' },
  EMAIL_IN: { label: 'Email received', dot: 'bg-brand-500' },
  EMAIL_OUT: { label: 'Email sent', dot: 'bg-brand-500' },
  LEAD: { label: 'Enquiry', dot: 'bg-violet-500' },
  ASSIGNMENT: { label: 'Assignment', dot: 'bg-slate-400' },
  STAGE_CHANGE: { label: 'Stage', dot: 'bg-emerald-500' },
  DOCUMENT: { label: 'Files', dot: 'bg-slate-400' },
  QUOTE: { label: 'Quote', dot: 'bg-violet-500' },
  CONTRACT: { label: 'Contract', dot: 'bg-violet-500' },
  DEPOSIT: { label: 'Deposit', dot: 'bg-amber-500' },
  HANDOFF: { label: 'Operations', dot: 'bg-amber-500' },
  TASK: { label: 'Task', dot: 'bg-slate-400' },
  SYSTEM: { label: 'Update', dot: 'bg-slate-400' },
};

interface Group {
  key: string;
  first: TimelineEntry;
  /** Further file entries by the same person within a few minutes, folded into this one. */
  more: TimelineEntry[];
}

/** Folds runs of file uploads by the same person into one entry so they do not drown the conversation. */
function group(entries: TimelineEntry[]): Group[] {
  const out: Group[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (
      last &&
      e.type === 'DOCUMENT' &&
      last.first.type === 'DOCUMENT' &&
      last.first.actorId === e.actorId &&
      Math.abs(last.first.occurredAt.getTime() - e.occurredAt.getTime()) < 10 * 60_000
    ) {
      last.more.push(e);
    } else {
      out.push({ key: e.id, first: e, more: [] });
    }
  }
  return out;
}

function LeadDetails({ lead }: { lead: Partial<LeadInput> }) {
  const rows: [string, string | undefined][] = [
    ['Name', lead.firstName ? fullName({ firstName: lead.firstName, lastName: lead.lastName }) : undefined],
    ['Phone', lead.phone],
    ['Email', lead.email],
    ['Address', [lead.address, lead.suburb, lead.state, lead.postcode].filter(Boolean).join(', ') || undefined],
    ['Property', lead.propertyType],
    ['Interested in', lead.components?.join(', ')],
    ['Solar wanted', lead.systemKw !== undefined ? `${lead.systemKw} kW` : undefined],
    ['Battery wanted', lead.batteryKwh !== undefined ? `${lead.batteryKwh} kWh` : undefined],
    ['Monthly bill', lead.monthlyBill !== undefined ? `$${lead.monthlyBill}` : undefined],
    ['Timeline', lead.timeline ? (TIMELINE_LABEL[lead.timeline as keyof typeof TIMELINE_LABEL] ?? lead.timeline) : undefined],
    ['Best time', lead.bestTime ? (BEST_TIME_LABEL[lead.bestTime as keyof typeof BEST_TIME_LABEL] ?? lead.bestTime) : undefined],
    ['Household', lead.householdSize],
    ['Goals', lead.goals],
    ['Preference', lead.productPreference],
    ['Notes', lead.notes],
  ];
  const shown = rows.filter(([, v]) => v);
  if (shown.length === 0) return null;
  return (
    <details className="mt-1 text-sm">
      <summary className="cursor-pointer text-xs text-brand-700 hover:underline">What they submitted</summary>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md bg-slate-50 px-3 py-2 text-slate-700">
        {shown.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-slate-500">{label}</dt>
            <dd className="break-words whitespace-pre-wrap">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** The story of an order, newest first. */
export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) return <EmptyState title="Nothing has happened yet" />;
  const now = new Date();
  return (
    <ol className="relative space-y-4 px-4 py-4">
      {group(entries).map(({ key, first: e, more }) => {
        const style = TYPE_STYLE[e.type] ?? TYPE_STYLE.SYSTEM!;
        const lead = e.type === 'LEAD' ? ((e.payload as { lead?: Partial<LeadInput> } | null)?.lead ?? null) : null;
        const quiet = e.type === 'STAGE_CHANGE' || e.type === 'DOCUMENT' || e.type === 'ASSIGNMENT' || e.type === 'TASK';
        return (
          <li key={key} className="flex gap-3">
            <span aria-hidden className={cx('mt-1.5 size-2.5 shrink-0 rounded-full ring-4 ring-white', style.dot)} />
            <div className="min-w-0 flex-1">
              <p className={cx('text-sm', quiet ? 'text-slate-600' : 'font-medium text-slate-900')}>
                {more.length > 0 ? `${more.length + 1} file changes` : e.summary}
              </p>
              {more.length > 0 && (
                <ul className="mt-0.5 text-sm text-slate-600">
                  {[e, ...more].map((d) => (
                    <li key={d.id} className="truncate">
                      {d.summary}
                    </li>
                  ))}
                </ul>
              )}
              {e.body && <p className="mt-1 text-sm leading-relaxed break-words whitespace-pre-wrap text-slate-700">{e.body}</p>}
              {lead && <LeadDetails lead={lead} />}
              <p className="mt-0.5 text-xs text-slate-400">
                {e.actor?.name ?? (e.actorLabel || 'System')} · <time dateTime={e.occurredAt.toISOString()} title={fmtDateTime(e.occurredAt)}>{relativeTime(e.occurredAt, now)}</time> · {fmtDateTime(e.occurredAt)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// How a job stands with operations, shown the same way to operations (who change it) and to the
// salesperson and the managers (who read it).
import type { ReactNode } from 'react';
import { formatCents, formatDateOnly, type NoticeView, type OperationsView, type OpsItem } from '@bluven/core';
import { ActionButton } from '@/components/client';
import { Badge, Dl, cx, type Tone } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/fmt';
import type { ActionResult } from '@/lib/action-types';

/** The things operations arranges, each with what is on record. */
export function OpsItemList({ items }: { items: OpsItem[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {items.map((item) => (
        <li key={item.key} className="flex items-start gap-3 px-4 py-2.5">
          <span
            aria-hidden
            className={cx('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold', item.done ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500')}
          >
            {item.done ? '✓' : '·'}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-slate-900">
              {item.label}
              <span className="sr-only">{item.done ? ': settled' : ': open'}</span>
            </p>
            <p className="text-sm text-slate-500">{item.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

const NOTICE_TONE: Record<NoticeView['status'], Tone> = { PENDING: 'amber', SENT: 'green', FAILED: 'red', SKIPPED: 'slate' };
const NOTICE_STATUS: Record<NoticeView['status'], string> = { PENDING: 'On its way', SENT: 'Sent', FAILED: 'Not sent', SKIPPED: 'Not sent' };

/**
 * The e-mails that go to the customer by themselves, newest first. With `retry`, one that did
 * not go out can be sent again.
 */
export function NoticeList({ notices, retry }: { notices: NoticeView[]; retry?: (noticeId: string) => () => Promise<ActionResult> }) {
  if (notices.length === 0) return <p className="px-4 py-3 text-sm text-slate-500">Nothing has gone to the customer from here yet.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {notices.map((n) => (
        <li key={n.id} className="px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-slate-900">{n.kindLabel}</span>
            <Badge tone={NOTICE_TONE[n.status]}>{NOTICE_STATUS[n.status]}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            {n.status === 'SENT' ? `Sent ${fmtDateTime(n.sentAt)}` : `Written ${fmtDateTime(n.createdAt)}`}
            {n.toAddress ? ` · to ${n.toAddress}` : ''}
          </p>
          {n.note && n.status !== 'SENT' && <p className={cx('mt-1.5 rounded-md px-3 py-2', n.status === 'FAILED' ? 'bg-red-50 text-red-800' : 'bg-slate-50 text-slate-600')}>{n.note}</p>}
          {n.subject && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-xs font-medium text-brand-700 hover:underline">Read it</summary>
              <div className="mt-1.5 rounded-md bg-slate-50 px-3 py-2">
                <p className="font-medium text-slate-900">{n.subject}</p>
                <p className="mt-1 whitespace-pre-wrap text-slate-700">{n.body}</p>
              </div>
            </details>
          )}
          {retry && (n.status === 'FAILED' || n.status === 'SKIPPED') && (
            <div className="mt-2">
              <ActionButton action={retry(n.id)} size="sm">
                Send again
              </ActionButton>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** What follows the installation: the balance the customer was asked for, and the rebate. */
export function AfterInstallation({ view, extra }: { view: OperationsView; extra?: [label: ReactNode, value: ReactNode][] }) {
  const { balance, rebate } = view;
  return (
    <Dl
      rows={[
        ['Job done', fmtDate(view.jobDoneAt)],
        [
          'Balance',
          view.completedAt ? (
            <span key="b">
              Received{balance.amountCents !== null ? `: ${formatCents(balance.amountCents)}` : ''}
              {balance.receivedOn ? ` on ${formatDateOnly(balance.receivedOn)}` : ''}
            </span>
          ) : (
            <span key="b" className="flex flex-wrap items-center gap-2">
              Asked for by {formatDateOnly(balance.dueOn)}
              {balance.overdue && <Badge tone="red">Overdue</Badge>}
            </span>
          ),
        ],
        ...(balance.note ? ([['Note on the payment', <span key="n" className="whitespace-pre-wrap">{balance.note}</span>]] as [ReactNode, ReactNode][]) : []),
        ...(balance.chaseAskedAt && !view.completedAt ? ([['Sales asked to chase', fmtDateTime(balance.chaseAskedAt)]] as [ReactNode, ReactNode][]) : []),
        [
          'Rebate',
          rebate.appliedAt ? (
            `Applied for on ${fmtDate(rebate.appliedAt)}`
          ) : (
            <span key="r" className="flex flex-wrap items-center gap-2">
              Not applied for yet
              {rebate.overdue && <Badge tone="amber">Due</Badge>}
            </span>
          ),
        ],
        ...(view.completedAt ? ([['Job closed', fmtDateTime(view.completedAt)]] as [ReactNode, ReactNode][]) : []),
        ...(extra ?? []),
      ]}
    />
  );
}

/** What operations wrote about the job, newest first. */
export function OpsNotes({ notes }: { notes: OperationsView['notes'] }) {
  if (notes.length === 0) return <p className="text-sm text-slate-500">No notes yet.</p>;
  return (
    <ul className="space-y-2">
      {notes.map((n) => (
        <li key={n.id} className="rounded-md bg-slate-50 px-3 py-2 text-sm">
          <p className="whitespace-pre-wrap text-slate-800">{n.body}</p>
          <p className="mt-1 text-xs text-slate-500">
            {n.by} · {fmtDateTime(n.at)}
          </p>
        </li>
      ))}
    </ul>
  );
}

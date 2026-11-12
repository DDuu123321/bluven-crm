import type { Metadata } from 'next';
import Link from 'next/link';
import { NOTIFICATION_KINDS, NOTIFICATION_KIND_LABEL, getDailySummary, listNotifications, notificationKindCounts, relativeTime, type NotificationKind } from '@bluven/core';
import { ActionButton, ActionForm, FormMessage, SubmitButton } from '@/components/client';
import { Card, CardBody, CardHeader, Checkbox, EmptyState, PageHeader, cx } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import { one } from '@/lib/params';
import { requireSession } from '@/lib/session';
import { dailySummaryAction, markAllReadAction } from './actions';

export const metadata: Metadata = { title: 'Notifications' };

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ctx } = await requireSession();
  const sp = await searchParams;
  const asked = one(sp.kind);
  const kind = (NOTIFICATION_KINDS as readonly string[]).includes(asked ?? '') ? (asked as NotificationKind) : null;
  const unreadOnly = one(sp.show) === 'unread';
  const [items, counts, dailySummary] = await Promise.all([listNotifications(ctx, { take: 150, kind, unreadOnly }), notificationKindCounts(ctx), getDailySummary(ctx)]);
  const unread = counts.reduce((sum, c) => sum + c.unread, 0);
  const total = counts.reduce((sum, c) => sum + c.total, 0);
  const now = new Date();
  const href = (next: { kind?: NotificationKind | null; unread?: boolean }) => {
    const k = next.kind === undefined ? kind : next.kind;
    const u = next.unread === undefined ? unreadOnly : next.unread;
    const query = new URLSearchParams({ ...(k ? { kind: k } : {}), ...(u ? { show: 'unread' } : {}) }).toString();
    return query ? `/notifications?${query}` : '/notifications';
  };
  const chip = (active: boolean) => cx('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset', active ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-300 hover:bg-slate-50');

  return (
    <>
      <PageHeader
        title="Notifications"
        description={unread > 0 ? `${unread} unread` : 'You are all caught up.'}
        actions={unread > 0 ? <ActionButton action={markAllReadAction}>Mark all as read</ActionButton> : undefined}
      />
      {total > 0 && (
        <nav aria-label="Filter" className="mb-3 flex flex-wrap items-center gap-2">
          <Link href={href({ kind: null })} aria-current={!kind ? 'true' : undefined} className={chip(!kind)}>
            All
          </Link>
          {counts.map((c) => (
            <Link key={c.kind} href={href({ kind: c.kind })} aria-current={kind === c.kind ? 'true' : undefined} className={chip(kind === c.kind)}>
              {NOTIFICATION_KIND_LABEL[c.kind]}
              {c.unread > 0 && <span className={cx('rounded-full px-1.5 tabular-nums', kind === c.kind ? 'bg-white/20' : 'bg-brand-50 text-brand-700')}>{c.unread}</span>}
            </Link>
          ))}
          <span className="mx-1 h-4 w-px bg-slate-200" aria-hidden />
          <Link href={href({ unread: !unreadOnly })} aria-current={unreadOnly ? 'true' : undefined} className={chip(unreadOnly)}>
            Unread only
          </Link>
        </nav>
      )}
      <Card>
        {items.length === 0 ? (
          <EmptyState title={total === 0 ? 'Nothing here yet' : 'Nothing matches'}>
            {total === 0 ? 'Assignments, reminders and decisions from finance and operations will show up here.' : 'No notification of this kind. Choose “All” to see everything.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((n) => {
              const body = (
                <>
                  <p className={cx('text-sm', n.readAt ? 'text-slate-600' : 'font-medium text-slate-900')}>{n.title}</p>
                  {n.body && <p className="mt-0.5 line-clamp-2 text-sm text-slate-500">{n.body}</p>}
                  <p className="mt-0.5 text-xs text-slate-400" title={fmtDateTime(n.createdAt)}>
                    {relativeTime(n.createdAt, now)}
                  </p>
                </>
              );
              return (
                <li key={n.id} className="flex gap-3 px-4 py-3">
                  <span aria-hidden className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-brand-500')} />
                  <div className="min-w-0 flex-1">
                    {n.href ? (
                      <Link href={`/notifications/${n.id}`} className="block hover:opacity-80">
                        {body}
                      </Link>
                    ) : (
                      body
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card className="mt-4 max-w-2xl">
        <CardHeader title="E-mail" description="Notifications are also sent to your e-mail address, unless you have already read them here." />
        <CardBody>
          <ActionForm action={dailySummaryAction} keepValues stayOpen className="space-y-3">
            <Checkbox name="dailySummary" defaultChecked={dailySummary} label="Send me one summary each morning instead of an e-mail for every notification" />
            <p className="text-xs text-slate-500">The summary goes out after 7 am and lists what is still unread. Everything keeps arriving here at once, whichever you choose.</p>
            <FormMessage />
            <SubmitButton variant="secondary">Save</SubmitButton>
          </ActionForm>
        </CardBody>
      </Card>
    </>
  );
}

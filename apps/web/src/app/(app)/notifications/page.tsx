import type { Metadata } from 'next';
import Link from 'next/link';
import { listNotifications, relativeTime } from '@bluven/core';
import { ActionButton } from '@/components/client';
import { Card, EmptyState, PageHeader, cx } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import { requireSession } from '@/lib/session';
import { markAllReadAction } from './actions';

export const metadata: Metadata = { title: 'Notifications' };

export default async function NotificationsPage() {
  const { ctx } = await requireSession();
  const items = await listNotifications(ctx, { take: 150 });
  const unread = items.filter((n) => !n.readAt).length;
  const now = new Date();
  return (
    <>
      <PageHeader
        title="Notifications"
        description={unread > 0 ? `${unread} unread` : 'You are all caught up.'}
        actions={unread > 0 ? <ActionButton action={markAllReadAction}>Mark all as read</ActionButton> : undefined}
      />
      <Card>
        {items.length === 0 ? (
          <EmptyState title="Nothing here yet">Assignments, reminders and decisions from finance and operations will show up here.</EmptyState>
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
    </>
  );
}

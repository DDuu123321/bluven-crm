import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can, fullName, getConfig, listMyTasks, localDateString } from '@bluven/core';
import { ActionButton } from '@/components/client';
import { Card, CardHeader, EmptyState, PageHeader, cx } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import { requireSession } from '@/lib/session';
import { completeTaskAction } from './actions';

export const metadata: Metadata = { title: 'Tasks' };

export default async function TasksPage() {
  const { user, ctx } = await requireSession();
  if (!can(user, 'orders.work')) notFound();
  const tasks = await listMyTasks(ctx);
  const now = new Date();
  const today = localDateString(now, getConfig().timeZone);
  const groups = [
    { title: 'Overdue', tone: 'text-red-700', items: tasks.filter((t) => t.dueAt <= now) },
    { title: 'Later today', tone: 'text-slate-900', items: tasks.filter((t) => t.dueAt > now && localDateString(t.dueAt, getConfig().timeZone) === today) },
    { title: 'Coming up', tone: 'text-slate-900', items: tasks.filter((t) => t.dueAt > now && localDateString(t.dueAt, getConfig().timeZone) !== today) },
  ].filter((g) => g.items.length > 0);

  return (
    <>
      <PageHeader title="Tasks" description="Follow-ups assigned to you, across all your orders." />
      {groups.length === 0 ? (
        <Card>
          <EmptyState title="No open tasks">Add a task from an order to be reminded when it is due.</EmptyState>
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <Card key={group.title}>
              <CardHeader title={<span className={group.tone}>{group.title}</span>} description={`${group.items.length} task${group.items.length === 1 ? '' : 's'}`} />
              <ul className="divide-y divide-slate-100">
                {group.items.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900">{t.title}</p>
                      {t.notes && <p className="mt-0.5 line-clamp-2 text-sm text-slate-500">{t.notes}</p>}
                      <p className="mt-0.5 text-xs text-slate-500">
                        <Link href={`/orders/${t.order.id}`} className="font-medium text-brand-700 hover:underline">
                          {fullName(t.order.customer)} · {t.order.orderNo}
                        </Link>
                        <span className={cx('ml-2', t.dueAt <= now && 'font-medium text-red-600')}>Due {fmtDateTime(t.dueAt)}</span>
                      </p>
                    </div>
                    <ActionButton action={completeTaskAction.bind(null, t.id)} size="sm">
                      Mark done
                    </ActionButton>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

import Form from 'next/form';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ROLE_LABEL, can, isManager } from '@bluven/core';
import { AppNav, type NavSection } from '@/components/app-nav';
import { UserMenu } from '@/components/user-menu';
import { navCounts } from '@/lib/counts';
import { requireSession } from '@/lib/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { user, ctx } = await requireSession();
  const counts = await navCounts(ctx, user);

  const sections: NavSection[] = [];
  if (can(user, 'orders.work')) {
    sections.push({
      title: 'Sales',
      items: [
        ...(can(user, 'dashboard.view') ? [{ href: '/dashboard', label: 'Dashboard' }] : []),
        { href: '/orders', label: isManager(user) ? 'All orders' : 'My orders' },
        ...(can(user, 'dashboard.view') ? [] : [{ href: '/dashboard', label: 'My numbers' }]),
        ...(can(user, 'orders.assign') ? [{ href: '/orders/unassigned', label: 'Unassigned leads', countKey: 'unassigned', urgent: true }] : []),
        { href: '/tasks', label: 'Tasks', countKey: 'tasks', urgent: true },
        ...(can(user, 'leads.import') ? [{ href: '/leads/import', label: 'Import leads' }] : []),
        ...(can(user, 'orders.assign') ? [{ href: '/team', label: 'Team' }] : []),
      ],
    });
  }
  if (can(user, 'finance.deposits')) sections.push({ title: 'Finance', items: [{ href: '/finance', label: 'Deposits', countKey: 'deposits', urgent: true }] });
  if (can(user, 'ops.handoffs')) sections.push({ title: 'Operations', items: [{ href: '/ops', label: 'Incoming orders', countKey: 'handoffs', urgent: true }] });
  sections.push({ items: [{ href: '/notifications', label: 'Notifications', countKey: 'notifications' }] });
  const admin = [
    ...(can(user, 'config.manage') ? [{ href: '/settings/checklist', label: 'Handoff checklist' }, { href: '/settings/lost-reasons', label: 'Lost reasons' }] : []),
    ...(can(user, 'admin.users') ? [{ href: '/settings/users', label: 'Users' }] : []),
    ...(can(user, 'admin.leadSources') ? [{ href: '/settings/lead-sources', label: 'Lead sources' }] : []),
    ...(can(user, 'admin.settings') ? [{ href: '/settings/rules', label: 'Rules' }] : []),
    ...(can(user, 'admin.pylon') ? [{ href: '/settings/pylon', label: 'Pylon' }] : []),
    ...(can(user, 'audit.view') ? [{ href: '/audit', label: 'Audit log' }] : []),
  ];
  if (admin.length > 0) sections.push({ title: 'Administration', items: admin });

  return (
    <div className="flex min-h-screen">
      {/* The column runs the full height of the page; its content stays in view while the page scrolls. */}
      <aside className="hidden w-56 shrink-0 border-r border-slate-200 bg-white md:block">
        <div className="sticky top-0 flex h-screen flex-col overflow-y-auto px-2 py-4">
          <Link href="/" className="mb-5 px-3 text-lg font-semibold tracking-tight text-brand-700">
            Bluven CRM
          </Link>
          {can(user, 'orders.create') && (
            <Link href="/orders/new" className="mx-1 mb-5 flex h-9 items-center justify-center rounded-md bg-brand-600 text-sm font-medium text-white hover:bg-brand-700">
              New lead
            </Link>
          )}
          <AppNav sections={sections} initialCounts={counts} />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-4 border-b border-slate-200 bg-white/95 px-4 backdrop-blur md:px-6">
          <Link href="/" className="text-base font-semibold text-brand-700 md:hidden">
            Bluven CRM
          </Link>
          {can(user, 'orders.work') ? (
            <Form action="/orders" className="hidden max-w-md flex-1 md:block">
              <input type="hidden" name="view" value="all" />
              <input
                type="search"
                name="q"
                aria-label="Search orders"
                placeholder="Search name, phone, email, address or order number"
                className="h-9 w-full rounded-md border border-slate-300 bg-slate-50 px-3 text-sm placeholder:text-slate-400 focus:bg-white"
              />
            </Form>
          ) : (
            <span />
          )}
          <UserMenu name={user.name} roles={user.roles.map((r) => ROLE_LABEL[r]).join(', ')} />
        </header>
        {/* Small screens get the navigation as a strip under the header. */}
        <div className="border-b border-slate-200 bg-white px-2 py-2 md:hidden">
          <AppNav sections={[{ items: sections.flatMap((s) => s.items) }]} initialCounts={counts} />
        </div>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-6">{children}</main>
      </div>
    </div>
  );
}

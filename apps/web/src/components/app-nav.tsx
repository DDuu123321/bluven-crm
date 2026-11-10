'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cx } from './ui';

export interface NavItem {
  href: string;
  label: string;
  /** Key into the counts object for the badge, if any. */
  countKey?: string;
  /** Badge colour: red for things that are overdue or waiting on this person. */
  urgent?: boolean;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

export type Counts = Record<string, number>;

function isActive(pathname: string, href: string, all: string[]): boolean {
  if (pathname === href) return true;
  if (!pathname.startsWith(href + '/')) return false;
  // "/orders/unassigned" belongs to its own item, not to "/orders".
  return !all.some((other) => other !== href && other.startsWith(href + '/') && (pathname === other || pathname.startsWith(other + '/')));
}

// One shared poller for every nav instance on the page (the sidebar and the small-screen strip).
const listeners = new Set<(counts: Counts) => void>();
let inflight: Promise<void> | null = null;
let lastLoadedAt = 0;

function refreshCounts(): Promise<void> {
  if (inflight) return inflight;
  if (Date.now() - lastLoadedAt < 3_000) return Promise.resolve();
  inflight = fetch('/api/me/counts', { cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) return;
      const counts = (await res.json()) as Counts;
      lastLoadedAt = Date.now();
      for (const listener of listeners) listener(counts);
    })
    .catch(() => undefined) // offline: keep what we have
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The sidebar. Highlights the current section and keeps the counters fresh. */
export function AppNav({ sections, initialCounts }: { sections: NavSection[]; initialCounts: Counts }) {
  const pathname = usePathname();
  const [counts, setCounts] = useState(initialCounts);
  useEffect(() => setCounts(initialCounts), [initialCounts]);

  useEffect(() => {
    listeners.add(setCounts);
    const timer = setInterval(() => void refreshCounts(), 60_000);
    return () => {
      listeners.delete(setCounts);
      clearInterval(timer);
    };
  }, []);

  // Refresh on every navigation as well.
  useEffect(() => {
    void refreshCounts();
  }, [pathname]);

  const hrefs = sections.flatMap((s) => s.items.map((i) => i.href));
  return (
    <nav aria-label="Main" className="flex flex-col gap-5">
      {sections.map((section, i) => (
        <div key={i}>
          {section.title && <p className="mb-1 px-3 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{section.title}</p>}
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active = isActive(pathname, item.href, hrefs);
              const count = item.countKey ? (counts[item.countKey] ?? 0) : 0;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cx(
                      'flex items-center justify-between rounded-md px-3 py-1.5 text-sm',
                      active ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                    )}
                  >
                    <span>{item.label}</span>
                    {count > 0 && (
                      <span className={cx('rounded-full px-1.5 text-xs font-medium tabular-nums', item.urgent ? 'bg-red-100 text-red-700' : 'bg-slate-200 text-slate-700')}>
                        {count > 99 ? '99+' : count}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

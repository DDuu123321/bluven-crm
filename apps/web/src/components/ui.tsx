// Presentational building blocks. No client-side state in here.
import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { SIDE_STATE_LABEL, STAGE_LABEL, STAGE_STEPS, stageStepIndex, type OrderStage, type SideState } from '@bluven/core/domain';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'link' | 'link-danger';
export type ButtonSize = 'sm' | 'md';

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md'): string {
  // Link-style actions sit inline with text: no box, no fixed height.
  if (variant === 'link' || variant === 'link-danger') {
    return cx('inline font-medium hover:underline disabled:cursor-not-allowed disabled:opacity-50', variant === 'link' ? 'text-brand-700' : 'text-red-600');
  }
  return cx(
    'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-50',
    size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
    variant === 'primary' && 'bg-brand-600 text-white hover:bg-brand-700',
    variant === 'secondary' && 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
    variant === 'danger' && 'border border-red-300 bg-white text-red-700 hover:bg-red-50',
    variant === 'ghost' && 'text-slate-600 hover:bg-slate-100',
  );
}

export function Button({ variant, size, className, ...props }: ComponentProps<'button'> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type="button" {...props} className={cx(buttonClass(variant, size), className)} />;
}

export function LinkButton({ variant, size, className, ...props }: ComponentProps<typeof Link> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <Link {...props} className={cx(buttonClass(variant, size), className)} />;
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

const control =
  'block w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 disabled:bg-slate-100 disabled:text-slate-500';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input {...props} className={cx(control, 'h-9', className)} />;
}

export function Textarea({ className, rows = 3, ...props }: ComponentProps<'textarea'>) {
  return <textarea rows={rows} {...props} className={cx(control, 'py-2 leading-relaxed', className)} />;
}

export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <select {...props} className={cx(control, 'h-9 pr-8', className)}>
      {children}
    </select>
  );
}

export function Checkbox({ label, className, ...props }: ComponentProps<'input'> & { label: ReactNode }) {
  return (
    <label className={cx('flex items-start gap-2 text-sm text-slate-700', className)}>
      <input type="checkbox" {...props} className="mt-0.5 size-4 rounded border-slate-300 accent-brand-600" />
      <span>{label}</span>
    </label>
  );
}

export function Label({ children, htmlFor, optional }: { children: ReactNode; htmlFor?: string; optional?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-slate-600">
      {children}
      {optional && <span className="ml-1 font-normal text-slate-400">optional</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="mb-5">
      {back && (
        <Link href={back.href} className="mb-2 inline-block text-xs text-slate-500 hover:text-slate-800">
          ← {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-sm text-slate-500">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Card({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={cx('scroll-mt-20 rounded-lg border border-slate-200 bg-white', className)}>
      {children}
    </section>
  );
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('px-4 py-4', className)}>{children}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export type Tone = 'slate' | 'blue' | 'green' | 'amber' | 'red' | 'violet';

const toneClass: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
};

export function Badge({ tone = 'slate', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', toneClass[tone])}>
      {children}
    </span>
  );
}

export function Alert({ tone = 'blue', title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div role={tone === 'red' ? 'alert' : 'status'} className={cx('rounded-md px-3 py-2.5 text-sm ring-1 ring-inset', toneClass[tone])}>
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={cx(title ? 'mt-0.5' : '')}>{children}</div>}
    </div>
  );
}

const STAGE_TONE: Record<OrderStage, Tone> = {
  NEW: 'blue',
  CONTACTED: 'blue',
  QUOTED: 'violet',
  SIGNED: 'violet',
  DEPOSIT_PENDING: 'amber',
  DEPOSIT_CONFIRMED: 'green',
  PUSHED: 'amber',
  RETURNED: 'red',
  HANDED_OVER: 'green',
};

export function StageBadge({ stage, sideState }: { stage: OrderStage; sideState?: SideState }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={STAGE_TONE[stage]}>{STAGE_LABEL[stage]}</Badge>
      {sideState && sideState !== 'NONE' && <Badge tone={sideState === 'ON_HOLD' ? 'amber' : 'red'}>{SIDE_STATE_LABEL[sideState]}</Badge>}
    </span>
  );
}

/** The main line as a row of steps, with the current one highlighted. */
export function StageTracker({ stage }: { stage: OrderStage }) {
  const current = stageStepIndex(stage);
  return (
    <ol className="flex flex-wrap items-center gap-y-2 text-xs" aria-label="Order progress">
      {STAGE_STEPS.map((step, i) => {
        const done = i < current;
        const here = i === current;
        const label = here && stage === 'RETURNED' ? 'Returned by Ops' : step.label;
        return (
          <li key={step.key} className="flex items-center" aria-current={here ? 'step' : undefined}>
            <span
              className={cx(
                'flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium',
                here && (stage === 'RETURNED' ? 'bg-red-600 text-white' : 'bg-brand-600 text-white'),
                done && 'bg-brand-50 text-brand-700',
                !here && !done && 'bg-slate-100 text-slate-400',
              )}
            >
              <span aria-hidden className="tabular-nums opacity-70">{i + 1}</span>
              {label}
            </span>
            {i < STAGE_STEPS.length - 1 && <span aria-hidden className={cx('mx-1 h-px w-3 sm:w-5', done ? 'bg-brand-200' : 'bg-slate-200')} />}
          </li>
        );
      })}
    </ol>
  );
}

/** Label / value rows. Empty values render as a dash. */
export function Dl({ rows, className }: { rows: [label: ReactNode, value: ReactNode][]; className?: string }) {
  return (
    <dl className={cx('grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-sm', className)}>
      {rows.map(([label, value], i) => (
        <div key={i} className="contents">
          <dt className="text-slate-500">{label}</dt>
          <dd className="min-w-0 break-words text-slate-900">{value === null || value === undefined || value === '' ? <span className="text-slate-300">—</span> : value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Stat({ label, value, hint, href, tone }: { label: string; value: ReactNode; hint?: ReactNode; href?: string; tone?: 'warn' | 'bad' }) {
  const body = (
    <>
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={cx('mt-1 text-2xl font-semibold tabular-nums', tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : 'text-slate-900')}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </>
  );
  const cls = 'block rounded-lg border border-slate-200 bg-white px-4 py-3';
  return href ? (
    <Link href={href} className={cx(cls, 'hover:border-brand-200 hover:bg-brand-50/40')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Tabs({ tabs, current }: { tabs: { key: string; label: ReactNode; href: string; count?: number }[]; current: string }) {
  return (
    <nav className="mb-4 flex flex-wrap gap-1 border-b border-slate-200" aria-label="Sections">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          scroll={false}
          aria-current={t.key === current ? 'page' : undefined}
          className={cx(
            '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium',
            t.key === current ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800',
          )}
        >
          {t.label}
          {t.count !== undefined && t.count > 0 && <span className="rounded-full bg-slate-100 px-1.5 text-xs tabular-nums text-slate-600">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

export function Pagination({ page, pageCount, total, hrefFor }: { page: number; pageCount: number; total: number; hrefFor: (page: number) => string }) {
  if (pageCount <= 1) return <p className="px-4 py-3 text-xs text-slate-500">{total} {total === 1 ? 'result' : 'results'}</p>;
  return (
    <div className="flex items-center justify-between px-4 py-3 text-xs text-slate-500">
      <span>
        {total} results · page {page} of {pageCount}
      </span>
      <span className="flex gap-2">
        {page > 1 && (
          <LinkButton href={hrefFor(page - 1)} size="sm">
            Previous
          </LinkButton>
        )}
        {page < pageCount && (
          <LinkButton href={hrefFor(page + 1)} size="sm">
            Next
          </LinkButton>
        )}
      </span>
    </div>
  );
}

/** Table shell with consistent header and row styling. */
export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto', className)}>
      <table className="w-full min-w-max border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs font-medium text-slate-500">
            {head.map((h, i) => (
              <th key={i} scope="col" className="px-4 py-2 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className, ...props }: ComponentProps<'td'>) {
  return (
    <td {...props} className={cx('px-4 py-2.5 align-top', className)}>
      {children}
    </td>
  );
}

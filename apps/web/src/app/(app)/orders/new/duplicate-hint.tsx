'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DuplicateHint } from '@bluven/core';
import { duplicateHintAction } from '../actions';

/**
 * Watches the phone and email fields of the surrounding form and warns when the contact already
 * exists. A salesperson is only ever told that the contact is taken, never by whom or with what details.
 */
export function DuplicateWatch({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState<DuplicateHint | null>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest = 0;
    const check = () => {
      const phone = root.querySelector<HTMLInputElement>('input[name="phone"]')?.value ?? '';
      const email = root.querySelector<HTMLInputElement>('input[name="email"]')?.value ?? '';
      if (phone.replace(/\D/g, '').length < 8 && !email.includes('@')) return setHint(null);
      const ticket = ++latest;
      duplicateHintAction(phone, email).then((result) => {
        if (ticket === latest) setHint(result);
      });
    };
    const onInput = (event: Event) => {
      const name = (event.target as HTMLInputElement | null)?.name;
      if (name !== 'phone' && name !== 'email') return;
      clearTimeout(timer);
      timer = setTimeout(check, 500);
    };
    root.addEventListener('input', onInput);
    return () => {
      root.removeEventListener('input', onInput);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div ref={ref}>
      {children}
      <HintBox hint={hint} />
    </div>
  );
}

function HintBox({ hint }: { hint: DuplicateHint | null }) {
  if (!hint || hint.level === 'none') return null;
  const box = 'mt-3 rounded-md px-3 py-2.5 text-sm ring-1 ring-inset';
  if (hint.level === 'other') {
    return (
      <div role="status" className={`${box} bg-amber-50 text-amber-800 ring-amber-200`}>
        This contact already exists in the CRM and is not assigned to you. Please ask your manager before going further.
      </div>
    );
  }
  if (hint.level === 'own') {
    return (
      <div role="status" className={`${box} bg-amber-50 text-amber-800 ring-amber-200`}>
        You already have an open order for this contact:{' '}
        <Link href={`/orders/${hint.orderId}`} className="font-medium underline">
          {hint.orderNo}
        </Link>
        .
      </div>
    );
  }
  if (hint.level === 'returning') {
    return (
      <div role="status" className={`${box} bg-blue-50 text-blue-800 ring-blue-200`}>
        {hint.customerName} is a past customer of yours. Saving will add a new order under their existing record.
      </div>
    );
  }
  return (
    <div role="status" className={`${box} bg-amber-50 text-amber-800 ring-amber-200`}>
      <p className="font-medium">This contact already exists: {hint.customerName}</p>
      <ul className="mt-1 space-y-0.5">
        {hint.orders.map((o) => (
          <li key={o.id}>
            <Link href={`/orders/${o.id}`} className="font-medium underline">
              {o.orderNo}
            </Link>{' '}
            · {o.open ? 'in progress' : 'closed'} · {o.ownerName ?? 'unassigned'}
            {o.address ? ` · ${o.address}` : ''}
          </li>
        ))}
      </ul>
      <p className="mt-1">If the address matches an order in progress, saving adds this enquiry to that order instead of creating a new one.</p>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { logoutAction } from '@/app/login/actions';
import { ActionButton } from './client';

export function UserMenu({ name, roles, mailbox }: { name: string; roles: string; mailbox?: boolean }) {
  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-100 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="text-left leading-tight">
          <span className="block font-medium text-slate-800">{name}</span>
          <span className="block text-xs text-slate-500">{roles}</span>
        </span>
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-slate-200 bg-white p-1 shadow-lg">
        {mailbox && (
          <Link href="/account/email" className="block rounded px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            Mailbox
          </Link>
        )}
        <Link href="/account/password" className="block rounded px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
          Change password
        </Link>
        <ActionButton action={logoutAction} variant="ghost" className="w-full justify-start px-3 font-normal text-slate-700">
          Sign out
        </ActionButton>
      </div>
    </details>
  );
}

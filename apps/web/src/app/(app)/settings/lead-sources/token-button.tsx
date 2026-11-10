'use client';

import { useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/action-types';
import { buttonClass } from '@/components/ui';

/** Issues or rotates an intake token and shows it exactly once. */
export function TokenButton({ action, hasToken, sourceName }: { action: () => Promise<ActionResult>; hasToken: boolean; sourceName: string }) {
  const [pending, startTransition] = useTransition();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function run() {
    const question = hasToken
      ? `Issue a new token for ${sourceName}? The current token keeps working for 7 days so the sending system can switch over.`
      : `Issue a token for ${sourceName}?`;
    if (!window.confirm(question)) return;
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
      else setToken(typeof result.data?.token === 'string' ? result.data.token : null);
    });
  }

  return (
    <div>
      <button type="button" className={buttonClass('secondary', 'sm')} disabled={pending} onClick={run}>
        {pending ? 'Working…' : hasToken ? 'Rotate token' : 'Issue token'}
      </button>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
      {token && (
        <div role="status" className="mt-2 max-w-md rounded-md bg-amber-50 p-3 text-left text-xs text-amber-900 ring-1 ring-amber-200 ring-inset">
          <p className="font-medium">Copy this token now. It will not be shown again.</p>
          <code className="mt-1.5 block rounded bg-white px-2 py-1.5 font-mono text-[11px] break-all text-slate-900 ring-1 ring-amber-200 ring-inset">{token}</code>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={buttonClass('secondary', 'sm')}
              onClick={async () => {
                await navigator.clipboard.writeText(token);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => setToken(null)}>
              I have stored it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

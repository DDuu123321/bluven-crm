'use client';

import { useEffect } from 'react';

/** Shown inside the application shell when a page fails to render. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-lg font-semibold text-slate-900">Something went wrong on this page</h1>
      <p className="mt-2 text-sm text-slate-500">Nothing you entered elsewhere is lost. Try again, and if it keeps happening tell your administrator{error.digest ? ` and quote reference ${error.digest}` : ''}.</p>
      <button type="button" onClick={reset} className="mt-5 inline-flex h-9 items-center rounded-md bg-brand-600 px-3.5 text-sm font-medium text-white hover:bg-brand-700">
        Try again
      </button>
    </div>
  );
}

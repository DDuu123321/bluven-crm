import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-sm text-center">
        <p className="text-sm font-semibold text-brand-700">Not found</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">This page does not exist, or it is not yours to see</h1>
        <p className="mt-2 text-sm text-slate-500">If you followed a link to an order, it may have been reassigned to someone else.</p>
        <Link href="/" className="mt-5 inline-flex h-9 items-center rounded-md bg-brand-600 px-3.5 text-sm font-medium text-white hover:bg-brand-700">
          Back to the CRM
        </Link>
      </div>
    </main>
  );
}

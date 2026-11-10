/** Placeholder while a page loads its data. */
export default function Loading() {
  return (
    <div role="status" aria-label="Loading" className="animate-pulse space-y-4">
      <div className="h-7 w-56 rounded bg-slate-200" />
      <div className="h-4 w-96 max-w-full rounded bg-slate-200" />
      <div className="h-64 rounded-lg border border-slate-200 bg-white" />
    </div>
  );
}

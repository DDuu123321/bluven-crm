/** What every Server Action and form endpoint returns to the browser. */
export type ActionResult =
  | { ok: true; message?: string; redirectTo?: string; data?: Record<string, unknown> }
  | { ok: false; error: string; fieldErrors?: Record<string, string>; data?: Record<string, unknown> };

export type ActionFn = (formData: FormData) => Promise<ActionResult>;

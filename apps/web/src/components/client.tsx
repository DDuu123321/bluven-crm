'use client';

// Interactive pieces: forms that call Server Actions or form endpoints, dialogs and one-click actions.
import { useRouter } from 'next/navigation';
import { createContext, useContext, useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import type { ActionFn, ActionResult } from '@/lib/action-types';
import { buttonClass, cx, type ButtonSize, type ButtonVariant } from './ui';

interface FormState {
  pending: boolean;
  result: ActionResult | null;
}
const FormContext = createContext<FormState>({ pending: false, result: null });
const DialogContext = createContext<{ close: () => void } | null>(null);

const NETWORK_ERROR: ActionResult = { ok: false, error: 'Could not reach the server. Check your connection and try again.' };

async function postForm(endpoint: string, body: FormData): Promise<ActionResult> {
  const res = await fetch(endpoint, { method: 'POST', body });
  try {
    return (await res.json()) as ActionResult;
  } catch {
    return { ok: false, error: `The server answered with an error (${res.status}).` };
  }
}

export interface ActionFormProps {
  /** A Server Action taking the form data. */
  action?: ActionFn;
  /** Alternatively: a form endpoint that accepts multipart POST (used when files are attached). */
  endpoint?: string;
  children: ReactNode;
  className?: string;
  /** Keep the entered values after a successful submit. */
  keepValues?: boolean;
  /** Ask before submitting. */
  confirm?: string;
  /** Leave the enclosing dialog open after success. */
  stayOpen?: boolean;
}

/**
 * A form wired to a Server Action or a form endpoint. Shows field errors next to their fields
 * (via <FieldError>), a summary (via <FormMessage>) and disables <SubmitButton> while pending.
 * Submission is driven from onSubmit so that a failed attempt keeps what the user typed.
 */
export function ActionForm({ action, endpoint, children, className, keepValues, confirm, stayOpen }: ActionFormProps) {
  const router = useRouter();
  const dialog = useContext(DialogContext);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (confirm && !window.confirm(confirm)) return;
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const data = new FormData(form, submitter);
    startTransition(async () => {
      let next: ActionResult;
      try {
        next = endpoint ? await postForm(endpoint, data) : await action!(data);
      } catch {
        next = NETWORK_ERROR;
      }
      setResult(next);
      if (!next.ok) {
        if (next.data?.signedOut) router.push('/login');
        return;
      }
      if (!keepValues) form.reset();
      if (!stayOpen) dialog?.close();
      if (next.redirectTo) router.push(next.redirectTo);
      else if (endpoint) router.refresh();
    });
  }

  return (
    <FormContext.Provider value={{ pending, result }}>
      <form onSubmit={onSubmit} className={className} noValidate>
        {children}
      </form>
    </FormContext.Provider>
  );
}

/** Error text for one field, as reported by the server. */
export function FieldError({ name }: { name: string }) {
  const { result } = useContext(FormContext);
  const message = result && !result.ok ? result.fieldErrors?.[name] : undefined;
  if (!message) return null;
  return (
    <p className="mt-1 text-xs text-red-600" role="alert">
      {message}
    </p>
  );
}

/** Form-level outcome: the error, or the success message when there is one. */
export function FormMessage({ className }: { className?: string }) {
  const { result } = useContext(FormContext);
  if (!result) return null;
  if (!result.ok) {
    const orderId = typeof result.data?.orderId === 'string' ? result.data.orderId : null;
    return (
      <div role="alert" className={cx('rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200 ring-inset', className)}>
        {result.error}
        {orderId && (
          <a href={`/orders/${orderId}`} className="ml-1 font-medium underline">
            Open it
          </a>
        )}
      </div>
    );
  }
  if (!result.message) return null;
  return (
    <div role="status" className={cx('rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-emerald-200 ring-inset', className)}>
      {result.message}
    </div>
  );
}

/** The data of the last successful submit, for forms that show a result (for example a new token). */
export function useFormResult(): ActionResult | null {
  return useContext(FormContext).result;
}

export function SubmitButton({
  children,
  variant = 'primary',
  size,
  className,
  name,
  value,
  pendingLabel,
  disabled,
  title,
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  name?: string;
  value?: string;
  pendingLabel?: string;
  disabled?: boolean;
  title?: string;
}) {
  const { pending } = useContext(FormContext);
  return (
    <button type="submit" name={name} value={value} title={title} disabled={pending || disabled} className={cx(buttonClass(variant, size), className)}>
      {pending ? (pendingLabel ?? 'Saving…') : children}
    </button>
  );
}

/** Closes the enclosing dialog and puts the form back to the saved values, so a later reopen starts clean. */
export function CancelButton({ children = 'Cancel' }: { children?: ReactNode }) {
  const dialog = useContext(DialogContext);
  if (!dialog) return null;
  return (
    <button type="reset" className={buttonClass('ghost')} onClick={dialog.close}>
      {children}
    </button>
  );
}

/** A button that opens a dialog. The dialog body is rendered by the server and passed in as children. */
export function Modal({
  trigger,
  title,
  children,
  variant = 'secondary',
  size,
  triggerClassName,
  description,
}: {
  trigger: ReactNode;
  title: string;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  triggerClassName?: string;
  description?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  return (
    <>
      <button type="button" className={triggerClassName ?? buttonClass(variant, size)} onClick={() => ref.current?.showModal()}>
        {trigger}
      </button>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        onClick={(e) => {
          if (e.target === ref.current) ref.current?.close(); // click on the backdrop
        }}
      >
        <DialogContext.Provider value={{ close: () => ref.current?.close() }}>
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-3.5">
            <div>
              <h2 id={titleId} className="text-base font-semibold text-slate-900">
                {title}
              </h2>
              {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
            </div>
            <button type="button" aria-label="Close" className="-mr-1 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => ref.current?.close()}>
              <svg aria-hidden viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M5 5l10 10M15 5L5 15" />
              </svg>
            </button>
          </div>
          <div className="max-h-[75vh] overflow-y-auto px-5 py-4 text-left">{children}</div>
        </DialogContext.Provider>
      </dialog>
    </>
  );
}

/** One click, one Server Action. Shows the error inline if it fails. */
export function ActionButton({
  action,
  children,
  variant,
  size,
  confirm,
  className,
  title,
}: {
  action: () => Promise<ActionResult>;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  confirm?: string;
  className?: string;
  title?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        title={title}
        disabled={pending}
        className={cx(buttonClass(variant, size), className)}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          setError(null);
          startTransition(async () => {
            let result: ActionResult;
            try {
              result = await action();
            } catch {
              result = NETWORK_ERROR;
            }
            if (!result.ok) setError(result.error);
            else if (result.redirectTo) router.push(result.redirectTo);
          });
        }}
      >
        {pending ? 'Working…' : children}
      </button>
      {error && (
        <span role="alert" className="max-w-xs text-xs text-red-600">
          {error}
        </span>
      )}
    </span>
  );
}

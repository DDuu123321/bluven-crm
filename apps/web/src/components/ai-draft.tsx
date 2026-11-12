'use client';

// Asks the assistant for a draft and puts it into the subject and message fields of the form it
// sits in. The salesperson reads it, changes it and sends it themselves.
import { useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/action-types';
import { buttonClass } from './ui';

export function AiDraft({ action, replyTo, subjectId, bodyId, needsWords }: { action: (formData: FormData) => Promise<ActionResult>; replyTo?: string; subjectId: string; bodyId: string; needsWords: boolean }) {
  const [pending, startTransition] = useTransition();
  const [words, setWords] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function draft() {
    const body = document.getElementById(bodyId) as HTMLTextAreaElement | null;
    if (body?.value.trim() && !window.confirm('Replace what you have written with a draft?')) return;
    setError(null);
    setDone(false);
    startTransition(async () => {
      const data = new FormData();
      data.set('instruction', words);
      if (replyTo) data.set('replyTo', replyTo);
      let result: ActionResult;
      try {
        result = await action(data);
      } catch {
        result = { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
      }
      if (!result.ok) {
        setError(result.fieldErrors?.instruction ?? result.error);
        return;
      }
      const subject = document.getElementById(subjectId) as HTMLInputElement | null;
      if (subject && typeof result.data?.subject === 'string' && (!subject.value.trim() || !replyTo)) subject.value = result.data.subject;
      if (body && typeof result.data?.body === 'string') {
        body.value = result.data.body;
        body.focus();
      }
      setDone(true);
    });
  }

  return (
    <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-2.5">
      <label htmlFor={`${bodyId}-words`} className="mb-1 block text-xs font-medium text-slate-600">
        Draft with AI{needsWords ? ': what should the e-mail say?' : ': anything in particular to say? (optional)'}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={`${bodyId}-words`}
          value={words}
          onChange={(e) => setWords(e.target.value)}
          onKeyDown={(e) => {
            // Enter here drafts; it must not send the e-mail.
            if (e.key === 'Enter') {
              e.preventDefault();
              if (!pending) draft();
            }
          }}
          maxLength={2000}
          placeholder={needsWords ? 'For example: ask which week suits for the installation' : 'For example: the battery is $8,900 extra, valid this month'}
          className="block h-9 min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400"
        />
        <button type="button" disabled={pending} onClick={draft} className={buttonClass('secondary')}>
          {pending ? 'Writing…' : 'Write a draft'}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
      {done && !error && (
        <p role="status" className="mt-1 text-xs text-slate-500">
          Draft written by AI from the order’s record. Read it through, fill in anything in [square brackets], and change what is not right before you send it.
        </p>
      )}
    </div>
  );
}

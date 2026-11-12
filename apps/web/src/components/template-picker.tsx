'use client';

// Puts a ready-made text into the subject and message fields of the form it sits in.
import { useState } from 'react';

export interface PickableTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
}

export function TemplatePicker({ templates, subjectId, bodyId, keepSubject }: { templates: PickableTemplate[]; subjectId: string; bodyId: string; keepSubject: boolean }) {
  const [chosen, setChosen] = useState('');
  if (templates.length === 0) return null;

  function use(id: string) {
    const template = templates.find((t) => t.id === id);
    if (!template) return;
    const body = document.getElementById(bodyId) as HTMLTextAreaElement | null;
    const subject = document.getElementById(subjectId) as HTMLInputElement | null;
    if (body?.value.trim() && !window.confirm('Replace what you have written with this template?')) {
      setChosen('');
      return;
    }
    if (body) {
      body.value = template.body;
      body.focus();
    }
    // A reply stays in its conversation; a new e-mail takes the template's subject.
    if (subject && template.subject && !keepSubject) subject.value = template.subject;
    setChosen(id);
  }

  return (
    <div>
      <label htmlFor={`${bodyId}-template`} className="mb-1 block text-xs font-medium text-slate-600">
        Start from a template <span className="font-normal text-slate-400">optional</span>
      </label>
      <select
        id={`${bodyId}-template`}
        value={chosen}
        onChange={(e) => use(e.target.value)}
        className="block h-9 w-full rounded-md border border-slate-300 bg-white px-3 pr-8 text-sm text-slate-900"
      >
        <option value="">Choose a template…</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { FieldError } from '@/components/client';
import { Input, Label, Select, Textarea, cx } from '@/components/ui';

const TYPES = [
  { value: 'NOTE', label: 'Note', placeholder: 'Anything worth remembering about this customer' },
  { value: 'CALL', label: 'Call', placeholder: 'What was discussed, and what happens next' },
  { value: 'MEETING', label: 'Meeting / site visit', placeholder: 'What you saw and agreed' },
  { value: 'MESSAGE', label: 'SMS / WhatsApp', placeholder: 'What was said' },
] as const;

/** The fields of the "log activity" form. A call asks for its direction and outcome; the others do not. */
export function ActivityFields({ nowLocal }: { nowLocal: string }) {
  const [type, setType] = useState<(typeof TYPES)[number]['value']>('NOTE');
  const current = TYPES.find((t) => t.value === type)!;
  return (
    <>
      <input type="hidden" name="type" value={type} />
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kind of entry">
        {TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={type === t.value}
            onClick={() => setType(t.value)}
            className={cx(
              'rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset',
              type === t.value ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <FieldError name="type" />
      <div>
        <Label htmlFor="activity-body">{type === 'NOTE' ? 'Note' : 'What happened'}</Label>
        <Textarea id="activity-body" name="body" rows={3} required placeholder={current.placeholder} />
        <FieldError name="body" />
      </div>
      {type !== 'NOTE' && (
        <div className="flex flex-wrap gap-3">
          {type === 'CALL' && (
            <>
              <div>
                <Label htmlFor="activity-direction">Direction</Label>
                <Select id="activity-direction" name="direction" defaultValue="outbound">
                  <option value="outbound">I called them</option>
                  <option value="inbound">They called me</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="activity-outcome">Result</Label>
                <Select id="activity-outcome" name="outcome" defaultValue="connected">
                  <option value="connected">Spoke with the customer</option>
                  <option value="no_answer">No answer</option>
                  <option value="voicemail">Left a voicemail</option>
                </Select>
                <FieldError name="outcome" />
              </div>
            </>
          )}
          <div>
            <Label htmlFor="activity-when">When</Label>
            <Input id="activity-when" name="occurredAt" type="datetime-local" defaultValue={nowLocal} max={nowLocal} />
            <FieldError name="occurredAt" />
          </div>
        </div>
      )}
    </>
  );
}

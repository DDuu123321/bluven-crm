import type { EmailView } from '@bluven/integrations';
import { fmtDateTime } from '@/lib/fmt';
import { Badge } from './ui';

const size = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** The correspondence of an order for people who read it but do not take part in it (operations). */
export function EmailList({ emails }: { emails: EmailView[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {emails.map((email) => {
        const incoming = email.direction === 'IN';
        const long = email.bodyText.length > 900 || email.bodyText.split('\n').length > 12;
        return (
          <li key={email.id} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="min-w-0">
                <Badge tone={incoming ? 'blue' : 'slate'}>{incoming ? 'From the customer' : 'From sales'}</Badge>
                <span className="ml-2 font-medium text-slate-900">{email.subject || '(no subject)'}</span>
              </div>
              <span className="text-xs whitespace-nowrap text-slate-500">{fmtDateTime(email.sentAt)}</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">{incoming ? `${email.fromName || email.fromAddress}` : `${email.sentByName ?? email.fromName ?? email.fromAddress} to ${email.to.join(', ')}`}</p>
            {long ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-sm text-slate-800">
                  <span className="whitespace-pre-wrap">{email.bodyText.split('\n').slice(0, 5).join('\n').slice(0, 500)}</span>
                  <span className="ml-1 text-brand-700">… show the whole message</span>
                </summary>
                <p className="mt-2 text-sm whitespace-pre-wrap text-slate-800">{email.bodyText}</p>
              </details>
            ) : (
              <p className="mt-2 text-sm whitespace-pre-wrap text-slate-800">{email.bodyText}</p>
            )}
            {email.attachments.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-2 text-sm">
                {email.attachments.map((a) => (
                  <li key={a.id} className="rounded-md border border-slate-200 px-2 py-1">
                    {a.available ? (
                      <a href={`/api/mail/attachments/${a.id}`} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                        {a.fileName}
                      </a>
                    ) : a.documentId ? (
                      <a href={`/api/documents/${a.documentId}`} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                        {a.fileName}
                      </a>
                    ) : (
                      <span className="text-slate-600">{a.fileName}</span>
                    )}
                    <span className="ml-1 text-xs text-slate-400">{size(a.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

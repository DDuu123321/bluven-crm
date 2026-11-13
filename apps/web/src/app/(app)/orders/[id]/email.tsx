import Link from 'next/link';
import { CURRENT_DOCUMENT, fullName, replySubject, type Ctx, type OrderHeader } from '@bluven/core';
import { NO_FOLDER, assistantConfigured, getOrderMail, getOwnMailbox, templatesForOrder, zohoSettings, type EmailAttachmentView, type EmailView, type FilledTemplate } from '@bluven/integrations';
import { AiDraft } from '@/components/ai-draft';
import { ActionButton, ActionForm, CancelButton, FieldError, FormMessage, Modal, SubmitButton } from '@/components/client';
import { TemplatePicker } from '@/components/template-picker';
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, Input, Label, Select, Textarea, buttonClass } from '@/components/ui';
import { fmtDateTime, inputDate } from '@/lib/fmt';
import { addSenderAction, archiveAttachmentAction, draftReplyAction, fileAttachmentAction, placeEmailAction, sendEmailAction } from './actions';

const size = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

interface ComposeData {
  orderId: string;
  to: string;
  documents: { id: string; fileName: string; label: string; sizeBytes: number }[];
  /** Whether a draft can be asked for. */
  assistant: boolean;
  /** Ready-made texts, with this order's details filled in. */
  templates: FilledTemplate[];
}

interface Filing {
  types: { id: string; key: string; label: string }[];
  quotes: { id: string; label: string }[];
  today: string;
  canArchive: boolean;
}

/**
 * What the assistant took a received file for, put into words, and the folder to offer first.
 * A guess it was not sure of is mentioned but not pre-selected.
 */
function suggestionFor(a: EmailAttachmentView, labels: Map<string, string>, filing: Filing | null): { text: string; typeId: string | null; contract: boolean } | null {
  if (!a.suggestedKind) return null;
  if (a.suggestedKind === NO_FOLDER) return { text: 'Does not look like a document for the order', typeId: null, contract: false };
  const label = labels.get(a.suggestedKind);
  if (!label) return null;
  const sure = a.suggestedConfidence !== 'low';
  const folder = filing?.types.find((t) => t.key === a.suggestedKind);
  return { text: `${sure ? 'Looks like' : 'Might be'}: ${label}`, typeId: sure && folder ? folder.id : null, contract: a.suggestedKind === 'signed_contract' };
}

/** The form for writing to the customer. Used for a new message and, with a subject and a message to answer, for a reply. */
function Compose({ data, idPrefix, subject = '', replyTo }: { data: ComposeData; idPrefix: string; subject?: string; replyTo?: string }) {
  return (
    <ActionForm action={sendEmailAction.bind(null, data.orderId)} className="space-y-4">
      {replyTo && <input type="hidden" name="replyTo" value={replyTo} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor={`${idPrefix}-to`}>To</Label>
          <Input id={`${idPrefix}-to`} name="to" defaultValue={data.to} autoComplete="off" />
          <FieldError name="to" />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-cc`} optional>
            Copy to
          </Label>
          <Input id={`${idPrefix}-cc`} name="cc" autoComplete="off" />
          <FieldError name="cc" />
        </div>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-subject`}>Subject</Label>
        <Input id={`${idPrefix}-subject`} name="subject" defaultValue={subject} maxLength={300} />
        <FieldError name="subject" />
      </div>
      <TemplatePicker templates={data.templates} subjectId={`${idPrefix}-subject`} bodyId={`${idPrefix}-body`} keepSubject={!!replyTo} />
      {data.assistant && <AiDraft action={draftReplyAction.bind(null, data.orderId)} replyTo={replyTo} subjectId={`${idPrefix}-subject`} bodyId={`${idPrefix}-body`} needsWords={!replyTo} />}
      <div>
        <Label htmlFor={`${idPrefix}-body`}>Message</Label>
        <Textarea id={`${idPrefix}-body`} name="body" rows={10} />
        <FieldError name="body" />
      </div>
      {data.documents.length > 0 && (
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-slate-700">Attach files of this order</legend>
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2">
            {data.documents.map((d) => (
              <label key={d.id} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" name="documentIds" value={d.id} className="size-4 rounded border-slate-300" />
                <span className="min-w-0 truncate">{d.fileName}</span>
                <span className="shrink-0 text-xs text-slate-400">
                  {d.label} · {size(d.sizeBytes)}
                </span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">Attaching the file of a quote version records that version as sent to the customer.</p>
          <FieldError name="documentIds" />
        </fieldset>
      )}
      <FormMessage />
      <div className="flex justify-end gap-2">
        <CancelButton />
        <SubmitButton pendingLabel="Sending…">Send</SubmitButton>
      </div>
    </ActionForm>
  );
}

function Message({ email, compose, filing, labels }: { email: EmailView; compose: ComposeData | null; filing: Filing | null; labels: Map<string, string> }) {
  const incoming = email.direction === 'IN';
  const lines = email.bodyText.split('\n');
  const long = lines.length > 14 || email.bodyText.length > 1200;
  return (
    <li className="px-4 py-4" id={email.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <Badge tone={incoming ? 'blue' : 'slate'}>{incoming ? 'Received' : 'Sent'}</Badge>
          <span className="ml-2 font-medium text-slate-900">{email.subject || '(no subject)'}</span>
        </div>
        <span className="text-xs whitespace-nowrap text-slate-500">{fmtDateTime(email.sentAt)}</span>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {incoming ? `From ${email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress}` : `From ${email.sentByName ?? email.fromName ?? email.fromAddress} to ${email.to.join(', ')}`}
        {email.cc.length > 0 && ` · copy to ${email.cc.join(', ')}`}
        {!incoming && email.sentByName && ' · written in the CRM'}
      </p>

      {email.unknownSender && (
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
          <span>
            {email.senderAwaitsConfirmation
              ? `This came from ${email.unknownSender}. That address reached the customer’s record through a website enquiry and nobody has confirmed that it is theirs. Check before you answer or send anything to it.`
              : `This came from ${email.unknownSender}, which is not on the customer’s record. It may not be from the customer.`}
          </span>
          {filing && (
            <ActionButton action={addSenderAction.bind(null, email.id)} size="sm" confirm={`Is ${email.unknownSender} really this customer’s address? From then on mail from it is shown as the customer’s, and quotes and contracts can be sent to it.`}>
              {email.senderAwaitsConfirmation ? 'It is the customer’s address' : 'Add this address to the customer'}
            </ActionButton>
          )}
        </div>
      )}

      {long ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-slate-800">
            <span className="whitespace-pre-wrap">{lines.slice(0, 6).join('\n').slice(0, 600)}</span>
            <span className="ml-1 text-brand-700">… show the whole message</span>
          </summary>
          <p className="mt-2 text-sm whitespace-pre-wrap text-slate-800">{email.bodyText}</p>
        </details>
      ) : (
        <p className="mt-2 text-sm whitespace-pre-wrap text-slate-800">{email.bodyText || <span className="text-slate-400">(no text)</span>}</p>
      )}

      {email.attachments.length > 0 && (
        <ul className="mt-3 space-y-2">
          {email.attachments.map((a) => {
            const suggestion = incoming && !a.documentId ? suggestionFor(a, labels, filing) : null;
            return (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-slate-200 px-3 py-2 text-sm">
              {a.available ? (
                <a href={`/api/mail/attachments/${a.id}`} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">
                  {a.fileName}
                </a>
              ) : a.documentId ? (
                <a href={`/api/documents/${a.documentId}`} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">
                  {a.fileName}
                </a>
              ) : (
                <span className="font-medium text-slate-700">{a.fileName}</span>
              )}
              <span className="text-xs text-slate-400">{size(a.sizeBytes)}</span>
              {a.skippedReason && <span className="text-xs text-amber-700">{a.skippedReason}</span>}
              {a.documentLabel && <Badge tone="green">{incoming ? `Filed as ${a.documentLabel}` : a.documentLabel}</Badge>}
              {suggestion && (
                <span className="text-xs text-violet-700" title="What the assistant made of this file. It can be wrong.">
                  AI: {suggestion.text}
                  {a.suggestedNote ? ` · ${a.suggestedNote}` : ''}
                </span>
              )}
              {incoming && a.available && !a.documentId && filing && (
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  {/* The key makes the folder choice follow a suggestion that arrives after the page was first shown. */}
                  <ActionForm key={suggestion?.typeId ?? 'none'} action={fileAttachmentAction.bind(null, a.id)} className="flex items-center gap-2">
                    <Select name="typeId" aria-label={`Folder for ${a.fileName}`} defaultValue={suggestion?.typeId ?? ''} className="h-8 py-0 text-sm">
                      <option value="" disabled>
                        File under…
                      </option>
                      {filing.types.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                    <SubmitButton size="sm" variant="secondary" pendingLabel="Filing…">
                      File
                    </SubmitButton>
                    <FormMessage className="py-1 text-xs" />
                  </ActionForm>
                  {filing.canArchive && (
                    <Modal trigger="Signed contract…" title="Archive as the signed contract" size="sm" variant={suggestion?.contract ? 'primary' : 'secondary'} description={`“${a.fileName}” becomes the contract of this order.`}>
                      <ActionForm action={archiveAttachmentAction.bind(null, a.id)} className="space-y-4">
                        <div>
                          <Label htmlFor={`sc-quote-${a.id}`}>Quote version the customer signed</Label>
                          <Select id={`sc-quote-${a.id}`} name="quoteId" defaultValue={filing.quotes[0]?.id ?? ''}>
                            {filing.quotes.length === 0 && <option value="">No quote version yet</option>}
                            {filing.quotes.map((q) => (
                              <option key={q.id} value={q.id}>
                                {q.label}
                              </option>
                            ))}
                          </Select>
                          <FieldError name="quoteId" />
                        </div>
                        <div>
                          <Label htmlFor={`sc-date-${a.id}`}>Signed on</Label>
                          <Input id={`sc-date-${a.id}`} name="signedOn" type="date" defaultValue={inputDate(email.sentAt)} max={filing.today} className="max-w-48" />
                          <FieldError name="signedOn" />
                        </div>
                        <FormMessage />
                        <div className="flex justify-end gap-2">
                          <CancelButton />
                          <SubmitButton>Archive contract</SubmitButton>
                        </div>
                      </ActionForm>
                    </Modal>
                  )}
                </span>
              )}
            </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        {compose && incoming && (
          <Modal trigger="Reply" title={`Reply to ${email.fromName || email.fromAddress}`} size="sm" variant="secondary">
            <Compose data={{ ...compose, to: email.unknownSender ? compose.to : email.fromAddress }} idPrefix={`reply-${email.id}`} subject={replySubject(email.subject)} replyTo={email.id} />
          </Modal>
        )}
        {email.hasHtml && (
          <a href={`/api/mail/messages/${email.id}/html`} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
            View with original formatting
          </a>
        )}
      </div>
    </li>
  );
}

export async function EmailTab({ ctx, header, staff, editable }: { ctx: Ctx; header: OrderHeader; staff: boolean; editable: boolean }) {
  const { order } = header;
  const configured = !!zohoSettings();
  const [mail, mailbox, documents, types, quotes, contract, templates] = await Promise.all([
    getOrderMail(ctx, order.id),
    staff && configured ? getOwnMailbox(ctx) : Promise.resolve(null),
    staff ? ctx.db.document.findMany({ where: { orderId: order.id, ...CURRENT_DOCUMENT }, include: { type: { select: { label: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }) : Promise.resolve([]),
    ctx.db.documentType.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, key: true, label: true, isSystem: true } }),
    editable ? ctx.db.quote.findMany({ where: { orderId: order.id }, orderBy: { version: 'desc' }, select: { id: true, version: true, title: true } }) : Promise.resolve([]),
    editable ? ctx.db.contract.findFirst({ where: { orderId: order.id, voidedAt: null }, select: { id: true } }) : Promise.resolve(null),
    staff && configured ? templatesForOrder(ctx, order.id) : Promise.resolve([]),
  ]);
  const canSend = staff && !!mailbox && !mailbox.needsReconnect;
  const compose: ComposeData | null = canSend
    ? { orderId: order.id, to: order.customer.emails[0]?.email ?? '', documents: documents.map((d) => ({ id: d.id, fileName: d.fileName, label: d.type.label, sizeBytes: d.sizeBytes })), assistant: assistantConfigured(), templates }
    : null;
  const labels = new Map(types.map((t) => [t.key, t.label]));
  const filing: Filing | null = editable
    ? { types: types.filter((t) => !t.isSystem), quotes: quotes.map((q) => ({ id: q.id, label: `v${q.version}${q.title ? `: ${q.title}` : ''}` })), today: inputDate(new Date()), canArchive: !contract }
    : null;

  return (
    <div className="space-y-4">
      {staff && !configured && <Alert tone="slate">E-mail is not set up on this server yet. Until an administrator connects Zoho, record e-mails as notes on the Overview tab.</Alert>}
      {staff && configured && !mailbox && (
        <Alert tone="amber" title="Your mailbox is not connected">
          Connect it and your e-mail with this customer appears here by itself, and you can write to them from this page.{' '}
          <Link href="/account/email" className="font-medium underline">
            Connect your mailbox
          </Link>
        </Alert>
      )}
      {staff && mailbox?.needsReconnect && (
        <Alert tone="red" title="Your mailbox has to be connected again">
          New e-mails are not arriving here.{' '}
          <Link href="/account/email" className="font-medium underline">
            Connect it again
          </Link>
        </Alert>
      )}

      {mail.unplaced.length > 0 && (
        <Card>
          <CardHeader title="Not on an order yet" description={`${fullName(order.customer)} has more than one open order, so these could not be placed automatically. Put them where they belong.`} />
          <ul className="divide-y divide-slate-100">
            {mail.unplaced.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <Badge tone={m.direction === 'IN' ? 'blue' : 'slate'}>{m.direction === 'IN' ? 'Received' : 'Sent'}</Badge>
                  <span className="ml-2 font-medium text-slate-900">{m.subject || '(no subject)'}</span>
                  <span className="ml-2 text-xs text-slate-500">{fmtDateTime(m.sentAt)}</span>
                  <p className="mt-1 line-clamp-2 text-slate-600">{m.bodyText.slice(0, 300)}</p>
                </div>
                <ActionButton action={placeEmailAction.bind(null, order.id, m.id)} size="sm">
                  It is about this order
                </ActionButton>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Email with the customer"
          description="Read from the salesperson’s own mailbox. Only mail to or from this customer is kept."
          actions={
            compose ? (
              <Modal trigger="Write an email" title={`Write to ${fullName(order.customer)}`} variant="primary" description={`Sent from ${mailbox!.address}. It also appears in your own sent folder.`}>
                <Compose data={compose} idPrefix="new-mail" />
              </Modal>
            ) : staff && configured ? (
              <Link href="/account/email" className={buttonClass('secondary')}>
                Connect your mailbox
              </Link>
            ) : null
          }
        />
        {mail.emails.length === 0 ? (
          <EmptyState title="No email yet">{configured ? 'Messages to and from this customer appear here within a minute or two of being sent or received.' : 'Nothing has been recorded.'}</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {mail.emails.map((m) => (
              <Message key={m.id} email={m} compose={compose} filing={filing} labels={labels} />
            ))}
          </ul>
        )}
      </Card>
      {staff && mail.emails.length > 0 && <CardBody className="px-0 py-0 text-xs text-slate-500">Operations see this correspondence once the order has been pushed to them. Finance does not.</CardBody>}
    </div>
  );
}

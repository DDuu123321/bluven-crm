// What the assistant wrote or read, shown the same way wherever it appears. Everything here is
// labelled as the assistant's work, so nobody takes it for something a colleague checked.
import { formatCents, formatDateOnly } from '@bluven/core/domain';
import { HINT_LABEL, type BillReadingView, type HandoffBrief, type OrderBills, type OrderSummaryView } from '@bluven/integrations';
import { ActionButton, ActionForm, FormMessage, SubmitButton } from '@/components/client';
import { Badge, Card, CardBody, CardHeader, Dl } from '@/components/ui';
import { fmtDateTime } from '@/lib/fmt';
import type { ActionResult } from '@/lib/action-types';

type Action = () => Promise<ActionResult>;

function Items({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-medium text-slate-500">{title}</h3>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-800">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** The small print under anything the assistant produced. */
export function AssistantNote({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-slate-500">{children}</p>;
}

/**
 * The summary of an order. `write` is the action that writes it (again); without it the card is
 * read-only. `hintAction` takes or dismisses a suggested property detail.
 */
export function SummaryCard({ summary, available, write, hintAction }: { summary: OrderSummaryView | null; available: boolean; write?: Action; hintAction?: (formData: FormData) => Promise<ActionResult> }) {
  if (!summary && (!available || !write)) return null;
  return (
    <Card id="summary">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Summary <Badge tone="violet">Written by AI</Badge>
            {summary?.outOfDate && <Badge tone="amber">Not up to date</Badge>}
          </span>
        }
        actions={
          available &&
          write && (
            <ActionButton action={write} size="sm">
              {summary ? 'Write again' : 'Write a summary'}
            </ActionButton>
          )
        }
      />
      {!summary ? (
        <CardBody>
          <p className="text-sm text-slate-500">No summary yet. The assistant writes one from everything on record: the enquiry, the timeline, the e-mails, the quote and the bill. It takes about half a minute.</p>
        </CardBody>
      ) : (
        <CardBody className="space-y-3">
          <p className="text-sm font-medium text-slate-900">{summary.content.headline}</p>
          {summary.content.situation && <p className="text-sm text-slate-800">{summary.content.situation}</p>}
          {summary.content.nextStep && (
            <p className="rounded-md bg-brand-50 px-3 py-2 text-sm text-slate-900 ring-1 ring-brand-200 ring-inset">
              <span className="font-medium">Next: </span>
              {summary.content.nextStep}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Items title="What the customer wants" items={summary.content.wants} />
            <Items title="Concerns and open questions" items={summary.content.concerns} />
          </div>
          <Items title="What we promised" items={summary.content.promises} />
          {summary.content.facts.length > 0 && (
            <div>
              <h3 className="mb-1 text-xs font-medium text-slate-500">Worth knowing</h3>
              <Dl
                rows={summary.content.facts.map((f) => [
                  f.label,
                  <span key={f.label}>
                    {f.value} <span className="text-xs text-slate-400">· {f.source}</span>
                  </span>,
                ])}
              />
            </div>
          )}
          {hintAction && summary.hints.length > 0 && (
            <div className="rounded-md border border-dashed border-slate-300 px-3 py-2">
              <h3 className="text-xs font-medium text-slate-500">The property record is missing these. Take them over?</h3>
              <ul className="mt-1.5 space-y-1.5">
                {summary.hints.map((h) => (
                  <li key={`${h.field}=${h.value}`}>
                    <ActionForm action={hintAction} className="flex flex-wrap items-center gap-2 text-sm">
                      <input type="hidden" name="field" value={h.field} />
                      <input type="hidden" name="value" value={h.value} />
                      <span className="text-slate-800">
                        {HINT_LABEL[h.field]}: <span className="font-medium">{h.value}</span> <span className="text-xs text-slate-400">· {h.source}</span>
                      </span>
                      <SubmitButton size="sm" variant="secondary" name="intent" value="use" pendingLabel="…">
                        Use
                      </SubmitButton>
                      <SubmitButton size="sm" variant="ghost" name="intent" value="dismiss" pendingLabel="…">
                        Dismiss
                      </SubmitButton>
                      <FormMessage className="py-1 text-xs" />
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <AssistantNote>
            Written {fmtDateTime(summary.generatedAt)} {summary.generatedByName ? `at ${summary.generatedByName}’s request` : 'automatically, after the customer wrote'}, from what was on record then.
            {summary.outOfDate ? ' Something has been added since.' : ''} It can be wrong: check the timeline before relying on a detail.
          </AssistantNote>
        </CardBody>
      )}
    </Card>
  );
}

/** The brief for operations, section by section. */
export function BriefSections({ brief }: { brief: HandoffBrief }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-900">{brief.overview}</p>
      <Items title="What is to be installed" items={brief.system} />
      <Items title="The site" items={brief.site} />
      <Items title="The customer" items={brief.customer} />
      <Items title="Promised by sales" items={brief.promises} />
      {brief.open.length > 0 && (
        <div className="rounded-md bg-amber-50 px-3 py-2 ring-1 ring-amber-200 ring-inset">
          <Items title="To check before booking" items={brief.open} />
        </div>
      )}
    </div>
  );
}

/** The brief of one submission with its small print, or what to expect while there is none yet. */
export function BriefCard({ brief, writtenAt, available, automatic, write }: { brief: HandoffBrief | null; writtenAt: Date | null; available: boolean; automatic: boolean; write?: Action }) {
  if (!brief && !available) return null;
  return (
    <Card id="brief">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Brief for operations <Badge tone="violet">Written by AI</Badge>
          </span>
        }
        actions={
          available &&
          write && (
            <ActionButton action={write} size="sm">
              {brief ? 'Write again' : 'Write it now'}
            </ActionButton>
          )
        }
      />
      <CardBody className="space-y-3">
        {brief ? (
          <>
            <BriefSections brief={brief} />
            <AssistantNote>Written {fmtDateTime(writtenAt)} from the order as it was pushed. It can be wrong or incomplete: the documents and the timeline are the record.</AssistantNote>
          </>
        ) : (
          <p className="text-sm text-slate-500">{automatic ? 'The brief is being written. It appears here within a minute or two of the push.' : 'No brief has been written for this submission.'}</p>
        )}
      </CardBody>
    </Card>
  );
}

function BillFacts({ r }: { r: BillReadingView }) {
  return (
    <Dl
      rows={[
        ['Retailer', r.retailer],
        ['NMI', r.nmi],
        ['Period', r.periodFrom && r.periodTo ? `${formatDateOnly(r.periodFrom)} to ${formatDateOnly(r.periodTo)}` : null],
        ['Usage', r.usageKwh !== null ? `${r.usageKwh} kWh${r.dailyKwh !== null ? ` · ${r.dailyKwh} kWh a day` : ''}` : r.dailyKwh !== null ? `${r.dailyKwh} kWh a day` : null],
        ['Amount', r.amountCents !== null ? formatCents(r.amountCents) : null],
        ['Tariff', r.tariff],
        ...(r.exportKwh !== null ? [['Solar export', `${r.exportKwh} kWh (they already have solar)`] as [string, string]] : []),
        ...(r.accountHolder ? [['Account holder', r.accountHolder] as [string, string]] : []),
        ...(r.notes ? [['Notes', r.notes] as [string, string]] : []),
      ]}
    />
  );
}

/**
 * What was read from the order's electricity bills. `read` reads a bill (again) and `takeValue`
 * puts the bill's meter number or retailer into the property; without them the card is read-only.
 */
export function BillsCard({ bills, available, read, takeValue }: { bills: OrderBills; available: boolean; read?: (documentId: string) => Action; takeValue?: (readingId: string, field: 'nmi' | 'retailer') => Action }) {
  if (bills.readings.length === 0 && (bills.unread.length === 0 || !available)) return null;
  return (
    <Card id="bills">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Electricity bill <Badge tone="violet">Read by AI</Badge>
          </span>
        }
      />
      <ul className="divide-y divide-slate-100">
        {bills.readings.map((r) => (
          <li key={r.id} className="space-y-2 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <a href={`/api/documents/${r.documentId}`} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">
                {r.fileName}
              </a>
              {available && read && (
                <ActionButton action={read(r.documentId)} size="sm" variant="ghost">
                  Read again
                </ActionButton>
              )}
            </div>
            {!r.isBill ? (
              <p className="text-sm text-amber-800">{r.notes || 'This does not look like an electricity bill.'}</p>
            ) : (
              <>
                <BillFacts r={r} />
                {r.addressMatch === 'no' && (
                  <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200 ring-inset">
                    The bill is for {r.supplyAddress}, which is not the address of this order. Nothing was taken over from it.
                  </p>
                )}
                {r.filled.length > 0 && <p className="text-xs text-slate-500">Filled in on the property from this bill: {r.filled.map((f) => (f === 'nmi' ? 'NMI' : f)).join(', ')}.</p>}
                {(['nmi', 'retailer'] as const).map(
                  (field) =>
                    r.differs[field] && (
                      <div key={field} className="flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
                        <span>
                          The property has another {field === 'nmi' ? 'NMI' : 'retailer'} than this bill ({r[field]}).
                        </span>
                        {takeValue && (
                          <ActionButton action={takeValue(r.id, field)} size="sm">
                            Use the bill’s
                          </ActionButton>
                        )}
                      </div>
                    ),
                )}
              </>
            )}
          </li>
        ))}
        {available &&
          bills.unread.map((u) => (
            <li key={u.documentId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <span className="text-slate-700">
                {u.fileName} <span className="text-xs text-slate-400">· {u.readable ? 'not read yet' : 'only PDFs and pictures can be read'}</span>
              </span>
              {u.readable && read && (
                <ActionButton action={read(u.documentId)} size="sm">
                  Read now
                </ActionButton>
              )}
            </li>
          ))}
      </ul>
      <CardBody className="border-t border-slate-100 py-2">
        <AssistantNote>Read from the file by the assistant. Check the bill itself before using a number in a design.</AssistantNote>
      </CardBody>
    </Card>
  );
}

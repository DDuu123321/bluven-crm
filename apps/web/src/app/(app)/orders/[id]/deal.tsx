import {
  DEPOSIT_METHOD_LABEL,
  centsToInput,
  formatAddress,
  formatCents,
  formatDateOnly,
  formatKw,
  formatKwh,
  fullName,
  getConfig,
  getOrderDeal,
  unitsToKiloInput,
  type Ctx,
  type OrderHeader,
} from '@bluven/core';
import { ActionButton, ActionForm, CancelButton, FieldError, FormMessage, Modal, SubmitButton } from '@/components/client';
import { Alert, Badge, Card, CardBody, CardHeader, Dl, EmptyState, Input, Label, Select, Table, Td, Textarea, buttonClass, cx } from '@/components/ui';
import { fmtDate, fmtDateTime, inputDate, inputDateTime } from '@/lib/fmt';
import { pylonDesignLink } from '@/lib/pylon-link';
import { acceptQuoteAction, deleteQuoteAction, linkPylonAction, refreshPylonAction, unlinkPylonAction, updateQuoteAction, voidContractAction, withdrawDepositAction } from './actions';

const fileInput =
  'block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50';

type Deal = Awaited<ReturnType<typeof getOrderDeal>>;
type Quote = Deal['quotes'][number];

/** A version the customer has seen is history: its figures and its file stay as they are. */
const gone = (q: Quote): boolean => !!q.sentAt || q.isAccepted;

function QuoteFields({ q, idPrefix }: { q?: Quote; idPrefix: string }) {
  return (
    <>
      <div>
        <Label htmlFor={`${idPrefix}-title`} optional>
          Short description
        </Label>
        <Input id={`${idPrefix}-title`} name="title" defaultValue={q?.title} maxLength={200} placeholder="6.6 kW solar with 13.5 kWh battery" />
        <FieldError name="title" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`${idPrefix}-kw`}>Solar size (kW)</Label>
          <Input id={`${idPrefix}-kw`} name="systemKw" inputMode="decimal" defaultValue={unitsToKiloInput(q?.dcWatts)} />
          <FieldError name="systemKw" />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-kwh`} optional>
            Battery (kWh)
          </Label>
          <Input id={`${idPrefix}-kwh`} name="batteryKwh" inputMode="decimal" defaultValue={unitsToKiloInput(q?.storageWh)} />
          <FieldError name="batteryKwh" />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-total`}>Total price ($, including GST)</Label>
          <Input id={`${idPrefix}-total`} name="total" inputMode="decimal" defaultValue={centsToInput(q?.totalCents)} required />
          <FieldError name="total" />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-deposit`} optional>
            Deposit ($)
          </Label>
          <Input id={`${idPrefix}-deposit`} name="deposit" inputMode="decimal" defaultValue={centsToInput(q?.depositCents)} />
          <FieldError name="deposit" />
        </div>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-notes`} optional>
          Notes
        </Label>
        <Textarea id={`${idPrefix}-notes`} name="notes" rows={2} defaultValue={q?.notes} />
      </div>
    </>
  );
}

export async function DealTab({ ctx, header, editable, staff, manager }: { ctx: Ctx; header: OrderHeader; editable: boolean; staff: boolean; manager: boolean }) {
  const { order } = header;
  const { quotes, contract, deposits, defaultDepositPercent } = await getOrderDeal(ctx, order.id);
  const api = `/api/orders/${order.id}`;
  const now = new Date();
  const accepted = quotes.find((q) => q.isAccepted);
  const openDeposit = deposits.find((d) => d.status === 'PENDING' || d.status === 'CONFIRMED');
  const pastDeposits = deposits.filter((d) => d.status === 'REJECTED' || d.status === 'WITHDRAWN');
  // The version the deposit is for: the accepted one, or the only one. With several and none chosen yet, nothing is suggested.
  const paidFor = accepted ?? (quotes.length === 1 ? quotes[0] : undefined);
  const suggestedDeposit = paidFor?.depositCents ?? (paidFor?.totalCents ? Math.round((paidFor.totalCents * defaultDepositPercent) / 100) : null);
  const address = formatAddress(order.property);
  const pylonConnected = !!getConfig().pylon.apiToken;
  const pylonLink = address
    ? pylonDesignLink({ address, customerName: fullName(order.customer), email: order.customer.emails[0]?.email, phone: order.customer.phones[0]?.raw, orderNo: order.orderNo })
    : null;

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------------ quotes */}
      <Card>
        <CardHeader
          title="Proposals"
          description="Each version is kept. The first one starts the design stage; sending one to the customer makes the order “Proposal sent”."
          actions={
            <>
              {manager && order.pylonProjectId && (
                <ActionButton
                  action={unlinkPylonAction.bind(null, order.id)}
                  variant="link"
                  confirm="Unlink this order from its project in Pylon? Do this only when the project was replaced in Pylon: the next project that carries this order number as its reference will be linked instead."
                >
                  Unlink from Pylon
                </ActionButton>
              )}
              {editable && pylonConnected && order.pylonProjectId && (
                <ActionButton action={refreshPylonAction.bind(null, order.id)} variant="link" title={order.pylonSyncedAt ? `Last read from Pylon ${fmtDateTime(order.pylonSyncedAt)}` : 'Not read from Pylon yet'}>
                  Refresh from Pylon
                </ActionButton>
              )}
              {editable && pylonConnected && !order.pylonProjectId && (
                <Modal
                  trigger="Link Pylon project"
                  title="Link a project that already exists in Pylon"
                  variant="link"
                  description="For a project that was started in Pylon without this order number as its reference. Open the project in Pylon and copy its address from the browser."
                >
                  <ActionForm action={linkPylonAction.bind(null, order.id)} className="space-y-4" keepValues stayOpen>
                    <div>
                      <Label htmlFor="pylon-ref">Address of the project in Pylon</Label>
                      <Input id="pylon-ref" name="ref" placeholder="https://app.getpylon.com/library/…" autoComplete="off" />
                      <FieldError name="ref" />
                      <p className="mt-1 text-xs text-slate-500">Its designs become quote versions here, and what the customer signs or pays in Pylon will reach this order.</p>
                    </div>
                    <FormMessage />
                    <div className="flex justify-end gap-2">
                      <CancelButton>Close</CancelButton>
                      <SubmitButton name="intent" value="check" variant="secondary" pendingLabel="Checking…">
                        Check
                      </SubmitButton>
                      <SubmitButton name="intent" value="link" pendingLabel="Linking…">
                        Link project
                      </SubmitButton>
                    </div>
                  </ActionForm>
                </Modal>
              )}
              {order.pylonProjectUrl ? (
                <a href={order.pylonProjectUrl} target="_blank" rel="noreferrer" className={buttonClass('secondary')}>
                  Open in Pylon
                </a>
              ) : pylonLink ? (
                <a href={pylonLink} target="_blank" rel="noreferrer" className={buttonClass('secondary')} title={`Opens Pylon at this address with reference ${order.orderNo}`}>
                  Design in Pylon
                </a>
              ) : (
                <span className="text-xs text-slate-400">Add the address to design in Pylon</span>
              )}
              {editable && (
                <Modal trigger="Add quote version" title="Add a quote version" variant="primary" description="Enter the figures from the Pylon proposal and attach the file you send to the customer. Check that the terms and conditions are in it before it goes out.">
                  <ActionForm endpoint={`${api}/quotes`} className="space-y-4">
                    <QuoteFields idPrefix="new-quote" />
                    <div>
                      <Label htmlFor="new-quote-file" optional>
                        Quote file (PDF)
                      </Label>
                      <input id="new-quote-file" name="file" type="file" accept=".pdf,image/*" className={fileInput} />
                    </div>
                    <FormMessage />
                    <div className="flex justify-end gap-2">
                      <CancelButton />
                      <SubmitButton>Add version</SubmitButton>
                    </div>
                  </ActionForm>
                </Modal>
              )}
            </>
          }
        />
        {quotes.length === 0 ? (
          <EmptyState title="No proposal yet">Design the system in Pylon, then record the version you send to the customer here.</EmptyState>
        ) : (
          <Table head={['Version', 'System', 'Total', 'Deposit', 'File', 'Status', '']}>
            {quotes.map((q) => (
              <tr key={q.id}>
                <Td>
                  <span className="font-medium text-slate-900">v{q.version}</span>
                  {q.title && <div className="max-w-48 text-xs text-slate-500">{q.title}</div>}
                  <div className="text-xs text-slate-400">{q.pylonDesignId ? 'from Pylon' : `by ${q.createdBy?.name ?? 'unknown'}`} · {fmtDate(q.createdAt)}</div>
                </Td>
                <Td className="text-slate-700">
                  {[formatKw(q.dcWatts), q.storageWh ? `${formatKwh(q.storageWh)} battery` : ''].filter(Boolean).join(' + ') || <span className="text-slate-300">—</span>}
                </Td>
                <Td className="tabular-nums text-slate-900">{formatCents(q.totalCents, q.currency) || <span className="text-slate-300">—</span>}</Td>
                <Td className="tabular-nums text-slate-700">{formatCents(q.depositCents, q.currency) || <span className="text-slate-300">—</span>}</Td>
                <Td>
                  {q.document ? (
                    <a href={`/api/documents/${q.document.id}`} target="_blank" rel="noreferrer" className="block max-w-40 truncate text-brand-700 hover:underline" title={q.document.fileName}>
                      {q.document.fileName}
                    </a>
                  ) : q.webProposalUrl ? (
                    <a href={q.webProposalUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                      Web proposal
                    </a>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {q.isAccepted && <Badge tone="green">Accepted by customer</Badge>}
                    {q.sentAt ? <Badge tone="violet" title={fmtDateTime(q.sentAt)}>Sent {fmtDate(q.sentAt)}</Badge> : <Badge>Not sent</Badge>}
                  </div>
                </Td>
                <Td className="text-right">
                  {editable && (
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {!q.isAccepted && (
                        <ActionButton
                          action={acceptQuoteAction.bind(null, q.id)}
                          confirm={`Mark v${q.version} as the version the customer is going ahead with? It is the one operations will work from, and it can no longer be edited.`}
                          size="sm"
                          variant={accepted ? 'ghost' : 'secondary'}
                        >
                          Customer accepted
                        </ActionButton>
                      )}
                      {!q.sentAt && !q.isAccepted && (
                      <Modal trigger="Mark as sent" title={`Quote v${q.version} was sent to the customer`} size="sm" variant="primary" description="This moves the order to Proposal sent.">
                        <ActionForm endpoint={`/api/quotes/${q.id}/sent`} className="space-y-4">
                          <div>
                            <Label htmlFor={`sent-${q.id}`}>When was it sent?</Label>
                            <Input id={`sent-${q.id}`} name="sentAt" type="datetime-local" defaultValue={inputDateTime(now)} max={inputDateTime(now)} className="max-w-60" />
                            <input type="hidden" name="sentAtDefault" value={inputDateTime(now)} />
                          </div>
                          <div>
                            <Label htmlFor={`sent-file-${q.id}`} optional>
                              {q.document ? 'Replace the file with what you actually sent' : 'The file you sent'}
                            </Label>
                            <input id={`sent-file-${q.id}`} name="file" type="file" accept=".pdf,image/*" className={fileInput} />
                            <p className="mt-1 text-xs text-slate-500">For example the quote pages cut from the Pylon proposal.</p>
                          </div>
                          <FormMessage />
                          <div className="flex justify-end gap-2">
                            <CancelButton />
                            <SubmitButton>Mark as sent</SubmitButton>
                          </div>
                        </ActionForm>
                      </Modal>
                      )}
                      {(gone(q) ? !q.document : true) && (
                      <Modal
                        trigger={q.document ? 'Replace file' : 'Attach file'}
                        title={`The file of quote v${q.version}`}
                        size="sm"
                        description={
                          gone(q)
                            ? 'The proposal as it went to the customer. Operations get it with the order.'
                            : 'The PDF you will send to the customer, for example the quote pages cut from the Pylon proposal. Attach it to an e-mail from the Email tab and the version is recorded as sent when the e-mail goes out.'
                        }
                      >
                        <ActionForm endpoint={`/api/quotes/${q.id}/file`} className="space-y-4">
                          <div>
                            <Label htmlFor={`file-${q.id}`}>Quote file (PDF)</Label>
                            <input id={`file-${q.id}`} name="file" type="file" accept=".pdf,image/*" required className={fileInput} />
                            <FieldError name="file" />
                          </div>
                          <FormMessage />
                          <div className="flex justify-end gap-2">
                            <CancelButton />
                            <SubmitButton>{q.document ? 'Replace file' : 'Attach file'}</SubmitButton>
                          </div>
                        </ActionForm>
                      </Modal>
                      )}
                      {!gone(q) && (
                        <>
                          <Modal trigger="Edit" title={`Edit quote v${q.version}`} size="sm">
                            <ActionForm action={updateQuoteAction.bind(null, q.id)} keepValues className="space-y-4">
                              <QuoteFields q={q} idPrefix={`edit-${q.id}`} />
                              <FormMessage />
                              <div className="flex justify-end gap-2">
                                <CancelButton />
                                <SubmitButton>Save</SubmitButton>
                              </div>
                            </ActionForm>
                          </Modal>
                          <ActionButton action={deleteQuoteAction.bind(null, q.id)} confirm={`Delete quote v${q.version}?`} size="sm" variant="ghost">
                            Delete
                          </ActionButton>
                        </>
                      )}
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---------------------------------------------------------------- contract */}
        <Card>
          <CardHeader
            title="Signed copy"
            description="Optional. If the customer signed something, by e-mail or on the Pylon web proposal, the signed copy is kept here. The deposit and the push to operations do not wait for it."
          />
          <CardBody className="space-y-4">
            {contract ? (
              <>
                <Dl
                  rows={[
                    ['Signed on', formatDateOnly(contract.signedOn)],
                    ['Quote version', contract.quote ? `v${contract.quote.version}` : null],
                    [
                      'File',
                      <a key="f" href={`/api/documents/${contract.document.id}`} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                        {contract.document.fileName}
                      </a>,
                    ],
                    ['Archived', `${fmtDateTime(contract.createdAt)}${contract.createdBy ? ` by ${contract.createdBy.name}` : contract.source === 'PYLON' ? ' from Pylon' : ''}`],
                  ]}
                />
                {editable && (
                  <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                    <Modal trigger="Replace" title="Replace the signed copy" size="sm" description="The current one is kept in the history and no longer counts.">
                      <ContractForm api={api} quotes={quotes} defaultQuoteId={contract.quoteId ?? quotes[0]?.id} today={inputDate(now)} replace idPrefix="replace-contract" />
                    </Modal>
                    <Modal trigger="Remove" title="Remove the signed copy" size="sm" variant="danger" description="The file stays in the history. The stage of the order does not change.">
                      <ActionForm action={voidContractAction.bind(null, contract.id)} className="space-y-4">
                        <div>
                          <Label htmlFor="void-reason">Why is it being removed?</Label>
                          <Textarea id="void-reason" name="reason" rows={2} required />
                          <FieldError name="reason" />
                        </div>
                        <FormMessage />
                        <div className="flex justify-end gap-2">
                          <CancelButton />
                          <SubmitButton variant="danger">Remove signed copy</SubmitButton>
                        </div>
                      </ActionForm>
                    </Modal>
                  </div>
                )}
              </>
            ) : !editable ? (
              <p className="text-sm text-slate-500">No signed copy has been filed.</p>
            ) : quotes.length === 0 ? (
              <p className="text-sm text-slate-500">A signed copy is filed against a quote version. There is none yet.</p>
            ) : (
              <ContractForm api={api} quotes={quotes} defaultQuoteId={quotes.find((q) => q.sentAt)?.id ?? quotes[0]!.id} today={inputDate(now)} idPrefix="contract" />
            )}
          </CardBody>
        </Card>

        {/* ----------------------------------------------------------------- deposit */}
        <Card>
          <CardHeader
            title="Deposit"
            description="When the customer has paid, record it here with the proof of payment. Operations confirm that the money has arrived when they accept the order; the balance is collected after installation."
          />
          <CardBody className="space-y-4">
            {openDeposit ? (
              <>
                <Dl
                  rows={[
                    [
                      'Status',
                      openDeposit.status === 'CONFIRMED' ? <Badge key="s" tone="green">Received</Badge> : <Badge key="s" tone="amber">Recorded, to be confirmed by operations</Badge>,
                    ],
                    ['Amount', formatCents(openDeposit.amountCents, openDeposit.currency)],
                    ['Paid by', DEPOSIT_METHOD_LABEL[openDeposit.method]],
                    ['For', accepted ? `Quote v${accepted.version}${accepted.totalCents !== null ? `, ${formatCents(accepted.totalCents, accepted.currency)}` : ''}` : null],
                    ['Recorded', `${fmtDateTime(openDeposit.submittedAt)}${openDeposit.submittedBy ? ` by ${openDeposit.submittedBy.name}` : ''}`],
                    [
                      'Proof',
                      openDeposit.proofDocument ? (
                        <a key="p" href={`/api/documents/${openDeposit.proofDocument.id}`} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                          {openDeposit.proofDocument.fileName}
                        </a>
                      ) : openDeposit.receiptUrl ? (
                        <a key="p" href={openDeposit.receiptUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                          Gateway receipt
                        </a>
                      ) : null,
                    ],
                    ...(openDeposit.note ? [['Your note', openDeposit.note] as [string, string]] : []),
                    ...(openDeposit.status === 'CONFIRMED'
                      ? ([
                          ['Confirmed', `${fmtDateTime(openDeposit.decidedAt)}${openDeposit.decidedBy ? ` by ${openDeposit.decidedBy.name}` : ''}`],
                        ] as [string, string][])
                      : []),
                  ]}
                />
                {staff && openDeposit.status === 'PENDING' && (
                  <div className="border-t border-slate-100 pt-3">
                    <ActionButton action={withdrawDepositAction.bind(null, openDeposit.id)} confirm="Withdraw this record? The order goes back to the stage before the deposit, and you can record a corrected one afterwards.">
                      Withdraw
                    </ActionButton>
                  </div>
                )}
              </>
            ) : !editable ? (
              <p className="text-sm text-slate-500">No deposit has been recorded.</p>
            ) : (
              <ActionForm endpoint={`${api}/deposit`} className="space-y-4">
                {quotes.length > 1 && (
                  <div>
                    <Label htmlFor="deposit-quote">Proposal the customer accepted</Label>
                    <Select id="deposit-quote" name="quoteId" required defaultValue={accepted?.id ?? ''}>
                      <option value="" disabled>
                        Choose a version
                      </option>
                      {quotes.map((q) => (
                        <option key={q.id} value={q.id}>
                          v{q.version} · {formatCents(q.totalCents, q.currency) || 'no price'}
                          {q.title ? ` · ${q.title}` : ''}
                        </option>
                      ))}
                    </Select>
                    <FieldError name="quoteId" />
                  </div>
                )}
                {quotes.length === 0 && <Alert tone="slate">There is no quote version on this order yet. You can record the deposit now; the proposal the customer accepted has to be on file before the order goes to operations.</Alert>}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="deposit-amount">Amount paid ($)</Label>
                    <Input id="deposit-amount" name="amount" inputMode="decimal" required defaultValue={centsToInput(suggestedDeposit)} />
                    <FieldError name="amount" />
                  </div>
                  <div>
                    <Label htmlFor="deposit-method">Paid by</Label>
                    <Select id="deposit-method" name="method" defaultValue="BANK_TRANSFER">
                      <option value="BANK_TRANSFER">{DEPOSIT_METHOD_LABEL.BANK_TRANSFER}</option>
                      <option value="FINANCE">{DEPOSIT_METHOD_LABEL.FINANCE}</option>
                    </Select>
                    <FieldError name="method" />
                  </div>
                </div>
                <div>
                  <Label htmlFor="deposit-files">Payment screenshot, receipt or finance approval</Label>
                  <input id="deposit-files" name="files" type="file" multiple required accept=".pdf,image/*" className={fileInput} />
                  <FieldError name="files" />
                </div>
                <div>
                  <Label htmlFor="deposit-note" optional>
                    Note
                  </Label>
                  <Textarea id="deposit-note" name="note" rows={2} placeholder="Payer name or reference to look for in the account" />
                </div>
                <FormMessage />
                <SubmitButton pendingLabel="Recording…">Record deposit</SubmitButton>
              </ActionForm>
            )}

            {pastDeposits.length > 0 && (
              <div className="border-t border-slate-100 pt-3">
                <p className="mb-1.5 text-xs font-medium text-slate-500">Earlier records</p>
                <ul className="space-y-1.5 text-sm">
                  {pastDeposits.map((d) => (
                    <li key={d.id} className={cx('rounded-md px-3 py-2', d.status === 'REJECTED' ? 'bg-red-50 text-red-800' : 'bg-slate-50 text-slate-600')}>
                      {formatCents(d.amountCents, d.currency)} · {d.status === 'REJECTED' ? `not accepted by ${d.decidedBy?.name ?? 'operations'}` : 'withdrawn'} on {fmtDate(d.decidedAt)}
                      {d.status === 'REJECTED' && d.decisionNote && <p className="mt-0.5 whitespace-pre-wrap">{d.decisionNote}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function ContractForm({ api, quotes, defaultQuoteId, today, replace, idPrefix }: { api: string; quotes: Quote[]; defaultQuoteId?: string; today: string; replace?: boolean; idPrefix: string }) {
  return (
    <ActionForm endpoint={`${api}/contract`} className="space-y-4">
      {replace && <input type="hidden" name="replace" value="true" />}
      <div>
        <Label htmlFor={`${idPrefix}-files`}>Signed copy</Label>
        <input id={`${idPrefix}-files`} name="files" type="file" multiple required accept=".pdf,image/*" className={fileInput} />
        <p className="mt-1 text-xs text-slate-500">A PDF, or photos of each signed page.</p>
        <FieldError name="files" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`${idPrefix}-date`}>Date signed</Label>
          <Input id={`${idPrefix}-date`} name="signedOn" type="date" required defaultValue={today} max={today} />
          <FieldError name="signedOn" />
        </div>
        <div>
          <Label htmlFor={`${idPrefix}-quote`}>Quote version signed</Label>
          <Select id={`${idPrefix}-quote`} name="quoteId" required defaultValue={defaultQuoteId}>
            {quotes.map((q) => (
              <option key={q.id} value={q.id}>
                v{q.version} · {formatCents(q.totalCents, q.currency) || 'no price'}
                {q.sentAt ? '' : ' (not marked as sent)'}
              </option>
            ))}
          </Select>
          <FieldError name="quoteId" />
        </div>
      </div>
      <FormMessage />
      <div className="flex justify-end gap-2">
        <CancelButton />
        <SubmitButton pendingLabel="Filing…">{replace ? 'Replace signed copy' : 'File signed copy'}</SubmitButton>
      </div>
    </ActionForm>
  );
}

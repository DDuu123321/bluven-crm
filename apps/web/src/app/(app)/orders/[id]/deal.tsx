import {
  DEPOSIT_METHOD_LABEL,
  centsToInput,
  formatAddress,
  formatCents,
  formatDateOnly,
  formatKw,
  formatKwh,
  fullName,
  getOrderDeal,
  unitsToKiloInput,
  type Ctx,
  type OrderHeader,
} from '@bluven/core';
import { ActionButton, ActionForm, CancelButton, FieldError, FormMessage, Modal, SubmitButton } from '@/components/client';
import { Alert, Badge, Card, CardBody, CardHeader, Dl, EmptyState, Input, Label, Select, Table, Td, Textarea, buttonClass, cx } from '@/components/ui';
import { fmtDate, fmtDateTime, inputDate, inputDateTime } from '@/lib/fmt';
import { pylonDesignLink } from '@/lib/pylon-link';
import { deleteQuoteAction, unlinkPylonAction, updateQuoteAction, voidContractAction, withdrawDepositAction } from './actions';

const fileInput =
  'block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50';

type Deal = Awaited<ReturnType<typeof getOrderDeal>>;
type Quote = Deal['quotes'][number];

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
  const suggestedDeposit = accepted?.depositCents ?? (accepted?.totalCents ? Math.round((accepted.totalCents * defaultDepositPercent) / 100) : null);
  const address = formatAddress(order.property);
  const pylonLink = address
    ? pylonDesignLink({ address, customerName: fullName(order.customer), email: order.customer.emails[0]?.email, phone: order.customer.phones[0]?.raw, orderNo: order.orderNo })
    : null;

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------------ quotes */}
      <Card>
        <CardHeader
          title="Quotes"
          description="Each version is kept. Recording a version does not change the stage; marking it as sent to the customer does."
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
                <Modal trigger="Add quote version" title="Add a quote version" variant="primary" description="Enter the figures from the Pylon proposal and attach the file you send to the customer.">
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
          <EmptyState title="No quote yet">Design the system in Pylon, then record the version you send to the customer here.</EmptyState>
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
                    {q.isAccepted && <Badge tone="green">Signed by customer</Badge>}
                    {q.sentAt ? <Badge tone="violet" title={fmtDateTime(q.sentAt)}>Sent {fmtDate(q.sentAt)}</Badge> : <Badge>Not sent</Badge>}
                  </div>
                </Td>
                <Td className="text-right">
                  {editable && !q.sentAt && !q.isAccepted && (
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Modal trigger="Mark as sent" title={`Quote v${q.version} was sent to the customer`} size="sm" variant="primary" description="This moves the order to Quoted.">
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
          <CardHeader title="Signed contract" description="However the customer signed, by email or on the Pylon web proposal, the signed copy is archived here." />
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
                    <Modal trigger="Replace contract" title="Replace the signed contract" size="sm" description="The current contract is kept in the history and no longer counts.">
                      <ContractForm api={api} quotes={quotes} defaultQuoteId={contract.quoteId ?? quotes[0]?.id} today={inputDate(now)} replace idPrefix="replace-contract" />
                    </Modal>
                    <Modal trigger="Remove" title="Remove the signed contract" size="sm" variant="danger" description="The order goes back to the stage before signing. The file stays in the history.">
                      <ActionForm action={voidContractAction.bind(null, contract.id)} className="space-y-4">
                        <div>
                          <Label htmlFor="void-reason">Why is it being removed?</Label>
                          <Textarea id="void-reason" name="reason" rows={2} required />
                          <FieldError name="reason" />
                        </div>
                        <FormMessage />
                        <div className="flex justify-end gap-2">
                          <CancelButton />
                          <SubmitButton variant="danger">Remove contract</SubmitButton>
                        </div>
                      </ActionForm>
                    </Modal>
                  </div>
                )}
              </>
            ) : !editable ? (
              <p className="text-sm text-slate-500">No contract has been archived.</p>
            ) : quotes.length === 0 ? (
              <Alert tone="slate">Add the quote the customer accepted first. The contract is archived against a quote version so operations know exactly what was sold.</Alert>
            ) : (
              <ContractForm api={api} quotes={quotes} defaultQuoteId={quotes.find((q) => q.sentAt)?.id ?? quotes[0]!.id} today={inputDate(now)} idPrefix="contract" />
            )}
          </CardBody>
        </Card>

        {/* ----------------------------------------------------------------- deposit */}
        <Card>
          <CardHeader title="Deposit" description="You submit the proof of payment; finance confirms that the money has arrived. The balance is collected by operations after installation." />
          <CardBody className="space-y-4">
            {openDeposit ? (
              <>
                <Dl
                  rows={[
                    [
                      'Status',
                      openDeposit.status === 'CONFIRMED' ? <Badge key="s" tone="green">Confirmed by finance</Badge> : <Badge key="s" tone="amber">Waiting for finance</Badge>,
                    ],
                    ['Amount', formatCents(openDeposit.amountCents, openDeposit.currency)],
                    ['Paid by', DEPOSIT_METHOD_LABEL[openDeposit.method]],
                    ['Submitted', `${fmtDateTime(openDeposit.submittedAt)}${openDeposit.submittedBy ? ` by ${openDeposit.submittedBy.name}` : ''}`],
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
                          ['Received', `${formatCents(openDeposit.receivedAmountCents, openDeposit.currency)} on ${formatDateOnly(openDeposit.receivedOn)}`],
                          ['Bank reference', openDeposit.bankReference],
                          ['Confirmed', `${fmtDateTime(openDeposit.decidedAt)}${openDeposit.decidedBy ? ` by ${openDeposit.decidedBy.name}` : ''}`],
                        ] as [string, string][])
                      : []),
                  ]}
                />
                {staff && openDeposit.status === 'PENDING' && (
                  <div className="border-t border-slate-100 pt-3">
                    <ActionButton action={withdrawDepositAction.bind(null, openDeposit.id)} confirm="Withdraw this submission? You can submit a corrected one afterwards.">
                      Withdraw submission
                    </ActionButton>
                  </div>
                )}
              </>
            ) : !editable ? (
              <p className="text-sm text-slate-500">No deposit has been recorded.</p>
            ) : !contract ? (
              <Alert tone="slate">Archive the signed contract first, then record the deposit.</Alert>
            ) : (
              <ActionForm endpoint={`${api}/deposit`} className="space-y-4">
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
                    Note for finance
                  </Label>
                  <Textarea id="deposit-note" name="note" rows={2} placeholder="Payer name or reference to look for" />
                </div>
                <FormMessage />
                <SubmitButton pendingLabel="Submitting…">Submit to finance</SubmitButton>
              </ActionForm>
            )}

            {pastDeposits.length > 0 && (
              <div className="border-t border-slate-100 pt-3">
                <p className="mb-1.5 text-xs font-medium text-slate-500">Earlier submissions</p>
                <ul className="space-y-1.5 text-sm">
                  {pastDeposits.map((d) => (
                    <li key={d.id} className={cx('rounded-md px-3 py-2', d.status === 'REJECTED' ? 'bg-red-50 text-red-800' : 'bg-slate-50 text-slate-600')}>
                      {formatCents(d.amountCents, d.currency)} · {d.status === 'REJECTED' ? `rejected by ${d.decidedBy?.name ?? 'finance'}` : 'withdrawn'} on {fmtDate(d.decidedAt)}
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
        <Label htmlFor={`${idPrefix}-files`}>Signed contract</Label>
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
        <SubmitButton pendingLabel="Archiving…">{replace ? 'Replace contract' : 'Archive contract'}</SubmitButton>
      </div>
    </ActionForm>
  );
}

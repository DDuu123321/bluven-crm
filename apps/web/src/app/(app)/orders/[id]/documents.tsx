import Link from 'next/link';
import { DOC_TYPE, formatBytes, getHandoffChecklist, getOrderDocuments, listReusableDocuments, type Ctx, type OrderHeader } from '@bluven/core';
import { ActionButton, ActionForm, CancelButton, FormMessage, Modal, SubmitButton } from '@/components/client';
import { DocTile } from '@/components/doc-tile';
import { Uploader } from '@/components/uploader';
import { Alert, Badge, Card, CardBody, CardHeader, Checkbox, Label, Select } from '@/components/ui';
import { fmtDate } from '@/lib/fmt';
import { changeDocumentTypeAction, deleteDocumentAction, reuseDocumentsAction } from './actions';

export async function DocumentsTab({ ctx, header, editable }: { ctx: Ctx; header: OrderHeader; editable: boolean }) {
  const { order } = header;
  const [{ types, documents }, reusable, checklist] = await Promise.all([
    getOrderDocuments(ctx, order.id),
    editable ? listReusableDocuments(ctx, order.id) : Promise.resolve([]),
    getHandoffChecklist(ctx.db, order.id),
  ]);
  const missing = new Set(checklist.items.filter((i) => !i.ok && i.typeId).map((i) => i.typeId));
  const movable = types.filter((t) => !t.isSystem);
  const base = `/orders/${order.id}`;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Files can be added at any stage. Items marked <Badge tone="amber">Required</Badge> must be here before the order can go to operations. Photos of the site belong to the property, so a later order at the same address can reuse them.
      </p>

      {reusable.length > 0 && (
        <Card>
          <CardHeader title="Site photos from an earlier order at this address" description="Check the dates: reuse only what still shows the site as it is today." />
          <CardBody>
            <ActionForm action={reuseDocumentsAction.bind(null, order.id)} className="space-y-3">
              <ul className="grid gap-2 sm:grid-cols-2">
                {reusable.map((d) => (
                  <li key={d.id} className="rounded-md border border-slate-200 p-2.5">
                    <Checkbox
                      name="documentId"
                      value={d.id}
                      label={
                        <>
                          <span className="font-medium text-slate-900">{d.fileName}</span>
                          <span className="block text-xs text-slate-500">
                            {d.typeLabel} · from {d.fromOrderNo} · {d.takenAt ? `taken ${fmtDate(d.takenAt)}` : `uploaded ${fmtDate(d.createdAt)}`} · {formatBytes(d.sizeBytes)}
                          </span>
                        </>
                      }
                    />
                  </li>
                ))}
              </ul>
              <FormMessage />
              <SubmitButton variant="secondary">Reuse selected</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      )}

      {types.map((type) => {
        const docs = documents.filter((d) => d.typeId === type.id);
        const viaFlow = type.key === DOC_TYPE.signedContract || type.key === DOC_TYPE.depositProof || type.key === DOC_TYPE.quote;
        if (viaFlow && docs.length === 0) return null;
        return (
          <Card key={type.id} id={`type-${type.key}`}>
            <CardHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {type.label}
                  {type.isRequiredForHandoff && (missing.has(type.id) ? <Badge tone="amber">Required · missing</Badge> : <Badge tone="green">Required · done</Badge>)}
                  <span className="text-xs font-normal text-slate-400">{type.scope === 'PROPERTY' ? 'belongs to the property' : 'belongs to this order'}</span>
                </span>
              }
              description={type.description}
            />
            <CardBody className="space-y-3">
              {docs.length > 0 && (
                <ul className="grid gap-2 md:grid-cols-2">
                  {docs.map((d) => (
                    <DocTile
                      key={d.id}
                      doc={{ id: d.id, fileName: d.fileName, mimeType: d.mimeType, sizeBytes: d.sizeBytes, hasThumb: !!d.thumbKey, createdAt: d.createdAt, takenAt: d.takenAt, uploadedBy: d.uploadedBy?.name, source: d.source, note: d.note }}
                      actions={
                        <>
                          {d.replaces && (
                            <a href={`/api/documents/${d.replaces.id}`} target="_blank" rel="noreferrer" className="font-medium text-slate-500 hover:underline" title={`${d.replaces.fileName}, added ${fmtDate(d.replaces.createdAt)}`}>
                              Previous version
                            </a>
                          )}
                          {editable && !viaFlow && (
                          <>
                            <Modal trigger="Replace" title={`Replace ${d.fileName}`} description="The new file becomes the current version. The old one is kept in the history." variant="link">
                              <Uploader endpoint={`/api${base}/documents?typeId=${type.id}&replaces=${d.id}`} multiple={false} label="Choose the new file" />
                            </Modal>
                            <Modal trigger="Move" title={`Move ${d.fileName}`} variant="link">
                              <ActionForm action={changeDocumentTypeAction.bind(null, d.id)} className="space-y-4">
                                <div>
                                  <Label htmlFor={`move-${d.id}`}>Move to</Label>
                                  <Select id={`move-${d.id}`} name="typeId" defaultValue={type.id}>
                                    {movable.map((t) => (
                                      <option key={t.id} value={t.id}>
                                        {t.label}
                                      </option>
                                    ))}
                                  </Select>
                                </div>
                                <FormMessage />
                                <div className="flex justify-end gap-2">
                                  <CancelButton />
                                  <SubmitButton>Move</SubmitButton>
                                </div>
                              </ActionForm>
                            </Modal>
                            <ActionButton action={deleteDocumentAction.bind(null, d.id)} confirm={`Delete ${d.fileName}?`} variant="link-danger">
                              Delete
                            </ActionButton>
                          </>
                          )}
                        </>
                      }
                    />
                  ))}
                </ul>
              )}
              {viaFlow ? (
                <p className="text-xs text-slate-500">
                  Managed from the{' '}
                  <Link href={`${base}?tab=deal`} className="font-medium text-brand-700 hover:underline">
                    Quote, contract &amp; deposit
                  </Link>{' '}
                  tab.
                </p>
              ) : editable ? (
                <Uploader endpoint={`/api${base}/documents?typeId=${type.id}`} compact={docs.length > 0} />
              ) : (
                docs.length === 0 && <p className="text-sm text-slate-400">No files.</p>
              )}
            </CardBody>
          </Card>
        );
      })}
      {!editable && documents.length === 0 && <Alert tone="slate">No files have been added to this order.</Alert>}
    </div>
  );
}

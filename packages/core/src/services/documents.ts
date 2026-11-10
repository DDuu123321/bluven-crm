// Documents: upload, versioning, reuse across orders on the same property, deletion and access.
import type { Readable } from 'node:stream';
import sharp from 'sharp';
import type { DocSource, Document, DocumentType, Tx } from '@bluven/db';
import { inTx, nowOf, type Ctx } from '../context';
import { getConfig } from '../config';
import { FINANCE_VISIBLE_DOC_TYPES, zonedTimeToUtc } from '../domain';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { newId } from '../ids';
import { INLINE_SAFE_TYPES, THUMBNAIL_TYPES, cleanFileName, detectContentType, getStorage, safeExtension, type TempFile } from '../storage';
import { addActivity } from './activity';
import { audit } from './audit';
import { editBlockReason, lockOrderForEdit, requireOrderView, touchStaffActivity, type OrderState } from './orders';
import { DOC_TYPE } from './reference';

/** A file received from the client and parked in temporary storage, not yet attached to anything. */
export interface StagedFile extends TempFile {
  fileName: string;
  mimeType: string;
  /** Set once the file has been moved to its final key, so a failed transaction can undo it. */
  committedKey?: string;
}

/** Receives a file into temporary storage. Always pair with attachStaged or cleanupStaged. */
export async function stageUpload(body: Readable, fileName: string, maxBytes: number = getConfig().maxUploadBytes): Promise<StagedFile> {
  const name = cleanFileName(fileName);
  const temp = await getStorage().writeTemp(body, maxBytes);
  if (temp.sizeBytes === 0) {
    await getStorage().discard(temp.tempPath);
    throw new ValidationError('The file is empty.');
  }
  return { ...temp, fileName: name, mimeType: detectContentType(name, temp.head) };
}

/** Removes whatever a staged file left on disk. Safe to call more than once. */
export async function cleanupStaged(files: StagedFile | StagedFile[]): Promise<void> {
  for (const f of Array.isArray(files) ? files : [files]) {
    await getStorage().discard(f.tempPath).catch(() => undefined);
    if (f.committedKey) await getStorage().remove(f.committedKey).catch(() => undefined);
  }
}

export interface AttachOptions {
  type: DocumentType;
  source?: DocSource;
  note?: string;
  /** The document this file is a new version of. */
  replaces?: Document | null;
}

/**
 * Creates the Document row for a staged file and moves the file to its final location.
 * Must run inside a transaction that already holds the order lock.
 */
export async function attachStaged(tx: Tx, ctx: Ctx, order: OrderState, file: StagedFile, opts: AttachOptions): Promise<Document> {
  const duplicate = await tx.document.findFirst({
    where: { orderId: order.id, typeId: opts.type.id, sha256: file.sha256, deletedAt: null, replacedBy: { is: null } },
    select: { fileName: true },
  });
  if (duplicate) throw new ConflictError(`This file has already been uploaded here as “${duplicate.fileName}”.`);

  const id = newId('doc');
  const ext = safeExtension(file.fileName);
  const storageKey = `${order.customerId}/${order.propertyId}/${order.id}/${id}${ext ? `.${ext}` : ''}`;
  const doc = await tx.document.create({
    data: {
      id,
      orderId: order.id,
      propertyId: opts.type.scope === 'PROPERTY' ? order.propertyId : null,
      typeId: opts.type.id,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      storageKey,
      sha256: file.sha256,
      source: opts.source ?? 'UPLOAD',
      note: (opts.note ?? '').trim().slice(0, 500),
      replacesId: opts.replaces?.id ?? null,
      uploadedById: ctx.actor.kind === 'user' ? ctx.actor.id : null,
      createdAt: nowOf(ctx),
    },
  });
  await addActivity(tx, ctx, {
    customerId: order.customerId,
    orderId: order.id,
    type: 'DOCUMENT',
    summary: opts.replaces ? `Replaced ${opts.type.label}: ${file.fileName}` : `Uploaded ${opts.type.label}: ${file.fileName}`,
    payload: { documentId: id, typeKey: opts.type.key, fileName: file.fileName },
  });
  await audit(tx, ctx, {
    action: opts.replaces ? 'document.replace' : 'document.upload',
    entityType: 'Document',
    entityId: id,
    orderId: order.id,
    customerId: order.customerId,
    summary: `${order.orderNo}: uploaded ${opts.type.label} “${file.fileName}”`,
    after: { type: opts.type.key, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256, replacesId: opts.replaces?.id ?? null },
  });
  // Last step: if the move fails the transaction rolls back and nothing references the file.
  await getStorage().commit(file.tempPath, storageKey);
  file.committedKey = storageKey;
  return doc;
}

/** Best-effort thumbnail and capture time for an image. Runs after the upload has been committed. */
export async function finishImage(ctx: Ctx, doc: Pick<Document, 'id' | 'storageKey' | 'mimeType'>): Promise<void> {
  if (!THUMBNAIL_TYPES.has(doc.mimeType)) return;
  try {
    const storage = getStorage();
    const source = storage.absolutePath(doc.storageKey);
    const meta = await sharp(source, { failOn: 'none' }).metadata();
    const thumb = await sharp(source, { failOn: 'none' })
      .rotate()
      .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
    const thumbKey = doc.storageKey.replace(/(\.[A-Za-z0-9]+)?$/, '') + '.thumb.webp';
    await storage.writeBuffer(thumbKey, thumb);
    await ctx.db.document.update({ where: { id: doc.id }, data: { thumbKey, takenAt: exifCaptureTime(meta.exif, nowOf(ctx)) } });
  } catch {
    // A broken image simply has no thumbnail.
  }
}

/** Earliest plausible "YYYY:MM:DD HH:MM:SS" in the EXIF block, read as business-local time. */
function exifCaptureTime(exif: Buffer | undefined, now: Date): Date | null {
  if (!exif) return null;
  let best: Date | null = null;
  for (const m of exif.toString('latin1').matchAll(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):\d{2}/g)) {
    const date = zonedTimeToUtc(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`, getConfig().timeZone);
    if (!date || date.getUTCFullYear() < 2000 || date.getTime() > now.getTime() + 86_400_000) continue;
    if (!best || date < best) best = date;
  }
  return best;
}

export interface UploadDocumentInput {
  orderId: string;
  typeId: string;
  fileName: string;
  body: Readable;
  /** Upload as a new version of this document. */
  replacesId?: string | null;
  note?: string;
}

/**
 * Uploads one file into an order's folder. Contract and deposit-proof files are not accepted
 * here: they come in through the contract and deposit flows, which create the matching record.
 */
export async function uploadDocument(ctx: Ctx, input: UploadDocumentInput): Promise<{ id: string }> {
  // Check access and state before reading the body, so a refused upload costs no bandwidth.
  const { order: preview, view } = await requireOrderView(ctx.db, ctx, input.orderId);
  if (view !== 'FULL') throw new ForbiddenError('Only the salesperson for this order or a manager can upload files.');
  const blocked = editBlockReason(preview);
  if (blocked) throw new ConflictError(blocked);
  const type = await ctx.db.documentType.findUnique({ where: { id: input.typeId } });
  if (!type || !type.isActive) throw new ValidationError('Choose a document type.');
  if (type.key === DOC_TYPE.signedContract || type.key === DOC_TYPE.depositProof) {
    throw new ValidationError(`${type.label} files are added from the ${type.key === DOC_TYPE.signedContract ? 'Contract' : 'Deposit'} section.`);
  }

  const staged = await stageUpload(input.body, input.fileName);
  let doc: Document;
  try {
    doc = await inTx(ctx.db, async (tx) => {
      const order = await lockOrderForEdit(tx, ctx, input.orderId);
      let replaces: Document | null = null;
      if (input.replacesId) {
        replaces = await tx.document.findFirst({
          where: { id: input.replacesId, orderId: order.id, typeId: type.id, deletedAt: null, replacedBy: { is: null } },
        });
        if (!replaces) throw new ValidationError('The file to replace no longer exists.');
      }
      const created = await attachStaged(tx, ctx, order, staged, { type, note: input.note, replaces });
      await touchStaffActivity(tx, ctx, order);
      return created;
    });
  } catch (e) {
    await cleanupStaged(staged);
    throw e;
  }
  await finishImage(ctx, doc);
  return { id: doc.id };
}

/** Soft-deletes a document. Files that back a contract, a deposit or a sent quote must be removed there. */
export async function deleteDocument(ctx: Ctx, input: { documentId: string }): Promise<void> {
  const found = await ctx.db.document.findUnique({ where: { id: input.documentId }, select: { orderId: true } });
  if (!found) throw new NotFoundError('Document not found.');
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForEdit(tx, ctx, found.orderId);
    const doc = await tx.document.findUnique({
      where: { id: input.documentId },
      include: { type: true, contract: true, deposit: true, quote: true },
    });
    if (!doc || doc.deletedAt) throw new NotFoundError('Document not found.');
    if (doc.contract && !doc.contract.voidedAt) throw new ConflictError('This file is the archived contract. Remove the contract instead.');
    if (doc.deposit && (doc.deposit.status === 'PENDING' || doc.deposit.status === 'CONFIRMED')) {
      throw new ConflictError('This file is the proof for a deposit. Withdraw the deposit first.');
    }
    if (doc.quote?.sentAt) throw new ConflictError('This file belongs to a quote that was sent to the customer.');
    await tx.document.update({
      where: { id: doc.id },
      data: { deletedAt: nowOf(ctx), deletedById: ctx.actor.kind === 'user' ? ctx.actor.id : null },
    });
    await addActivity(tx, ctx, {
      customerId: order.customerId,
      orderId: order.id,
      type: 'DOCUMENT',
      summary: `Deleted ${doc.type.label}: ${doc.fileName}`,
      payload: { documentId: doc.id, typeKey: doc.type.key, deleted: true },
    });
    await touchStaffActivity(tx, ctx, order);
    await audit(tx, ctx, {
      action: 'document.delete',
      entityType: 'Document',
      entityId: doc.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: deleted ${doc.type.label} “${doc.fileName}”`,
      before: { type: doc.type.key, fileName: doc.fileName, sha256: doc.sha256, sizeBytes: doc.sizeBytes },
    });
  });
}

/** Moves a document to another type, e.g. from "Other" to "Electricity bill". */
export async function changeDocumentType(ctx: Ctx, input: { documentId: string; typeId: string }): Promise<void> {
  const found = await ctx.db.document.findUnique({ where: { id: input.documentId }, select: { orderId: true } });
  if (!found) throw new NotFoundError('Document not found.');
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrderForEdit(tx, ctx, found.orderId);
    const doc = await tx.document.findUnique({ where: { id: input.documentId }, include: { type: true } });
    if (!doc || doc.deletedAt) throw new NotFoundError('Document not found.');
    const type = await tx.documentType.findUnique({ where: { id: input.typeId } });
    if (!type || !type.isActive) throw new ValidationError('Choose a document type.');
    if (doc.type.isSystem || type.isSystem) throw new ConflictError('Contract, deposit and quote files cannot be moved between types.');
    if (type.id === doc.typeId) return;
    await tx.document.update({
      where: { id: doc.id },
      data: { typeId: type.id, propertyId: type.scope === 'PROPERTY' ? order.propertyId : null },
    });
    await touchStaffActivity(tx, ctx, order);
    await audit(tx, ctx, {
      action: 'document.retype',
      entityType: 'Document',
      entityId: doc.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: moved “${doc.fileName}” from ${doc.type.label} to ${type.label}`,
      before: { type: doc.type.key },
      after: { type: type.key },
    });
  });
}

export interface ReusableDocument {
  id: string;
  fileName: string;
  typeLabel: string;
  typeId: string;
  mimeType: string;
  sizeBytes: number;
  takenAt: Date | null;
  createdAt: Date;
  fromOrderNo: string;
  hasThumb: boolean;
}

/** Property-level files from earlier orders on the same property that this order has not taken over yet. */
export async function listReusableDocuments(ctx: Ctx, orderId: string): Promise<ReusableDocument[]> {
  const { order, view } = await requireOrderView(ctx.db, ctx, orderId);
  if (view !== 'FULL') return [];
  const own = await ctx.db.document.findMany({ where: { orderId: order.id, deletedAt: null }, select: { sha256: true, typeId: true } });
  const have = new Set(own.map((d) => `${d.typeId}:${d.sha256}`));
  const docs = await ctx.db.document.findMany({
    where: {
      propertyId: order.propertyId,
      orderId: { not: order.id },
      deletedAt: null,
      replacedBy: { is: null },
      type: { scope: 'PROPERTY', isActive: true },
    },
    include: { type: true, order: { select: { orderNo: true } } },
    orderBy: { createdAt: 'desc' },
  });
  const seen = new Set<string>();
  const out: ReusableDocument[] = [];
  for (const d of docs) {
    const key = `${d.typeId}:${d.sha256}`;
    if (have.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: d.id,
      fileName: d.fileName,
      typeLabel: d.type.label,
      typeId: d.typeId,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
      takenAt: d.takenAt,
      createdAt: d.createdAt,
      fromOrderNo: d.order.orderNo,
      hasThumb: !!d.thumbKey,
    });
  }
  return out;
}

/** Takes over property-level files from an earlier order on the same property. No bytes are copied. */
export async function reuseDocuments(ctx: Ctx, input: { orderId: string; documentIds: string[] }): Promise<{ reused: number }> {
  if (input.documentIds.length === 0) throw new ValidationError('Select at least one file.');
  return inTx(ctx.db, async (tx) => {
    const order = await lockOrderForEdit(tx, ctx, input.orderId);
    const sources = await tx.document.findMany({
      where: {
        id: { in: input.documentIds },
        propertyId: order.propertyId,
        orderId: { not: order.id },
        deletedAt: null,
        type: { scope: 'PROPERTY' },
      },
      include: { type: true, order: { select: { orderNo: true } } },
    });
    let reused = 0;
    for (const s of sources) {
      const exists = await tx.document.findFirst({ where: { orderId: order.id, typeId: s.typeId, sha256: s.sha256, deletedAt: null }, select: { id: true } });
      if (exists) continue;
      const id = newId('doc');
      await tx.document.create({
        data: {
          id,
          orderId: order.id,
          propertyId: order.propertyId,
          typeId: s.typeId,
          fileName: s.fileName,
          mimeType: s.mimeType,
          sizeBytes: s.sizeBytes,
          storageKey: s.storageKey,
          sha256: s.sha256,
          thumbKey: s.thumbKey,
          source: 'REUSED',
          note: `Reused from ${s.order.orderNo}`,
          takenAt: s.takenAt,
          copiedFromId: s.id,
          uploadedById: ctx.actor.kind === 'user' ? ctx.actor.id : null,
          createdAt: nowOf(ctx),
        },
      });
      await audit(tx, ctx, {
        action: 'document.reuse',
        entityType: 'Document',
        entityId: id,
        orderId: order.id,
        customerId: order.customerId,
        summary: `${order.orderNo}: reused ${s.type.label} “${s.fileName}” from ${s.order.orderNo}`,
        after: { type: s.type.key, fileName: s.fileName, copiedFromId: s.id },
      });
      reused++;
    }
    if (reused > 0) {
      await addActivity(tx, ctx, {
        customerId: order.customerId,
        orderId: order.id,
        type: 'DOCUMENT',
        summary: `Reused ${reused} file${reused === 1 ? '' : 's'} from an earlier order on this property`,
      });
      await touchStaffActivity(tx, ctx, order);
    }
    return { reused };
  });
}

export interface OpenedDocument {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  thumbKey: string | null;
  /** Whether a browser may render the file in place. */
  inlineSafe: boolean;
}

/**
 * Authorises access to a document's bytes and records the access. Finance sees only
 * deposit-related files; operations sees an order's files once it has been pushed.
 */
export async function openDocument(ctx: Ctx, input: { documentId: string; purpose: 'download' | 'view' | 'thumbnail' }): Promise<OpenedDocument> {
  const doc = await ctx.db.document.findUnique({ where: { id: input.documentId }, include: { type: { select: { key: true, label: true } } } });
  if (!doc || doc.deletedAt) throw new NotFoundError('Document not found.');
  const { order, view } = await requireOrderView(ctx.db, ctx, doc.orderId).catch(() => {
    throw new NotFoundError('Document not found.');
  });
  if (view === 'FINANCE' && !FINANCE_VISIBLE_DOC_TYPES.includes(doc.type.key)) throw new NotFoundError('Document not found.');
  if (input.purpose !== 'thumbnail') {
    await audit(ctx.db, ctx, {
      action: input.purpose === 'download' ? 'document.download' : 'document.view',
      entityType: 'Document',
      entityId: doc.id,
      orderId: order.id,
      customerId: order.customerId,
      summary: `${order.orderNo}: ${input.purpose === 'download' ? 'downloaded' : 'viewed'} ${doc.type.label} “${doc.fileName}”`,
    });
  }
  return {
    id: doc.id,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    storageKey: doc.storageKey,
    thumbKey: doc.thumbKey,
    inlineSafe: INLINE_SAFE_TYPES.has(doc.mimeType),
  };
}

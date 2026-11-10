import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FileTooLargeError,
  changeDocumentType,
  deleteDocument,
  detectContentType,
  getStorage,
  listReusableDocuments,
  markLost,
  openDocument,
  pushOrder,
  reuseDocuments,
  stageUpload,
  uploadDocument,
} from '../src';
import { as, docType, pdf, png, resetDb, stream, testDb } from './helpers';
import { makeWorld, orderAt, type World } from './setup-order';

const db = testDb();
let w: World;

beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});

async function upload(orderId: string, key: string, name: string, body: Buffer, extra: { replacesId?: string } = {}) {
  return uploadDocument(as(w.sam, w.clock), { orderId, typeId: (await docType(key)).id, fileName: name, body: stream(body), ...extra });
}

describe('documents', () => {
  it('stores the file under the customer / property / order path with a thumbnail for images', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const image = await png(5);
    const { id } = await upload(orderId, 'meter_box', '../../etc/Meter Box 01.PNG', image);
    const doc = await db.document.findUniqueOrThrow({ where: { id }, include: { order: true } });
    expect(doc).toMatchObject({ fileName: 'Meter Box 01.PNG', mimeType: 'image/png', sizeBytes: image.length, source: 'UPLOAD', uploadedById: w.sam.id });
    expect(doc.storageKey).toBe(`${doc.order.customerId}/${doc.order.propertyId}/${orderId}/${id}.png`);
    expect(doc.propertyId).toBe(doc.order.propertyId); // property-scope type
    expect(readFileSync(getStorage().absolutePath(doc.storageKey)).equals(image)).toBe(true);
    expect(doc.thumbKey).toBe(`${doc.order.customerId}/${doc.order.propertyId}/${orderId}/${id}.thumb.webp`);
    expect(existsSync(getStorage().absolutePath(doc.thumbKey!))).toBe(true);
  });

  it('keeps order-level files off the property', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const { id } = await upload(orderId, 'electricity_bill', 'bill.pdf', pdf('bill'));
    const doc = await db.document.findUniqueOrThrow({ where: { id } });
    expect(doc.propertyId).toBeNull();
    expect(doc.mimeType).toBe('application/pdf');
    expect(doc.thumbKey).toBeNull();
  });

  it('rejects the same file twice in the same folder and leaves no stray files', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const body = pdf('same');
    await upload(orderId, 'electricity_bill', 'bill.pdf', body);
    await expect(upload(orderId, 'electricity_bill', 'bill-copy.pdf', body)).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('bill.pdf') });
    // The same bytes under another type are fine.
    await upload(orderId, 'other', 'bill.pdf', body);
    expect(await db.document.count({ where: { orderId } })).toBe(2);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(`${getStorage().root}/.tmp`)).toEqual([]);
  });

  it('refuses quote, contract and deposit files through the general uploader', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    for (const key of ['signed_contract', 'deposit_proof', 'quote']) {
      await expect(upload(orderId, key, 'x.pdf', pdf(key))).rejects.toMatchObject({ code: 'validation', message: expect.stringContaining('Quote, contract & deposit') });
    }
  });

  it('replaces a file with a new version and hides the old one from the checklist', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const v1 = await upload(orderId, 'electricity_bill', 'bill.pdf', pdf('v1'));
    const v2 = await upload(orderId, 'electricity_bill', 'bill-new.pdf', pdf('v2'), { replacesId: v1.id });
    const current = await db.document.findMany({ where: { orderId, deletedAt: null, replacedBy: { is: null } } });
    expect(current.map((d) => d.id)).toEqual([v2.id]);
    expect((await db.document.findUniqueOrThrow({ where: { id: v2.id } })).replacesId).toBe(v1.id);
    // The old version cannot be replaced a second time.
    await expect(upload(orderId, 'electricity_bill', 'x.pdf', pdf('v3'), { replacesId: v1.id })).rejects.toMatchObject({ code: 'validation' });
  });

  it('deletes softly and protects files that back a contract or deposit', async () => {
    const { orderId } = await orderAt(w, 'DEPOSIT_PENDING');
    const sam = as(w.sam, w.clock);
    const contract = await db.contract.findFirstOrThrow({ where: { orderId } });
    const deposit = await db.deposit.findFirstOrThrow({ where: { orderId } });
    await expect(deleteDocument(sam, { documentId: contract.documentId })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('contract') });
    await expect(deleteDocument(sam, { documentId: deposit.proofDocumentId! })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('deposit') });

    const { id } = await upload(orderId, 'other', 'notes.txt', Buffer.from('hello'));
    await deleteDocument(sam, { documentId: id });
    const doc = await db.document.findUniqueOrThrow({ where: { id } });
    expect(doc.deletedAt).not.toBeNull();
    expect(doc.deletedById).toBe(w.sam.id);
    expect(existsSync(getStorage().absolutePath(doc.storageKey))).toBe(true); // bytes are kept
    await expect(openDocument(sam, { documentId: id, purpose: 'download' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('moves a file between ordinary types', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const { id } = await upload(orderId, 'other', 'photo.png', await png(8));
    await changeDocumentType(as(w.sam, w.clock), { documentId: id, typeId: (await docType('meter_box')).id });
    const doc = await db.document.findUniqueOrThrow({ where: { id }, include: { order: true, type: true } });
    expect(doc.type.key).toBe('meter_box');
    expect(doc.propertyId).toBe(doc.order.propertyId);
    await expect(changeDocumentType(as(w.sam, w.clock), { documentId: id, typeId: (await docType('signed_contract')).id })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('controls who can open a file and records every access', async () => {
    const { orderId } = await orderAt(w, 'READY');
    const bill = await db.document.findFirstOrThrow({ where: { orderId, type: { key: 'electricity_bill' } } });
    const proof = await db.document.findFirstOrThrow({ where: { orderId, type: { key: 'deposit_proof' } } });

    expect((await openDocument(as(w.sam), { documentId: bill.id, purpose: 'view' })).inlineSafe).toBe(true);
    await expect(openDocument(as(w.alex), { documentId: bill.id, purpose: 'view' })).rejects.toMatchObject({ code: 'not_found' });
    // Finance: deposit-related files only.
    await openDocument(as(w.fin), { documentId: proof.id, purpose: 'download' });
    await expect(openDocument(as(w.fin), { documentId: bill.id, purpose: 'download' })).rejects.toMatchObject({ code: 'not_found' });
    // Operations: nothing before the push, everything after.
    await expect(openDocument(as(w.ops), { documentId: bill.id, purpose: 'view' })).rejects.toMatchObject({ code: 'not_found' });
    await pushOrder(as(w.sam, w.clock), { orderId });
    await openDocument(as(w.ops), { documentId: bill.id, purpose: 'view' });

    const log = await db.auditLog.findMany({ where: { entityId: { in: [bill.id, proof.id] }, action: { in: ['document.view', 'document.download'] } }, orderBy: { at: 'asc' } });
    expect(log.map((l) => [l.actorLabel, l.action])).toEqual([
      ['Sam Sales', 'document.view'],
      ['Fay Finance', 'document.download'],
      ['Olly Ops', 'document.view'],
    ]);
    // Thumbnails are not logged.
    await openDocument(as(w.sam), { documentId: bill.id, purpose: 'thumbnail' });
    expect(await db.auditLog.count({ where: { entityId: bill.id, action: { startsWith: 'document.' }, actorId: w.sam.id } })).toBe(2);
  });

  it('logs one viewing once, however many requests the browser makes for it', async () => {
    const { orderId } = await orderAt(w, 'READY');
    const bill = await db.document.findFirstOrThrow({ where: { orderId, type: { key: 'electricity_bill' } } });
    const sam = as(w.sam, w.clock);
    const views = () => db.auditLog.count({ where: { entityId: bill.id, action: 'document.view', actorId: w.sam.id } });
    const downloads = () => db.auditLog.count({ where: { entityId: bill.id, action: 'document.download', actorId: w.sam.id } });

    // A PDF viewer asks for the file in several pieces within seconds.
    for (let i = 0; i < 4; i++) await openDocument(sam, { documentId: bill.id, purpose: 'view' });
    expect(await views()).toBe(1);
    // Saving it is a different kind of access and is recorded as such.
    await openDocument(sam, { documentId: bill.id, purpose: 'download' });
    expect(await downloads()).toBe(1);
    // Someone else looking at the same file is their own entry.
    await openDocument(as(w.manager, w.clock), { documentId: bill.id, purpose: 'view' });
    expect(await db.auditLog.count({ where: { entityId: bill.id, action: 'document.view' } })).toBe(2);
    // Coming back later is a new viewing.
    w.clock.advanceMinutes(6);
    await openDocument(sam, { documentId: bill.id, purpose: 'view' });
    expect(await views()).toBe(2);
    // A HEAD request sends no bytes and is only an access check.
    w.clock.advanceMinutes(10);
    await openDocument(sam, { documentId: bill.id, purpose: 'head' });
    expect(await views()).toBe(2);
    await expect(openDocument(as(w.alex, w.clock), { documentId: bill.id, purpose: 'head' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports a file on somebody else\'s order exactly like one that does not exist', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const { id } = await upload(orderId, 'other', 'notes.txt', Buffer.from('hello'));
    const alex = as(w.alex, w.clock);
    const missing = await deleteDocument(alex, { documentId: 'doc_does_not_exist' }).catch((e: Error) => e.message);
    const hidden = await deleteDocument(alex, { documentId: id }).catch((e: Error) => e.message);
    expect(hidden).toBe(missing);
    const retypeHidden = await changeDocumentType(alex, { documentId: id, typeId: (await docType('meter_box')).id }).catch((e: Error) => e.message);
    expect(retypeHidden).toBe(missing);
  });

  it('will not move a file into a folder that already holds the same file', async () => {
    const { orderId } = await orderAt(w, 'ASSIGNED');
    const image = await png(21);
    await upload(orderId, 'meter_box', 'meter.png', image);
    const stray = await upload(orderId, 'other', 'meter-copy.png', image);
    await expect(changeDocumentType(as(w.sam, w.clock), { documentId: stray.id, typeId: (await docType('meter_box')).id })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('already holds this file'),
    });
  });

  it('offers site photos from an earlier order on the same property for reuse', async () => {
    const first = await orderAt(w, 'ASSIGNED');
    const sam = as(w.sam, w.clock);
    const meter = await upload(first.orderId, 'meter_box', 'meter.png', await png(21));
    await upload(first.orderId, 'install_location', 'wall.png', await png(22));
    await upload(first.orderId, 'electricity_bill', 'bill.pdf', pdf('old bill'));
    const reason = await db.lostReason.findFirstOrThrow({ where: { key: 'price' } });
    await markLost(sam, { orderId: first.orderId, reasonId: reason.id });

    // Same customer, same address, later enquiry: a second order on the same property, owned by Sam.
    const second = await orderAt(w, 'NEW');
    expect((await db.order.findUniqueOrThrow({ where: { id: second.orderId } })).ownerId).toBe(w.sam.id);

    const offered = await listReusableDocuments(sam, second.orderId);
    // Property photos are offered, the bill is not: each order needs its own.
    expect(offered.map((d) => d.fileName).sort()).toEqual(['meter.png', 'wall.png']);
    expect(await reuseDocuments(sam, { orderId: second.orderId, documentIds: offered.map((d) => d.id) })).toEqual({ reused: 2 });
    const copies = await db.document.findMany({ where: { orderId: second.orderId }, orderBy: { fileName: 'asc' } });
    expect(copies.map((d) => [d.fileName, d.source])).toEqual([['meter.png', 'REUSED'], ['wall.png', 'REUSED']]);
    const original = await db.document.findUniqueOrThrow({ where: { id: meter.id } });
    expect(copies[0]).toMatchObject({ storageKey: original.storageKey, sha256: original.sha256, copiedFromId: meter.id });
    // Nothing left to offer, and reusing again adds nothing.
    expect(await listReusableDocuments(sam, second.orderId)).toEqual([]);
    expect(await reuseDocuments(sam, { orderId: second.orderId, documentIds: [meter.id] })).toEqual({ reused: 0 });
    // A colleague cannot pull files into an order that is not theirs.
    await expect(reuseDocuments(as(w.alex, w.clock), { orderId: second.orderId, documentIds: [meter.id] })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('enforces the size limit while streaming', async () => {
    await expect(stageUpload(stream(Buffer.alloc(2048, 1)), 'big.bin', 1024)).rejects.toBeInstanceOf(FileTooLargeError);
    await expect(stageUpload(stream(Buffer.alloc(0)), 'empty.bin')).rejects.toMatchObject({ message: 'The file is empty.' });
  });

  it('decides the content type from the bytes, not the name', async () => {
    expect(detectContentType('photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectContentType('scan.pdf', pdf('x'))).toBe('application/pdf');
    // A script renamed to .pdf or .png is never served as something a browser renders.
    expect(detectContentType('evil.pdf', Buffer.from('<html><script>alert(1)</script>'))).toBe('application/octet-stream');
    expect(detectContentType('evil.png', Buffer.from('<svg onload=alert(1)>'))).toBe('application/octet-stream');
    expect(detectContentType('page.html', Buffer.from('<html>'))).toBe('application/octet-stream');
    expect(detectContentType('sheet.xlsx', Buffer.from('PK\u0003\u0004'))).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(() => getStorage().absolutePath('../outside')).toThrow();
    expect(() => getStorage().absolutePath('a/../../b')).toThrow();
  });
});

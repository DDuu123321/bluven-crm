'use server';

import {
  assignOrders,
  cancelOrder,
  changeDocumentType,
  deleteDocument,
  deleteQuote,
  dismissDuplicateFlag,
  holdOrder,
  logActivity,
  markLost,
  moveOrderToNewProperty,
  pushOrder,
  restoreLost,
  resumeOrder,
  returnOrdersToPool,
  reuseDocuments,
  unlinkPylonProject,
  updateCustomer,
  updateHandoffNotes,
  updateProperty,
  updateQuote,
  voidContract,
  withdrawDeposit,
} from '@bluven/core';
import {
  addSenderToCustomer,
  applySummaryHint,
  archiveContractFromAttachment,
  assignEmailToOrder,
  dismissSummaryHint,
  draftReply,
  fileEmailAttachment,
  linkPylonProject,
  previewPylonProject,
  readBill,
  refreshFromPylon,
  sendOrderEmail,
  summariseOrder,
  takeBillValue,
  writeHandoffBrief,
} from '@bluven/integrations';
import { INVALID_REQUEST, runAction, validArgs } from '@/lib/action';
import { requireAssistant } from '@/lib/assistant';
import type { ActionResult } from '@/lib/action-types';
import { dateOnly, dateTime, kilo, list, money, str } from '@/lib/form';
import { describePylonSync, withPylon } from '@/lib/pylon';

/**
 * A date-time field pre-filled with "now" only carries minutes. When the user leaves it alone the
 * entry should be stamped with the actual current time, otherwise it would sort before things
 * that happened earlier in the same minute.
 */
function chosenTime(formData: FormData, name: string): Date | null {
  const value = str(formData, name);
  return value && value !== str(formData, `${name}Default`) ? dateTime(formData, name) : null;
}

// ---- timeline

export async function logActivityAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await logActivity(ctx, {
      orderId,
      type: str(formData, 'type'),
      body: str(formData, 'body'),
      occurredAt: chosenTime(formData, 'occurredAt'),
      outcome: str(formData, 'outcome'),
      direction: str(formData, 'direction'),
    });
  });
}

// ---- customer and property

export async function updateCustomerAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await updateCustomer(ctx, {
      orderId,
      firstName: str(formData, 'firstName'),
      lastName: str(formData, 'lastName'),
      notes: str(formData, 'notes'),
      phones: formData.getAll('phone').map(String),
      emails: formData.getAll('email').map(String),
    });
  });
}

function propertyFields(formData: FormData) {
  return {
    addressLine1: str(formData, 'addressLine1'),
    addressLine2: str(formData, 'addressLine2'),
    suburb: str(formData, 'suburb'),
    state: str(formData, 'state'),
    postcode: str(formData, 'postcode'),
    propertyType: str(formData, 'propertyType'),
    nmi: str(formData, 'nmi'),
    retailer: str(formData, 'retailer'),
    phase: str(formData, 'phase'),
    roofType: str(formData, 'roofType'),
    storeys: str(formData, 'storeys'),
    notes: str(formData, 'notes'),
  };
}

export async function updatePropertyAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await updateProperty(ctx, { orderId, ...propertyFields(formData) });
  });
}

export async function movePropertyAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await moveOrderToNewProperty(ctx, { orderId, ...propertyFields(formData) });
  });
}

// ---- ownership and side states

export async function assignOneAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const ownerId = str(formData, 'ownerId');
    if (ownerId === '__pool__') await returnOrdersToPool(ctx, { orderIds: [orderId], note: str(formData, 'note') });
    else await assignOrders(ctx, { orderIds: [orderId], ownerId });
  });
}

export async function markLostAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await markLost(ctx, { orderId, reasonId: str(formData, 'reasonId'), note: str(formData, 'note') });
  });
}

export async function restoreLostAction(orderId: string): Promise<ActionResult> {
  if (!validArgs(orderId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await restoreLost(ctx, { orderId });
  });
}

export async function holdAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await holdOrder(ctx, { orderId, until: dateOnly(formData, 'until'), note: str(formData, 'note') });
  });
}

export async function resumeAction(orderId: string): Promise<ActionResult> {
  if (!validArgs(orderId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await resumeOrder(ctx, { orderId });
  });
}

export async function cancelOrderAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await cancelOrder(ctx, { orderId, note: str(formData, 'note'), refundStatus: str(formData, 'refundStatus') });
  });
}

export async function dismissDuplicateAction(orderId: string): Promise<ActionResult> {
  if (!validArgs(orderId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await dismissDuplicateFlag(ctx, { orderId });
  });
}

// ---- documents

export async function deleteDocumentAction(documentId: string): Promise<ActionResult> {
  if (!validArgs(documentId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await deleteDocument(ctx, { documentId });
  });
}

export async function changeDocumentTypeAction(documentId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(documentId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await changeDocumentType(ctx, { documentId, typeId: str(formData, 'typeId') });
  });
}

export async function reuseDocumentsAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const { reused } = await reuseDocuments(ctx, { orderId, documentIds: list(formData, 'documentId') });
    return { message: `${reused} file${reused === 1 ? '' : 's'} added to this order.` };
  });
}

// ---- quotes, contract, deposit

export async function updateQuoteAction(quoteId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(quoteId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await updateQuote(ctx, {
      quoteId,
      title: str(formData, 'title'),
      dcWatts: kilo(formData, 'systemKw'),
      storageWh: kilo(formData, 'batteryKwh'),
      totalCents: money(formData, 'total'),
      depositCents: money(formData, 'deposit'),
      notes: str(formData, 'notes'),
    });
  });
}

export async function deleteQuoteAction(quoteId: string): Promise<ActionResult> {
  if (!validArgs(quoteId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await deleteQuote(ctx, { quoteId });
  });
}

export async function unlinkPylonAction(orderId: string): Promise<ActionResult> {
  if (!validArgs(orderId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await unlinkPylonProject(ctx, { orderId });
    return { message: 'Unlinked. The next project in Pylon with this order number as its reference will be linked.' };
  });
}

/** One form, two buttons: look at which project a pasted Pylon address leads to, or link it. */
export async function linkPylonAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const ref = str(formData, 'ref');
    if (str(formData, 'intent') !== 'link') {
      const p = await withPylon((api) => previewPylonProject(ctx, api, { orderId, ref }));
      const who = [p.customerName, p.siteAddress].filter(Boolean).join(', ') || 'a project without customer details';
      const designs = p.designs === 0 ? 'no design yet' : `${p.designs} design${p.designs === 1 ? '' : 's'}`;
      return { message: `Pylon project for ${who}: ${designs}${p.signed ? ', signed by the customer' : ''}. If this is the right one, press “Link project”.` };
    }
    const result = await withPylon((api) => linkPylonProject(ctx, api, { orderId, ref }));
    return { message: `Linked. ${describePylonSync(result)}` };
  });
}

export async function refreshPylonAction(orderId: string): Promise<ActionResult> {
  if (!validArgs(orderId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const result = await withPylon((api) => refreshFromPylon(ctx, api, { orderId }));
    return { message: describePylonSync(result) };
  });
}

export async function voidContractAction(contractId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(contractId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await voidContract(ctx, { contractId, reason: str(formData, 'reason') });
  });
}

export async function withdrawDepositAction(depositId: string): Promise<ActionResult> {
  if (!validArgs(depositId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await withdrawDeposit(ctx, { depositId });
  });
}

// ---- e-mail

export async function sendEmailAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const sent = await sendOrderEmail(ctx, {
      orderId,
      to: [str(formData, 'to')],
      cc: [str(formData, 'cc')],
      subject: str(formData, 'subject'),
      body: str(formData, 'body'),
      documentIds: list(formData, 'documentIds'),
      replyToEmailId: str(formData, 'replyTo') || null,
    });
    return { message: sent.id ? 'Sent.' : 'Sent. It will appear here within a few minutes.' };
  });
}

export async function placeEmailAction(orderId: string, emailId: string): Promise<ActionResult> {
  if (!validArgs(orderId, emailId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await assignEmailToOrder(ctx, { emailId, orderId });
  });
}

export async function addSenderAction(emailId: string): Promise<ActionResult> {
  if (!validArgs(emailId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const { address } = await addSenderToCustomer(ctx, { emailId });
    return { message: `${address} is now on the customer’s record.` };
  });
}

export async function fileAttachmentAction(attachmentId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(attachmentId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await fileEmailAttachment(ctx, { attachmentId, typeId: str(formData, 'typeId') });
    return { message: 'Filed.' };
  });
}

export async function archiveAttachmentAction(attachmentId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(attachmentId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await archiveContractFromAttachment(ctx, { attachmentId, quoteId: str(formData, 'quoteId') || null, signedOn: dateOnly(formData, 'signedOn') });
    return { message: 'Contract archived.' };
  });
}

// ---- the assistant

export async function summariseAction(orderId: string): Promise<ActionResult> {
  if (!validArgs(orderId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await summariseOrder(ctx, { orderId }, requireAssistant());
  });
}

/** A suggested property detail: one form, two buttons, take it over or set it aside. */
export async function summaryHintAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const hint = { orderId, field: str(formData, 'field'), value: str(formData, 'value') };
    if (str(formData, 'intent') === 'dismiss') await dismissSummaryHint(ctx, hint);
    else await applySummaryHint(ctx, hint);
  });
}

/** Hands a draft back to the form it was asked from. Nothing is stored and nothing is sent. */
export async function draftReplyAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(
    async (ctx) => {
      const draft = await draftReply(ctx, { orderId, replyToEmailId: str(formData, 'replyTo') || null, instruction: str(formData, 'instruction') }, requireAssistant());
      return { data: { subject: draft.subject, body: draft.body } };
    },
    { refresh: false },
  );
}

export async function readBillAction(documentId: string): Promise<ActionResult> {
  if (!validArgs(documentId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const reading = await readBill(ctx, { documentId, again: true }, requireAssistant());
    return { message: reading?.isBill ? 'Read.' : 'This does not look like an electricity bill.' };
  });
}

export async function billValueAction(readingId: string, field: string): Promise<ActionResult> {
  if (!validArgs(readingId, field)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await takeBillValue(ctx, { readingId, field: field === 'retailer' ? 'retailer' : 'nmi' });
  });
}

export async function writeBriefAction(orderId: string): Promise<ActionResult> {
  if (!validArgs(orderId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await writeHandoffBrief(ctx, { orderId }, requireAssistant());
  });
}

// ---- handoff

/** One form, two buttons: save the notes for operations, or push the order with them. */
export async function handoffAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const notes = str(formData, 'notes');
    if (str(formData, 'intent') === 'save') {
      await updateHandoffNotes(ctx, { orderId, notes });
      return { message: 'Notes saved.' };
    }
    await pushOrder(ctx, { orderId, notes });
    return { message: 'Sent to operations.' };
  });
}

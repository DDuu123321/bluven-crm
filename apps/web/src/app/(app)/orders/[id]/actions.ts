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
  markQuoteSent,
  moveOrderToNewProperty,
  pushOrder,
  restoreLost,
  resumeOrder,
  returnOrdersToPool,
  reuseDocuments,
  updateCustomer,
  updateHandoffNotes,
  updateProperty,
  updateQuote,
  voidContract,
  withdrawDeposit,
} from '@bluven/core';
import { runAction } from '@/lib/action';
import type { ActionResult } from '@/lib/action-types';
import { dateOnly, dateTime, kilo, list, money, str } from '@/lib/form';

// ---- timeline

export async function logActivityAction(orderId: string, formData: FormData): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await logActivity(ctx, {
      orderId,
      type: str(formData, 'type'),
      body: str(formData, 'body'),
      occurredAt: dateTime(formData, 'occurredAt'),
      outcome: str(formData, 'outcome'),
      direction: str(formData, 'direction'),
    });
  });
}

// ---- customer and property

export async function updateCustomerAction(orderId: string, formData: FormData): Promise<ActionResult> {
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
  return runAction(async (ctx) => {
    await updateProperty(ctx, { orderId, ...propertyFields(formData) });
  });
}

export async function movePropertyAction(orderId: string, formData: FormData): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await moveOrderToNewProperty(ctx, { orderId, ...propertyFields(formData) });
  });
}

// ---- ownership and side states

export async function assignOneAction(orderId: string, formData: FormData): Promise<ActionResult> {
  return runAction(async (ctx) => {
    const ownerId = str(formData, 'ownerId');
    if (ownerId === '__pool__') await returnOrdersToPool(ctx, { orderIds: [orderId], note: str(formData, 'note') });
    else await assignOrders(ctx, { orderIds: [orderId], ownerId });
  });
}

export async function markLostAction(orderId: string, formData: FormData): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await markLost(ctx, { orderId, reasonId: str(formData, 'reasonId'), note: str(formData, 'note') });
  });
}

export async function restoreLostAction(orderId: string): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await restoreLost(ctx, { orderId });
  });
}

export async function holdAction(orderId: string, formData: FormData): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await holdOrder(ctx, { orderId, until: dateOnly(formData, 'until'), note: str(formData, 'note') });
  });
}

export async function resumeAction(orderId: string): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await resumeOrder(ctx, { orderId });
  });
}

export async function cancelOrderAction(orderId: string, formData: FormData): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await cancelOrder(ctx, { orderId, note: str(formData, 'note'), refundStatus: str(formData, 'refundStatus') });
  });
}

export async function dismissDuplicateAction(orderId: string): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await dismissDuplicateFlag(ctx, { orderId });
  });
}

// ---- documents

export async function deleteDocumentAction(documentId: string): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await deleteDocument(ctx, { documentId });
  });
}

export async function changeDocumentTypeAction(documentId: string, formData: FormData): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await changeDocumentType(ctx, { documentId, typeId: str(formData, 'typeId') });
  });
}

export async function reuseDocumentsAction(orderId: string, formData: FormData): Promise<ActionResult> {
  return runAction(async (ctx) => {
    const { reused } = await reuseDocuments(ctx, { orderId, documentIds: list(formData, 'documentId') });
    return { message: `${reused} file${reused === 1 ? '' : 's'} added to this order.` };
  });
}

// ---- quotes, contract, deposit

export async function updateQuoteAction(quoteId: string, formData: FormData): Promise<ActionResult> {
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

export async function markQuoteSentAction(quoteId: string, formData: FormData): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await markQuoteSent(ctx, { quoteId, sentAt: dateTime(formData, 'sentAt') });
  });
}

export async function deleteQuoteAction(quoteId: string): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await deleteQuote(ctx, { quoteId });
  });
}

export async function voidContractAction(contractId: string, formData: FormData): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await voidContract(ctx, { contractId, reason: str(formData, 'reason') });
  });
}

export async function withdrawDepositAction(depositId: string): Promise<ActionResult> {
  return runAction(async (ctx) => {
    await withdrawDeposit(ctx, { depositId });
  });
}

// ---- handoff

/** One form, two buttons: save the notes for operations, or push the order with them. */
export async function handoffAction(orderId: string, formData: FormData): Promise<ActionResult> {
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

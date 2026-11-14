'use server';

import { acceptHandoff, addOpsNote, askSalesToChaseBalance, confirmFinalPayment, markJobDone, retryNotice, returnHandoff, sendScheduleNotice, setRebateApplied, updateOpsJob } from '@bluven/core';
import { INVALID_REQUEST, runAction, validArgs } from '@/lib/action';
import type { ActionResult } from '@/lib/action-types';
import { bool, dateOnly, list, money, str } from '@/lib/form';

// ---- taking an order on, or sending it back

/** Operations accepts the order and, with it, says that the deposit is in the account. */
export async function acceptHandoffAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await acceptHandoff(ctx, { orderId, depositReceived: bool(formData, 'depositReceived') });
    return { message: 'Accepted.' };
  });
}

export async function returnHandoffAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await returnHandoff(ctx, { orderId, reason: str(formData, 'reason'), missing: list(formData, 'missing') });
  });
}

// ---- arranging the job

export async function updateOpsJobAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await updateOpsJob(ctx, {
      orderId,
      caStatus: str(formData, 'caStatus'),
      caReference: str(formData, 'caReference'),
      stcPlatform: str(formData, 'stcPlatform'),
      stcReference: str(formData, 'stcReference'),
      installerName: str(formData, 'installerName'),
      electricianLicence: str(formData, 'electricianLicence'),
      installDate: dateOnly(formData, 'installDate'),
      deliveryMode: str(formData, 'deliveryMode'),
      deliveryEta: dateOnly(formData, 'deliveryEta'),
      purchaseStatus: str(formData, 'purchaseStatus'),
    });
    return { message: 'Saved.' };
  });
}

export async function addOpsNoteAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await addOpsNote(ctx, { orderId, body: str(formData, 'body') });
  });
}

/** Tells the customer the installation date and how the equipment arrives. */
export async function sendScheduleNoticeAction(orderId: string): Promise<ActionResult> {
  if (!validArgs(orderId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const outcome = await sendScheduleNotice(ctx, { orderId });
    return {
      message:
        outcome === 'queued'
          ? 'The e-mail is on its way to the customer.'
          : outcome === 'no_address'
            ? 'Not sent: the customer has no confirmed e-mail address. See the list of e-mails below.'
            : 'Not sent: see the list of e-mails below for what is missing.',
    };
  });
}

// ---- after the installation

export async function markJobDoneAction(orderId: string): Promise<ActionResult> {
  if (!validArgs(orderId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await markJobDone(ctx, { orderId });
  });
}

export async function rebateAction(orderId: string, applied: string): Promise<ActionResult> {
  if (!validArgs(orderId, applied)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await setRebateApplied(ctx, { orderId, applied: applied === 'yes' });
  });
}

export async function chaseBalanceAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await askSalesToChaseBalance(ctx, { orderId, note: str(formData, 'note') });
    return { message: 'The salesperson has been asked.' };
  });
}

/** The balance is in the account: the job is closed. Operations and finance can both say so. */
export async function finalPaymentAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await confirmFinalPayment(ctx, { orderId, amountCents: money(formData, 'amount'), receivedOn: dateOnly(formData, 'receivedOn'), note: str(formData, 'note') });
    return { message: 'The job is closed.' };
  });
}

// ---- the e-mails to the customer

export async function retryNoticeAction(noticeId: string): Promise<ActionResult> {
  if (!validArgs(noticeId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await retryNotice(ctx, { noticeId });
    return { message: 'On its way.' };
  });
}

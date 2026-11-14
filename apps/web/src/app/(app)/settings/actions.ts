'use server';

import {
  NOTICE_KINDS,
  createDocumentType,
  createLeadOrigin,
  createLeadSource,
  createLostReason,
  createUser,
  resetUserPassword,
  revokePreviousIntakeToken,
  rotateIntakeToken,
  updateDocumentType,
  updateLeadOrigin,
  updateLeadSource,
  updateLostReason,
  updateOperationsSettings,
  updateSettings,
  updateUser,
  type OperationsSettings,
} from '@bluven/core';
import { createEmailTemplate, deleteEmailTemplate, updateAssistantSettings, updateEmailTemplate } from '@bluven/integrations';
import { INVALID_REQUEST, runAction, validArgs } from '@/lib/action';
import type { ActionResult } from '@/lib/action-types';
import { bool, int, list, str } from '@/lib/form';

// ---- e-mail templates

export async function saveTemplateAction(id: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(id, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const input = { name: str(formData, 'name'), subject: str(formData, 'subject'), body: String(formData.get('body') ?? ''), isActive: bool(formData, 'isActive'), sortOrder: int(formData, 'sortOrder') ?? -1 };
    if (id === 'new') await createEmailTemplate(ctx, input);
    else await updateEmailTemplate(ctx, { id, ...input });
  });
}

export async function deleteTemplateAction(id: string): Promise<ActionResult> {
  if (!validArgs(id)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await deleteEmailTemplate(ctx, { id });
  });
}

// ---- the assistant

export async function updateAssistantAction(formData: FormData): Promise<ActionResult> {
  if (!validArgs(formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await updateAssistantSettings(ctx, {
      autoBrief: bool(formData, 'autoBrief'),
      readAttachments: bool(formData, 'readAttachments'),
      readBills: bool(formData, 'readBills'),
      autoSummary: bool(formData, 'autoSummary'),
      language: str(formData, 'language') === 'zh' ? 'zh' : 'en',
      // An empty field is not a number: it reaches the service as one it refuses, with the message on the field.
      dailyAutomaticLimit: int(formData, 'dailyAutomaticLimit') ?? -1,
    });
    return { message: 'Saved.' };
  });
}

// ---- users

export async function createUserAction(formData: FormData): Promise<ActionResult> {
  if (!validArgs(formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await createUser(ctx, { email: str(formData, 'email'), name: str(formData, 'name'), roles: list(formData, 'roles'), password: String(formData.get('password') ?? '') });
  });
}

export async function updateUserAction(userId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(userId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await updateUser(ctx, { userId, name: str(formData, 'name'), roles: list(formData, 'roles'), isActive: bool(formData, 'isActive') });
  });
}

export async function resetPasswordAction(userId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(userId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await resetUserPassword(ctx, { userId, password: String(formData.get('password') ?? '') });
  });
}

// ---- intake channels

export async function createLeadSourceAction(formData: FormData): Promise<ActionResult> {
  if (!validArgs(formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await createLeadSource(ctx, { name: str(formData, 'name'), kind: str(formData, 'kind') });
  });
}

export async function updateLeadSourceAction(sourceId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(sourceId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await updateLeadSource(ctx, { sourceId, name: str(formData, 'name'), isActive: bool(formData, 'isActive') });
  });
}

/** Returns the new token in `data.token`. It is shown once and cannot be retrieved again. */
export async function rotateTokenAction(sourceId: string): Promise<ActionResult> {
  if (!validArgs(sourceId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const { token } = await rotateIntakeToken(ctx, { sourceId });
    return { data: { token } };
  });
}

export async function revokePreviousTokenAction(sourceId: string): Promise<ActionResult> {
  if (!validArgs(sourceId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await revokePreviousIntakeToken(ctx, { sourceId });
  });
}

// ---- lead sources (where a customer came from; chosen when a job is opened)

export async function createLeadOriginAction(formData: FormData): Promise<ActionResult> {
  if (!validArgs(formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await createLeadOrigin(ctx, { label: str(formData, 'label') });
  });
}

export async function updateLeadOriginAction(originId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(originId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await updateLeadOrigin(ctx, { originId, label: str(formData, 'label'), isActive: bool(formData, 'isActive'), sortOrder: int(formData, 'sortOrder') ?? NaN });
  });
}

// ---- operations and the e-mails to customers

export async function updateOperationsAction(formData: FormData): Promise<ActionResult> {
  if (!validArgs(formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    const notices = Object.fromEntries(
      NOTICE_KINDS.map((kind) => [kind, { enabled: bool(formData, `${kind}.enabled`), subject: str(formData, `${kind}.subject`), body: String(formData.get(`${kind}.body`) ?? '') }]),
    ) as OperationsSettings['notices'];
    await updateOperationsSettings(ctx, {
      // An empty field is not a number: it reaches the service as one it refuses, with the message on the field.
      rebateReminderDays: int(formData, 'rebateReminderDays') ?? NaN,
      balanceDays: int(formData, 'balanceDays') ?? NaN,
      mailboxUserId: str(formData, 'mailboxUserId') || null,
      notices,
    });
    return { message: 'Saved.' };
  });
}

// ---- checklist (document types)

function docTypeInput(formData: FormData) {
  return {
    label: str(formData, 'label'),
    description: str(formData, 'description'),
    scope: str(formData, 'scope'),
    isRequiredForHandoff: bool(formData, 'isRequiredForHandoff'),
    retentionYears: int(formData, 'retentionYears'),
    neverAutoDelete: bool(formData, 'neverAutoDelete'),
    sortOrder: int(formData, 'sortOrder') ?? 100,
    isActive: bool(formData, 'isActive'),
  };
}

export async function createDocumentTypeAction(formData: FormData): Promise<ActionResult> {
  if (!validArgs(formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await createDocumentType(ctx, { ...docTypeInput(formData), isActive: true });
  });
}

export async function updateDocumentTypeAction(typeId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(typeId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await updateDocumentType(ctx, { typeId, ...docTypeInput(formData) });
  });
}

// ---- lost reasons

export async function createLostReasonAction(formData: FormData): Promise<ActionResult> {
  if (!validArgs(formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await createLostReason(ctx, { label: str(formData, 'label') });
  });
}

export async function updateLostReasonAction(reasonId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(reasonId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await updateLostReason(ctx, { reasonId, label: str(formData, 'label'), isActive: bool(formData, 'isActive'), sortOrder: int(formData, 'sortOrder') ?? 0 });
  });
}

// ---- rules

export async function updateRulesAction(formData: FormData): Promise<ActionResult> {
  if (!validArgs(formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await updateSettings(ctx, {
      idle: {
        remindOwnerDays: int(formData, 'remindOwnerDays') ?? NaN,
        remindManagerDays: int(formData, 'remindManagerDays') ?? NaN,
        returnToPoolDays: int(formData, 'returnToPoolDays') ?? NaN,
      },
      defaultDepositPercent: Number(str(formData, 'defaultDepositPercent') || 'NaN'),
      retention: {
        years: int(formData, 'retentionYears') ?? NaN,
        reminderDays: int(formData, 'retentionReminderDays') ?? NaN,
        autoDelete: bool(formData, 'retentionAutoDelete'),
      },
    });
    return { message: 'Rules saved.' };
  });
}

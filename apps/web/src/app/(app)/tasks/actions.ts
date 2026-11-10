'use server';

import { createTask, setTaskStatus, updateTask } from '@bluven/core';
import { INVALID_REQUEST, runAction, validArgs } from '@/lib/action';
import type { ActionResult } from '@/lib/action-types';
import { dateTime, str } from '@/lib/form';

export async function createTaskAction(orderId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(orderId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await createTask(ctx, { orderId, title: str(formData, 'title'), dueAt: dateTime(formData, 'dueAt'), notes: str(formData, 'notes') });
  });
}

export async function updateTaskAction(taskId: string, formData: FormData): Promise<ActionResult> {
  if (!validArgs(taskId, formData)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await updateTask(ctx, { taskId, title: str(formData, 'title'), dueAt: dateTime(formData, 'dueAt'), notes: str(formData, 'notes') });
  });
}

export async function completeTaskAction(taskId: string): Promise<ActionResult> {
  if (!validArgs(taskId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await setTaskStatus(ctx, { taskId, status: 'DONE' });
  });
}

export async function reopenTaskAction(taskId: string): Promise<ActionResult> {
  if (!validArgs(taskId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await setTaskStatus(ctx, { taskId, status: 'OPEN' });
  });
}

export async function cancelTaskAction(taskId: string): Promise<ActionResult> {
  if (!validArgs(taskId)) return INVALID_REQUEST;
  return runAction(async (ctx) => {
    await setTaskStatus(ctx, { taskId, status: 'CANCELLED' });
  });
}

// Ready-made texts for e-mails written in the CRM. Managers maintain them; whoever writes to a
// customer picks one and gets it with the customer's name and address already in place.
import type { EmailTemplate } from '@bluven/db';
import { FieldErrors, ForbiddenError, NotFoundError, TEMPLATE_FIELDS, actorId, audit, can, fillTemplate, formatAddress, fullName, inTx, isOrderStaff, newId, nowOf, requireOrderView, requireUser, unknownTemplateFields, type Ctx } from '@bluven/core';

const MAX_TEMPLATES = 100;

export interface EmailTemplateInput {
  name: string;
  subject: string;
  body: string;
  isActive: boolean;
  sortOrder: number;
}

function requireManager(ctx: Ctx) {
  const actor = requireUser(ctx);
  if (!can(actor, 'config.manage')) throw new ForbiddenError();
  return actor;
}

function clean(input: EmailTemplateInput): EmailTemplateInput {
  const errors = new FieldErrors();
  const name = input.name.trim();
  const subject = input.subject.trim();
  const body = input.body.replace(/\r\n/g, '\n').trim();
  if (!name) errors.add('name', 'Give the text a name.');
  if (name.length > 80) errors.add('name', 'Use at most 80 characters.');
  if (subject.length > 300) errors.add('subject', 'Use at most 300 characters.');
  if (!body) errors.add('body', 'Write the text.');
  if (body.length > 20_000) errors.add('body', 'Use at most 20,000 characters.');
  // A misspelt field would go out to a customer as it stands.
  const unknown = unknownTemplateFields(`${subject}\n${body}`);
  if (unknown.length > 0) errors.add(unknownTemplateFields(subject).length > 0 ? 'subject' : 'body', `“{{${unknown[0]}}}” is not a field. The fields are: ${Object.keys(TEMPLATE_FIELDS).map((f) => `{{${f}}}`).join(', ')}.`);
  if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 9_999) errors.add('sortOrder', 'Enter a whole number between 0 and 9999.');
  errors.throwIfAny();
  return { name, subject, body, isActive: input.isActive, sortOrder: input.sortOrder };
}

/** Every ready-made text, for the page where managers maintain them. */
export async function listEmailTemplates(ctx: Ctx): Promise<EmailTemplate[]> {
  requireManager(ctx);
  return ctx.db.emailTemplate.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
}

export async function createEmailTemplate(ctx: Ctx, input: EmailTemplateInput): Promise<{ id: string }> {
  requireManager(ctx);
  const data = clean(input);
  return inTx(ctx.db, async (tx) => {
    if ((await tx.emailTemplate.count()) >= MAX_TEMPLATES) throw new ForbiddenError(`There are already ${MAX_TEMPLATES} texts. Remove one that is no longer used first.`);
    const id = newId('etp');
    await tx.emailTemplate.create({ data: { id, ...data, createdById: actorId(ctx), createdAt: nowOf(ctx) } });
    await audit(tx, ctx, { action: 'mail.template_create', entityType: 'EmailTemplate', entityId: id, summary: `Added the e-mail text “${data.name}”`, after: data });
    return { id };
  });
}

export async function updateEmailTemplate(ctx: Ctx, input: { id: string } & EmailTemplateInput): Promise<void> {
  requireManager(ctx);
  const data = clean(input);
  await inTx(ctx.db, async (tx) => {
    const before = await tx.emailTemplate.findUnique({ where: { id: input.id } });
    if (!before) throw new NotFoundError('Text not found.');
    await tx.emailTemplate.update({ where: { id: input.id }, data });
    await audit(tx, ctx, {
      action: 'mail.template_update',
      entityType: 'EmailTemplate',
      entityId: input.id,
      summary: `Changed the e-mail text “${data.name}”`,
      before: { name: before.name, subject: before.subject, body: before.body, isActive: before.isActive, sortOrder: before.sortOrder },
      after: data,
    });
  });
}

export async function deleteEmailTemplate(ctx: Ctx, input: { id: string }): Promise<void> {
  requireManager(ctx);
  await inTx(ctx.db, async (tx) => {
    const before = await tx.emailTemplate.findUnique({ where: { id: input.id } });
    if (!before) return;
    await tx.emailTemplate.delete({ where: { id: input.id } });
    await audit(tx, ctx, { action: 'mail.template_delete', entityType: 'EmailTemplate', entityId: input.id, summary: `Removed the e-mail text “${before.name}”`, before: { name: before.name, subject: before.subject, body: before.body } });
  });
}

export interface FilledTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
}

/**
 * The texts in use, with this order's customer, address and the writer's own name filled in.
 * For the people who can write to the order's customer.
 */
export async function templatesForOrder(ctx: Ctx, orderId: string): Promise<FilledTemplate[]> {
  const actor = requireUser(ctx);
  const { order } = await requireOrderView(ctx.db, ctx, orderId);
  if (!isOrderStaff(actor, order)) return [];
  const [templates, facts] = await Promise.all([
    ctx.db.emailTemplate.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    ctx.db.order.findUniqueOrThrow({ where: { id: orderId }, select: { orderNo: true, customer: { select: { firstName: true, lastName: true } }, property: true } }),
  ]);
  const values = {
    first_name: facts.customer.firstName,
    full_name: fullName(facts.customer),
    address: formatAddress(facts.property),
    order_no: facts.orderNo,
    my_name: actor.name,
    my_first_name: actor.name.split(/\s+/)[0] ?? actor.name,
  };
  return templates.map((t) => ({ id: t.id, name: t.name, subject: fillTemplate(t.subject, values), body: fillTemplate(t.body, values) }));
}

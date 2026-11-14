import { beforeEach, describe, expect, it } from 'vitest';
import { ensureReferenceData, fillTemplate, pushOrder, unknownTemplateFields } from '@bluven/core';
import { as, resetDb, testDb } from '../../core/test/helpers';
import { makeWorld, orderAt, type World } from '../../core/test/setup-order';
import { createEmailTemplate, deleteEmailTemplate, listEmailTemplates, templatesForOrder, updateEmailTemplate } from '../src';

const db = testDb();
let w: World;

beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});

const input = { name: 'Site visit', subject: 'Your site visit at {{address}}', body: 'Hi {{first_name}},\n\nI will come by on [day].\n\n{{my_first_name}}', isActive: true, sortOrder: 5 };

describe('ready-made e-mail texts', () => {
  it('fills in what it knows and leaves the rest for the person sending to see', () => {
    expect(fillTemplate('Hi {{first_name}}, about {{ Address }}: {{unknown}} {{my_name}}', { first_name: 'Jane', address: '12 Sample St', my_name: '' })).toBe('Hi Jane, about 12 Sample St: {{unknown}} {{my_name}}');
    expect(unknownTemplateFields('{{first_name}} {{firstname}} {{ two words }} {{ORDER_NO}}')).toEqual(['firstname', 'two words']);
    // Names every object has are not fields: they are refused when a template is saved, and left as written when one is filled.
    expect(unknownTemplateFields('{{constructor}} {{__proto__}} {{toString}} {{first_name}}')).toEqual(['constructor', '__proto__', 'toString']);
    expect(fillTemplate('{{constructor}} {{__proto__}} {{valueOf}} {{first_name}}', { first_name: 'Jane' })).toBe('{{constructor}} {{__proto__}} {{valueOf}} Jane');
  });

  it('come with a few to start from, filled in for the order and the person writing', async () => {
    const { orderId } = await orderAt(w, 'OPENED');
    const texts = await templatesForOrder(as(w.sam, w.clock), orderId);
    expect(texts.map((t) => t.name)).toEqual(['First contact', 'Ask for the bill and photos', 'Follow up on a quote', 'Going ahead: deposit and next steps']);
    expect(texts[0]!.body).toContain('Hi Jane,');
    expect(texts[0]!.body).toContain('about solar for 12 Sample St, Parramatta NSW 2150.');
    expect(texts[0]!.body).toContain('Regards,\nSam\nBluven');
    expect(texts.every((t) => !/\{\{/.test(t.subject + t.body))).toBe(true);

    // Only the people who write to this customer get them.
    await expect(templatesForOrder(as(w.alex, w.clock), orderId)).rejects.toThrow('Order not found.');
    const ready = await orderAt(w, 'READY', { firstName: 'Pia', phone: '0400 111 222', email: 'pia@example.com', address: '3 Push St' });
    await pushOrder(as(w.sam, w.clock), { orderId: ready.orderId });
    expect(await templatesForOrder(as(w.ops, w.clock), ready.orderId)).toEqual([]);
  });

  it('are maintained by managers, and a misspelt field is caught before it reaches a customer', async () => {
    const manager = as(w.manager, w.clock);
    await expect(createEmailTemplate(as(w.sam, w.clock), input)).rejects.toThrow('not allowed');
    await expect(listEmailTemplates(as(w.sam, w.clock))).rejects.toThrow('not allowed');
    await expect(createEmailTemplate(manager, { ...input, name: ' ', body: '' })).rejects.toMatchObject({ fieldErrors: { name: expect.any(String), body: expect.any(String) } });
    await expect(createEmailTemplate(manager, { ...input, body: 'Hi {{firstname}}' })).rejects.toMatchObject({ fieldErrors: { body: expect.stringContaining('“{{firstname}}” is not a field') } });
    await expect(createEmailTemplate(manager, { ...input, subject: 'For {{customer}}' })).rejects.toMatchObject({ fieldErrors: { subject: expect.stringContaining('{{first_name}}') } });

    const { id } = await createEmailTemplate(manager, input);
    expect((await listEmailTemplates(manager)).map((t) => t.name)).toEqual(['Site visit', 'First contact', 'Ask for the bill and photos', 'Follow up on a quote', 'Going ahead: deposit and next steps']);
    const { orderId } = await orderAt(w, 'OPENED');
    const mine = (await templatesForOrder(as(w.sam, w.clock), orderId))[0]!;
    expect(mine).toMatchObject({ name: 'Site visit', subject: 'Your site visit at 12 Sample St, Parramatta NSW 2150', body: 'Hi Jane,\n\nI will come by on [day].\n\nSam' });

    // Hidden: still there for managers, no longer offered.
    await updateEmailTemplate(manager, { id, ...input, isActive: false });
    expect((await templatesForOrder(as(w.sam, w.clock), orderId)).map((t) => t.name)).not.toContain('Site visit');
    expect((await listEmailTemplates(manager)).find((t) => t.id === id)!.isActive).toBe(false);
    await deleteEmailTemplate(manager, { id });
    await expect(updateEmailTemplate(manager, { id, ...input })).rejects.toThrow('Text not found.');
    expect((await db.auditLog.findMany({ where: { entityType: 'EmailTemplate', entityId: id }, orderBy: { at: 'asc' } })).map((a) => a.action)).toEqual(['mail.template_create', 'mail.template_update', 'mail.template_delete']);
  });

  it('do not come back after a manager removed them', async () => {
    const manager = as(w.manager, w.clock);
    for (const t of await listEmailTemplates(manager)) await deleteEmailTemplate(manager, { id: t.id });
    await ensureReferenceData(db);
    expect(await listEmailTemplates(manager)).toEqual([]);
  });
});

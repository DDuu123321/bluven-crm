// Editing a property from a form that was rendered a while ago, while something else writes to
// the same property: a bill being read, or a colleague working on another order at that address.
import { beforeEach, describe, expect, it } from 'vitest';
import { PROPERTY_FIELD_NAMES, inTx, lockOrder, loadOrderState, readFieldSources, setSourcedPropertyFields, systemCtx, updateProperty, type PropertyFields } from '../src';
import { as, resetDb, testDb } from './helpers';
import { makeWorld, orderAt, type World } from './setup-order';

const db = testDb();
let w: World;

beforeEach(async () => {
  await resetDb();
  w = await makeWorld();
});

const propertyOf = async (orderId: string) => (await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { property: true } })).property;
/** What the "Edit property" form shows, and sends back, for a property as it is now. */
const asShown = async (orderId: string): Promise<PropertyFields> => {
  const p = await propertyOf(orderId);
  return Object.fromEntries(PROPERTY_FIELD_NAMES.map((field) => [field, p[field]])) as unknown as PropertyFields;
};
/** The assistant fills the meter number and the retailer from a bill, as the background process does. */
const fillFromBill = (orderId: string) =>
  inTx(db, async (tx) => {
    await lockOrder(tx, orderId);
    const order = (await loadOrderState(tx, orderId))!;
    return setSourcedPropertyFields(tx, systemCtx(db, 'Assistant', w.clock.now), order, { nmi: '41031234567', retailer: 'AGL' }, { source: 'bill', documentId: 'doc_bill' }, { onlyEmpty: true });
  });

describe('editing a property', () => {
  it('writes only what the person changed, so a value filled in meanwhile is not put back to empty', async () => {
    const { orderId } = await orderAt(w, 'OPENED');
    const sam = as(w.sam, w.clock);
    // Sam opens the form. While it is open, the bill he uploaded is read.
    const shown = await asShown(orderId);
    expect(shown).toMatchObject({ nmi: '', retailer: '', roofType: '' });
    expect(await fillFromBill(orderId)).toEqual(['nmi', 'retailer']);

    // He types the roof and saves. The form still carries the empty meter number it was rendered with.
    await updateProperty(sam, { orderId, ...shown, roofType: 'Tile', original: shown });
    let p = await propertyOf(orderId);
    expect(p).toMatchObject({ nmi: '41031234567', retailer: 'AGL', roofType: 'Tile' });
    // What the assistant filled is still marked as such; what he typed is not.
    expect(Object.keys(readFieldSources(p.fieldSources)).sort()).toEqual(['nmi', 'retailer']);
    const log = await db.auditLog.findFirstOrThrow({ where: { orderId, action: 'property.update', actorId: w.sam.id }, orderBy: { at: 'desc' } });
    expect(log.after).toEqual({ roofType: 'Tile' });

    // Taking a value out on purpose is a change like any other: the form showed it, and he cleared it.
    const now = await asShown(orderId);
    await updateProperty(sam, { orderId, ...now, nmi: '', original: now });
    p = await propertyOf(orderId);
    expect(p).toMatchObject({ nmi: '', retailer: 'AGL', roofType: 'Tile' });
    expect(Object.keys(readFieldSources(p.fieldSources))).toEqual(['retailer']);

    // The same spelling in different clothes is not a change: spaces around a value, lower case in a state.
    await updateProperty(sam, { orderId, ...now, nmi: '', state: ` ${now.state.toLowerCase()} `, retailer: 'AGL ', original: { ...now, nmi: '' } });
    expect(await db.auditLog.count({ where: { orderId, action: 'property.update', actorId: w.sam.id } })).toBe(2);

    // A caller that says nothing about what was shown means every field, as before.
    await updateProperty(sam, { orderId, ...now, nmi: '', retailer: '' });
    expect(await propertyOf(orderId)).toMatchObject({ retailer: '', roofType: 'Tile' });
  });

  it('waits for another writer to the same address, on whichever order that one works', async () => {
    const a = await orderAt(w, 'OPENED');
    const b = await orderAt(w, 'OPENED', { phone: '0400 555 666', email: 'second@example.com', address: '2 Other Rd' });
    // Two orders at one address share the property.
    const shared = (await propertyOf(a.orderId)).id;
    await db.order.update({ where: { id: b.orderId }, data: { propertyId: shared } });
    const shown = await asShown(a.orderId);

    // The bill on order B is being applied: its transaction holds the property and has not finished.
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const filling = inTx(db, async (tx) => {
      await lockOrder(tx, b.orderId);
      const order = (await loadOrderState(tx, b.orderId))!;
      await setSourcedPropertyFields(tx, systemCtx(db, 'Assistant', w.clock.now), order, { nmi: '41031234567' }, { source: 'bill' }, { onlyEmpty: true });
      holding();
      await gate;
    });
    await held;
    const saving = updateProperty(as(w.sam, w.clock), { orderId: a.orderId, ...shown, roofType: 'Tin', original: shown });
    const first = await Promise.race([saving.then(() => 'saved'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 400))]);
    expect(first).toBe('waiting');
    finish();
    await Promise.all([filling, saving]);

    // Both are there, and so is the mark on the one nobody typed.
    const p = await db.property.findUniqueOrThrow({ where: { id: shared } });
    expect(p).toMatchObject({ nmi: '41031234567', roofType: 'Tin' });
    expect(Object.keys(readFieldSources(p.fieldSources))).toEqual(['nmi']);
  });
});

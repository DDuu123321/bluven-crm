import { beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../src';
import { DEMO_PASSWORD, DEMO_USERS, createDemoData, samplePdf } from '../src/services/demo';
import { makeUser, resetDb } from './helpers';

describe('demo data', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('fills an empty database with an account per role and orders at every point of the sale', async () => {
    const db = await resetDb();
    const summary = await createDemoData(db, new Date('2026-11-13T02:00:00Z'));
    expect(summary).toEqual({ users: DEMO_USERS.length, orders: 13 });

    const users = await db.user.findMany();
    expect(users.map((u) => u.email).sort()).toEqual(DEMO_USERS.map((u) => u.email).sort());
    expect(await verifyPassword(DEMO_PASSWORD, users[0]!.passwordHash)).toBe(true);
    expect(users.every((u) => !u.mustChangePassword)).toBe(true);

    const orders = await db.order.findMany({ select: { stage: true, sideState: true, ownerId: true } });
    const at = (stage: string, sideState = 'NONE') => orders.filter((o) => o.stage === stage && o.sideState === sideState).length;
    expect(orders.filter((o) => o.ownerId === null)).toHaveLength(2);
    expect(at('NEW')).toBe(3);
    expect(at('CONTACTED')).toBe(1);
    expect(at('QUOTED')).toBe(2);
    expect(at('SIGNED')).toBe(1);
    expect(at('DEPOSIT_PENDING')).toBe(1);
    expect(at('DEPOSIT_CONFIRMED')).toBe(1);
    expect(at('PUSHED')).toBe(1);
    expect(at('HANDED_OVER')).toBe(1);
    expect(at('QUOTED', 'LOST')).toBe(1);
    expect(at('CONTACTED', 'ON_HOLD')).toBe(1);

    // Dated back from the day it runs, so the lists and the report have something to show.
    const oldest = await db.order.findFirstOrThrow({ orderBy: { leadCreatedAt: 'asc' }, select: { leadCreatedAt: true } });
    expect(oldest.leadCreatedAt.toISOString()).toBe('2026-10-24T00:00:00.000Z');
    expect(await db.document.count({ where: { deletedAt: null } })).toBeGreaterThanOrEqual(15);
  });

  it('leaves a database alone that already has a user', async () => {
    const db = await resetDb();
    await makeUser(['ADMIN']);
    expect(await createDemoData(db)).toBeNull();
    expect(await db.order.count()).toBe(0);
    expect(await db.user.count()).toBe(1);
  });

  it('writes sample files a PDF reader accepts', () => {
    const file = samplePdf(['Signed contract', 'A (sample) file']).toString('latin1');
    expect(file.startsWith('%PDF-1.4\n')).toBe(true);
    expect(file).toContain('(A \\(sample\\) file) Tj');
    // The table at the end must point at where each object really starts.
    const xrefAt = Number(/startxref\n(\d+)\n%%EOF/.exec(file)![1]);
    expect(file.slice(xrefAt, xrefAt + 4)).toBe('xref');
    const offsets = [...file.slice(xrefAt).matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    for (const [i, offset] of offsets.entries()) expect(file.slice(offset, offset + 7)).toBe(`${i + 1} 0 obj`);
  });
});

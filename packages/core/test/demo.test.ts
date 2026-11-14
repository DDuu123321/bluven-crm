import { beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../src';
import { DEMO_PASSWORD, DEMO_USERS, createDemoData, samplePdf } from '../src/services/demo';
import { makeUser, resetDb } from './helpers';

describe('demo data', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('fills an empty database with an account per role and orders at every point, from the pool to a closed job', async () => {
    const db = await resetDb();
    const summary = await createDemoData(db, new Date('2026-11-13T02:00:00Z'));
    expect(summary).toEqual({ users: DEMO_USERS.length, orders: 16 });

    const users = await db.user.findMany();
    expect(users.map((u) => u.email).sort()).toEqual(DEMO_USERS.map((u) => u.email).sort());
    expect(await verifyPassword(DEMO_PASSWORD, users[0]!.passwordHash)).toBe(true);
    expect(users.every((u) => !u.mustChangePassword)).toBe(true);

    const orders = await db.order.findMany({ select: { stage: true, sideState: true, ownerId: true, openedAt: true, leadOriginId: true } });
    const at = (stage: string, sideState = 'NONE') => orders.filter((o) => o.stage === stage && o.sideState === sideState).length;
    expect(orders.filter((o) => o.ownerId === null)).toHaveLength(2);
    // Two in the pool and one that is assigned and waiting to be opened.
    expect(at('NEW')).toBe(3);
    expect(at('FOLLOW_UP')).toBe(1);
    expect(at('DESIGN')).toBe(1);
    expect(at('PROPOSAL_SENT')).toBe(3);
    expect(at('DEPOSIT_PAID')).toBe(2);
    expect(at('PUSHED')).toBe(1);
    expect(at('IN_PROGRESS')).toBe(1);
    expect(at('INSTALLED')).toBe(1);
    expect(at('COMPLETED')).toBe(1);
    expect(at('PROPOSAL_SENT', 'LOST')).toBe(1);
    expect(at('FOLLOW_UP', 'ON_HOLD')).toBe(1);
    // Every job that was opened says where its customer came from.
    expect(orders.filter((o) => o.openedAt)).toHaveLength(13);
    expect(orders.every((o) => !o.openedAt === !o.leadOriginId)).toBe(true);

    // What operations works with is there: the record of each accepted job, and the e-mails queued for its customer.
    expect(await db.opsJob.count()).toBe(3);
    expect((await db.customerNotice.groupBy({ by: ['kind'], _count: { _all: true }, orderBy: { kind: 'asc' } })).map((g) => [g.kind, g._count._all])).toEqual([['JOB_DONE', 2], ['WELCOME', 3]]);
    expect(await db.deposit.count({ where: { status: 'CONFIRMED' } })).toBe(3);
    expect(await db.deposit.count({ where: { status: 'PENDING' } })).toBe(3);

    // Dated back from the day it runs, so the lists and the report have something to show.
    const oldest = await db.order.findFirstOrThrow({ orderBy: { leadCreatedAt: 'asc' }, select: { leadCreatedAt: true } });
    expect(oldest.leadCreatedAt.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(await db.document.count({ where: { deletedAt: null } })).toBeGreaterThanOrEqual(30);
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

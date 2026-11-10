import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IDLE_THRESHOLDS,
  canCancel,
  canHold,
  canMarkLost,
  deriveStage,
  evaluateIdle,
  isOpenOrder,
  stageStepIndex,
  type IdleInput,
  type StageFacts,
} from '../src/domain';

const base: StageFacts = { contacted: false, quoted: false, hasContract: false, deposit: 'NONE', handoff: 'NONE' };

describe('deriveStage', () => {
  it('walks the main line as facts accumulate', () => {
    expect(deriveStage(base)).toBe('NEW');
    expect(deriveStage({ ...base, contacted: true })).toBe('CONTACTED');
    expect(deriveStage({ ...base, contacted: true, quoted: true })).toBe('QUOTED');
    expect(deriveStage({ ...base, contacted: true, quoted: true, hasContract: true })).toBe('SIGNED');
    expect(deriveStage({ ...base, hasContract: true, deposit: 'PENDING' })).toBe('DEPOSIT_PENDING');
    expect(deriveStage({ ...base, hasContract: true, deposit: 'CONFIRMED' })).toBe('DEPOSIT_CONFIRMED');
    expect(deriveStage({ ...base, hasContract: true, deposit: 'CONFIRMED', handoff: 'PENDING' })).toBe('PUSHED');
    expect(deriveStage({ ...base, hasContract: true, deposit: 'CONFIRMED', handoff: 'RETURNED' })).toBe('RETURNED');
    expect(deriveStage({ ...base, hasContract: true, deposit: 'CONFIRMED', handoff: 'ACCEPTED' })).toBe('HANDED_OVER');
  });

  it('skips stages that never happened', () => {
    // Signed without anyone marking the quote as sent.
    expect(deriveStage({ ...base, hasContract: true })).toBe('SIGNED');
    // Quoted without a logged contact.
    expect(deriveStage({ ...base, quoted: true })).toBe('QUOTED');
  });

  it('does not count a deposit until the contract is archived', () => {
    // A gateway payment can arrive before the signed contract does.
    expect(deriveStage({ ...base, quoted: true, deposit: 'PENDING' })).toBe('QUOTED');
    expect(deriveStage({ ...base, quoted: true, deposit: 'CONFIRMED' })).toBe('QUOTED');
    expect(deriveStage({ ...base, quoted: true, deposit: 'CONFIRMED', hasContract: true })).toBe('DEPOSIT_CONFIRMED');
  });

  it('falls back when a fact is withdrawn', () => {
    // Finance rejects the deposit: back to signed.
    expect(deriveStage({ ...base, hasContract: true, deposit: 'NONE' })).toBe('SIGNED');
    // Contract voided: back to quoted.
    expect(deriveStage({ ...base, quoted: true, hasContract: false, deposit: 'CONFIRMED' })).toBe('QUOTED');
  });

  it('keeps a returned order returned while sales fixes it', () => {
    expect(deriveStage({ ...base, hasContract: false, deposit: 'CONFIRMED', handoff: 'RETURNED' })).toBe('RETURNED');
  });
});

describe('stage helpers', () => {
  it('places RETURNED on the same tracker step as PUSHED', () => {
    expect(stageStepIndex('RETURNED')).toBe(stageStepIndex('PUSHED'));
    expect(stageStepIndex('NEW')).toBe(0);
    expect(stageStepIndex('HANDED_OVER')).toBe(7);
  });

  it('knows which orders are in progress', () => {
    expect(isOpenOrder({ stage: 'QUOTED', sideState: 'NONE' })).toBe(true);
    expect(isOpenOrder({ stage: 'QUOTED', sideState: 'ON_HOLD' })).toBe(true);
    expect(isOpenOrder({ stage: 'QUOTED', sideState: 'LOST' })).toBe(false);
    expect(isOpenOrder({ stage: 'DEPOSIT_CONFIRMED', sideState: 'CANCELLED' })).toBe(false);
    expect(isOpenOrder({ stage: 'HANDED_OVER', sideState: 'NONE' })).toBe(false);
  });
});

describe('side state rules', () => {
  it('lost is only for orders without an open deposit', () => {
    expect(canMarkLost({ stage: 'QUOTED', sideState: 'NONE', deposit: 'NONE' }).ok).toBe(true);
    expect(canMarkLost({ stage: 'SIGNED', sideState: 'ON_HOLD', deposit: 'NONE' }).ok).toBe(true);
    expect(canMarkLost({ stage: 'DEPOSIT_PENDING', sideState: 'NONE', deposit: 'PENDING' }).ok).toBe(false);
    expect(canMarkLost({ stage: 'PUSHED', sideState: 'NONE', deposit: 'CONFIRMED' }).ok).toBe(false);
    expect(canMarkLost({ stage: 'QUOTED', sideState: 'LOST', deposit: 'NONE' }).ok).toBe(false);
  });

  it('cancelled is only for orders with an open deposit, before handover', () => {
    expect(canCancel({ stage: 'DEPOSIT_PENDING', sideState: 'NONE', deposit: 'PENDING' }).ok).toBe(true);
    expect(canCancel({ stage: 'PUSHED', sideState: 'NONE', deposit: 'CONFIRMED' }).ok).toBe(true);
    expect(canCancel({ stage: 'RETURNED', sideState: 'NONE', deposit: 'CONFIRMED' }).ok).toBe(true);
    expect(canCancel({ stage: 'SIGNED', sideState: 'NONE', deposit: 'NONE' }).ok).toBe(false);
    expect(canCancel({ stage: 'HANDED_OVER', sideState: 'NONE', deposit: 'CONFIRMED' }).ok).toBe(false);
  });

  it('hold is not available once the order is with operations', () => {
    expect(canHold({ stage: 'CONTACTED', sideState: 'NONE', deposit: 'NONE' }).ok).toBe(true);
    expect(canHold({ stage: 'PUSHED', sideState: 'NONE', deposit: 'CONFIRMED' }).ok).toBe(false);
    expect(canHold({ stage: 'CONTACTED', sideState: 'ON_HOLD', deposit: 'NONE' }).ok).toBe(false);
  });
});

describe('evaluateIdle', () => {
  const now = new Date('2026-11-20T00:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
  const order = (over: Partial<IdleInput>): IdleInput => ({
    stage: 'CONTACTED',
    sideState: 'NONE',
    ownerId: 'usr_1',
    lastStaffActivityAt: daysAgo(0),
    idleLevel: 0,
    ...over,
  });
  const t = DEFAULT_IDLE_THRESHOLDS;

  it('does nothing before five days', () => {
    expect(evaluateIdle(order({ lastStaffActivityAt: daysAgo(4.9) }), now, t)).toBe('NONE');
  });

  it('reminds the owner at five days, once', () => {
    expect(evaluateIdle(order({ lastStaffActivityAt: daysAgo(5) }), now, t)).toBe('REMIND_OWNER');
    expect(evaluateIdle(order({ lastStaffActivityAt: daysAgo(7), idleLevel: 1 }), now, t)).toBe('NONE');
  });

  it('reminds managers at ten days, once', () => {
    expect(evaluateIdle(order({ lastStaffActivityAt: daysAgo(10), idleLevel: 1 }), now, t)).toBe('REMIND_MANAGER');
    expect(evaluateIdle(order({ lastStaffActivityAt: daysAgo(12), idleLevel: 2 }), now, t)).toBe('NONE');
    // Worker was down: the owner reminder was never sent, managers are still told.
    expect(evaluateIdle(order({ lastStaffActivityAt: daysAgo(11), idleLevel: 0 }), now, t)).toBe('REMIND_MANAGER');
  });

  it('returns unsigned orders to the pool at fifteen days', () => {
    for (const stage of ['NEW', 'CONTACTED', 'QUOTED'] as const) {
      expect(evaluateIdle(order({ stage, lastStaffActivityAt: daysAgo(15), idleLevel: 2 }), now, t)).toBe('RETURN_TO_POOL');
    }
  });

  it('never takes a signed order away, it only reminds', () => {
    expect(evaluateIdle(order({ stage: 'SIGNED', lastStaffActivityAt: daysAgo(30), idleLevel: 2 }), now, t)).toBe('NONE');
    expect(evaluateIdle(order({ stage: 'SIGNED', lastStaffActivityAt: daysAgo(30), idleLevel: 1 }), now, t)).toBe('REMIND_MANAGER');
    expect(evaluateIdle(order({ stage: 'RETURNED', lastStaffActivityAt: daysAgo(6) }), now, t)).toBe('REMIND_OWNER');
  });

  it('ignores orders waiting on finance or operations, parked orders and the pool', () => {
    const old = daysAgo(40);
    expect(evaluateIdle(order({ stage: 'DEPOSIT_PENDING', lastStaffActivityAt: old }), now, t)).toBe('NONE');
    expect(evaluateIdle(order({ stage: 'PUSHED', lastStaffActivityAt: old }), now, t)).toBe('NONE');
    expect(evaluateIdle(order({ stage: 'HANDED_OVER', lastStaffActivityAt: old }), now, t)).toBe('NONE');
    expect(evaluateIdle(order({ sideState: 'ON_HOLD', lastStaffActivityAt: old }), now, t)).toBe('NONE');
    expect(evaluateIdle(order({ sideState: 'LOST', lastStaffActivityAt: old }), now, t)).toBe('NONE');
    expect(evaluateIdle(order({ ownerId: null, lastStaffActivityAt: old }), now, t)).toBe('NONE');
  });

  it('honours custom thresholds', () => {
    const custom = { remindOwnerDays: 2, remindManagerDays: 4, returnToPoolDays: 6 };
    expect(evaluateIdle(order({ lastStaffActivityAt: daysAgo(2) }), now, custom)).toBe('REMIND_OWNER');
    expect(evaluateIdle(order({ lastStaffActivityAt: daysAgo(6) }), now, custom)).toBe('RETURN_TO_POOL');
  });
});

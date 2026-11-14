import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IDLE_THRESHOLDS,
  ORDER_STAGES,
  STAGE_HINT,
  STAGE_LABEL,
  addWorkingDays,
  canCancel,
  canHold,
  canMarkLost,
  deriveStage,
  evaluateIdle,
  idleTier,
  isActiveOrder,
  isOpenOrder,
  isSalesEditableStage,
  opsItems,
  stageStepIndex,
  workingDaysBetween,
  type IdleInput,
  type OpsJobFacts,
  type StageFacts,
} from '../src/domain';

const base: StageFacts = { opened: false, designing: false, proposalSent: false, deposit: 'NONE', handoff: 'NONE', jobDone: false, completed: false };
const open: StageFacts = { ...base, opened: true };

describe('deriveStage', () => {
  it('walks the main line as facts accumulate', () => {
    expect(deriveStage(base)).toBe('NEW');
    expect(deriveStage(open)).toBe('FOLLOW_UP');
    expect(deriveStage({ ...open, designing: true })).toBe('DESIGN');
    expect(deriveStage({ ...open, designing: true, proposalSent: true })).toBe('PROPOSAL_SENT');
    expect(deriveStage({ ...open, proposalSent: true, deposit: 'PENDING' })).toBe('DEPOSIT_PAID');
    expect(deriveStage({ ...open, proposalSent: true, deposit: 'PENDING', handoff: 'PENDING' })).toBe('PUSHED');
    expect(deriveStage({ ...open, proposalSent: true, deposit: 'PENDING', handoff: 'RETURNED' })).toBe('RETURNED');
    expect(deriveStage({ ...open, proposalSent: true, deposit: 'CONFIRMED', handoff: 'ACCEPTED' })).toBe('IN_PROGRESS');
    expect(deriveStage({ ...open, proposalSent: true, deposit: 'CONFIRMED', handoff: 'ACCEPTED', jobDone: true })).toBe('INSTALLED');
    expect(deriveStage({ ...open, proposalSent: true, deposit: 'CONFIRMED', handoff: 'ACCEPTED', jobDone: true, completed: true })).toBe('COMPLETED');
  });

  it('skips stages that never happened', () => {
    // A proposal sent without anyone saying that the design had started.
    expect(deriveStage({ ...open, proposalSent: true })).toBe('PROPOSAL_SENT');
    // A deposit without a proposal on record: the money counts.
    expect(deriveStage({ ...open, deposit: 'PENDING' })).toBe('DEPOSIT_PAID');
    // It does not matter whether operations has confirmed the deposit yet.
    expect(deriveStage({ ...open, deposit: 'CONFIRMED' })).toBe('DEPOSIT_PAID');
  });

  it('counts nothing before the job has been opened', () => {
    // Pylon knows an order by its number: a design or a payment can reach it before anyone takes the job up.
    expect(deriveStage({ ...base, designing: true })).toBe('NEW');
    expect(deriveStage({ ...base, designing: true, proposalSent: true })).toBe('NEW');
    expect(deriveStage({ ...base, deposit: 'PENDING' })).toBe('NEW');
    // Opening it puts the order where its facts say.
    expect(deriveStage({ ...open, designing: true, deposit: 'PENDING' })).toBe('DEPOSIT_PAID');
  });

  it('falls back when a fact is withdrawn', () => {
    // The deposit record is withdrawn: back to the proposal.
    expect(deriveStage({ ...open, designing: true, proposalSent: true, deposit: 'NONE' })).toBe('PROPOSAL_SENT');
    // The salesperson says the customer is not ready for a design after all.
    expect(deriveStage({ ...open, designing: false })).toBe('FOLLOW_UP');
  });

  it('follows operations: back with sales when returned, also after it had been accepted', () => {
    expect(deriveStage({ ...open, deposit: 'CONFIRMED', handoff: 'RETURNED' })).toBe('RETURNED');
    // A job cannot be done or closed while the order is back with sales.
    expect(deriveStage({ ...open, deposit: 'CONFIRMED', handoff: 'RETURNED', jobDone: true })).toBe('RETURNED');
    // Closed needs the job to have been done only in so far as the page asks for it; the facts decide.
    expect(deriveStage({ ...open, deposit: 'CONFIRMED', handoff: 'ACCEPTED', completed: true })).toBe('COMPLETED');
  });
});

describe('stage helpers', () => {
  it('has a label and a sentence for every stage', () => {
    for (const stage of ORDER_STAGES) {
      expect(STAGE_LABEL[stage]).toBeTruthy();
      expect(STAGE_HINT[stage]).toBeTruthy();
    }
  });

  it('places RETURNED on the same tracker step as PUSHED', () => {
    expect(stageStepIndex('RETURNED')).toBe(stageStepIndex('PUSHED'));
    expect(stageStepIndex('NEW')).toBe(0);
    expect(stageStepIndex('COMPLETED')).toBe(8);
  });

  it('knows which orders are still being sold, and which are still being worked on at all', () => {
    expect(isOpenOrder({ stage: 'PROPOSAL_SENT', sideState: 'NONE' })).toBe(true);
    expect(isOpenOrder({ stage: 'PROPOSAL_SENT', sideState: 'ON_HOLD' })).toBe(true);
    expect(isOpenOrder({ stage: 'PROPOSAL_SENT', sideState: 'LOST' })).toBe(false);
    expect(isOpenOrder({ stage: 'DEPOSIT_PAID', sideState: 'CANCELLED' })).toBe(false);
    expect(isOpenOrder({ stage: 'PUSHED', sideState: 'NONE' })).toBe(true);
    // Once operations has accepted it, the sale is made.
    expect(isOpenOrder({ stage: 'IN_PROGRESS', sideState: 'NONE' })).toBe(false);
    expect(isOpenOrder({ stage: 'INSTALLED', sideState: 'NONE' })).toBe(false);
    expect(isActiveOrder({ stage: 'IN_PROGRESS', sideState: 'NONE' })).toBe(true);
    expect(isActiveOrder({ stage: 'INSTALLED', sideState: 'NONE' })).toBe(true);
    expect(isActiveOrder({ stage: 'COMPLETED', sideState: 'NONE' })).toBe(false);
    expect(isActiveOrder({ stage: 'IN_PROGRESS', sideState: 'CANCELLED' })).toBe(false);
  });

  it('lets sales change an order until operations has it', () => {
    expect(['NEW', 'FOLLOW_UP', 'DESIGN', 'PROPOSAL_SENT', 'DEPOSIT_PAID', 'RETURNED'].every((s) => isSalesEditableStage(s as never))).toBe(true);
    expect(['PUSHED', 'IN_PROGRESS', 'INSTALLED', 'COMPLETED'].some((s) => isSalesEditableStage(s as never))).toBe(false);
  });
});

describe('side state rules', () => {
  it('lost is only for orders without an open deposit', () => {
    expect(canMarkLost({ stage: 'NEW', sideState: 'NONE', deposit: 'NONE' }).ok).toBe(true);
    expect(canMarkLost({ stage: 'PROPOSAL_SENT', sideState: 'NONE', deposit: 'NONE' }).ok).toBe(true);
    expect(canMarkLost({ stage: 'FOLLOW_UP', sideState: 'ON_HOLD', deposit: 'NONE' }).ok).toBe(true);
    expect(canMarkLost({ stage: 'DEPOSIT_PAID', sideState: 'NONE', deposit: 'PENDING' }).ok).toBe(false);
    expect(canMarkLost({ stage: 'PUSHED', sideState: 'NONE', deposit: 'PENDING' }).ok).toBe(false);
    expect(canMarkLost({ stage: 'IN_PROGRESS', sideState: 'NONE', deposit: 'CONFIRMED' }).ok).toBe(false);
    expect(canMarkLost({ stage: 'PROPOSAL_SENT', sideState: 'LOST', deposit: 'NONE' }).ok).toBe(false);
  });

  it('cancelled is only for orders with an open deposit, until the installation is done', () => {
    expect(canCancel({ stage: 'DEPOSIT_PAID', sideState: 'NONE', deposit: 'PENDING' }).ok).toBe(true);
    expect(canCancel({ stage: 'PUSHED', sideState: 'NONE', deposit: 'PENDING' }).ok).toBe(true);
    expect(canCancel({ stage: 'RETURNED', sideState: 'NONE', deposit: 'CONFIRMED' }).ok).toBe(true);
    expect(canCancel({ stage: 'IN_PROGRESS', sideState: 'NONE', deposit: 'CONFIRMED' }).ok).toBe(true);
    expect(canCancel({ stage: 'PROPOSAL_SENT', sideState: 'NONE', deposit: 'NONE' }).ok).toBe(false);
    expect(canCancel({ stage: 'INSTALLED', sideState: 'NONE', deposit: 'CONFIRMED' }).ok).toBe(false);
    expect(canCancel({ stage: 'COMPLETED', sideState: 'NONE', deposit: 'CONFIRMED' }).ok).toBe(false);
  });

  it('hold is not available once the order is with operations', () => {
    expect(canHold({ stage: 'FOLLOW_UP', sideState: 'NONE', deposit: 'NONE' }).ok).toBe(true);
    expect(canHold({ stage: 'PUSHED', sideState: 'NONE', deposit: 'PENDING' }).ok).toBe(false);
    expect(canHold({ stage: 'IN_PROGRESS', sideState: 'NONE', deposit: 'CONFIRMED' }).ok).toBe(false);
    expect(canHold({ stage: 'RETURNED', sideState: 'NONE', deposit: 'CONFIRMED' }).ok).toBe(false);
    expect(canHold({ stage: 'FOLLOW_UP', sideState: 'ON_HOLD', deposit: 'NONE' }).ok).toBe(false);
  });
});

describe('evaluateIdle', () => {
  const now = new Date('2026-11-20T00:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
  const order = (over: Partial<IdleInput>): IdleInput => ({
    stage: 'FOLLOW_UP',
    sideState: 'NONE',
    ownerId: 'usr_1',
    lastStaffActivityAt: daysAgo(0),
    idleLevel: 0,
    ...over,
  });
  const t = DEFAULT_IDLE_THRESHOLDS;

  it('starts from five, eight and ten days', () => {
    expect(t).toEqual({ remindOwnerDays: 5, remindManagerDays: 8, returnToPoolDays: 10 });
  });

  it('does nothing before five days', () => {
    expect(evaluateIdle(order({ lastStaffActivityAt: daysAgo(4.9) }), now, t)).toBe('NONE');
  });

  it('reminds the owner at five days, once', () => {
    expect(evaluateIdle(order({ lastStaffActivityAt: daysAgo(5) }), now, t)).toBe('REMIND_OWNER');
    expect(evaluateIdle(order({ lastStaffActivityAt: daysAgo(7), idleLevel: 1 }), now, t)).toBe('NONE');
  });

  it('tells the managers at eight days, once', () => {
    expect(evaluateIdle(order({ lastStaffActivityAt: daysAgo(8), idleLevel: 1 }), now, t)).toBe('REMIND_MANAGER');
    expect(evaluateIdle(order({ lastStaffActivityAt: daysAgo(9), idleLevel: 2 }), now, t)).toBe('NONE');
    // Worker was down: the owner reminder was never sent, managers are still told.
    expect(evaluateIdle(order({ lastStaffActivityAt: daysAgo(9), idleLevel: 0 }), now, t)).toBe('REMIND_MANAGER');
  });

  it('takes orders without a deposit back into the pool at ten days, whatever point they had reached', () => {
    for (const stage of ['NEW', 'FOLLOW_UP', 'DESIGN', 'PROPOSAL_SENT'] as const) {
      expect(evaluateIdle(order({ stage, lastStaffActivityAt: daysAgo(10), idleLevel: 2 }), now, t)).toBe('RETURN_TO_POOL');
    }
  });

  it('never takes an order with a deposit away, it only reminds', () => {
    expect(evaluateIdle(order({ stage: 'DEPOSIT_PAID', lastStaffActivityAt: daysAgo(30), idleLevel: 2 }), now, t)).toBe('NONE');
    expect(evaluateIdle(order({ stage: 'DEPOSIT_PAID', lastStaffActivityAt: daysAgo(30), idleLevel: 1 }), now, t)).toBe('REMIND_MANAGER');
    expect(evaluateIdle(order({ stage: 'RETURNED', lastStaffActivityAt: daysAgo(6) }), now, t)).toBe('REMIND_OWNER');
  });

  it('ignores orders that are with operations, parked orders and the pool', () => {
    const old = daysAgo(40);
    for (const stage of ['PUSHED', 'IN_PROGRESS', 'INSTALLED', 'COMPLETED'] as const) {
      expect(evaluateIdle(order({ stage, lastStaffActivityAt: old }), now, t)).toBe('NONE');
      expect(idleTier(order({ stage, lastStaffActivityAt: old }), now, t)).toBe(0);
    }
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

describe('what operations arranges', () => {
  const nothing: OpsJobFacts = { caStatus: 'TODO', caReference: '', stcPlatform: null, stcReference: '', installerName: '', electricianLicence: '', installDate: null, deliveryMode: null, deliveryEta: null, purchaseStatus: 'UNDECIDED' };
  const done = (job: OpsJobFacts) => Object.fromEntries(opsItems(job).map((i) => [i.key, i.done]));

  it('starts with six open items', () => {
    expect(opsItems(nothing).map((i) => i.key)).toEqual(['ca', 'stc', 'installer', 'installDate', 'delivery', 'purchase']);
    expect(Object.values(done(nothing))).toEqual([false, false, false, false, false, false]);
  });

  it('settles each item by its own rule, in any order', () => {
    // An approval that is not needed is as settled as one that was granted; one applied for is not.
    expect(done({ ...nothing, caStatus: 'NOT_REQUIRED' }).ca).toBe(true);
    expect(done({ ...nothing, caStatus: 'APPROVED' }).ca).toBe(true);
    expect(done({ ...nothing, caStatus: 'APPLIED' }).ca).toBe(false);
    expect(done({ ...nothing, stcPlatform: 'greendeal' }).stc).toBe(true);
    // The installer counts once the licence number is there too.
    expect(done({ ...nothing, installerName: 'Joe Volt' }).installer).toBe(false);
    expect(done({ ...nothing, installerName: 'Joe Volt', electricianLicence: 'EC 12345' }).installer).toBe(true);
    expect(done({ ...nothing, installDate: new Date('2026-12-12T00:00:00Z') }).installDate).toBe(true);
    // A delivery needs its day; a pickup by the installer does not.
    expect(done({ ...nothing, deliveryMode: 'DELIVERY' }).delivery).toBe(false);
    expect(done({ ...nothing, deliveryMode: 'DELIVERY', deliveryEta: new Date('2026-12-10T00:00:00Z') }).delivery).toBe(true);
    expect(done({ ...nothing, deliveryMode: 'PICKUP' }).delivery).toBe(true);
    // Stock that is there needs no order; stock that has to be ordered is open until it is.
    expect(done({ ...nothing, purchaseStatus: 'IN_STOCK' }).purchase).toBe(true);
    expect(done({ ...nothing, purchaseStatus: 'TO_ORDER' }).purchase).toBe(false);
    expect(done({ ...nothing, purchaseStatus: 'ORDERED' }).purchase).toBe(true);
  });

  it('says what is on record in words', () => {
    const items = opsItems({ ...nothing, caStatus: 'APPLIED', caReference: 'AUS-991', stcPlatform: 'formbay', installerName: 'Joe Volt', electricianLicence: 'EC 12345', installDate: new Date('2026-12-12T00:00:00Z'), deliveryMode: 'DELIVERY', deliveryEta: new Date('2026-12-10T00:00:00Z'), purchaseStatus: 'ORDERED' });
    expect(items.map((i) => i.detail)).toEqual(['Applied for (AUS-991)', 'Formbay', 'Joe Volt, licence EC 12345', '12 Dec 2026', 'Expected on site 10 Dec 2026', 'Ordered']);
    // A value nobody recognises is shown as not done rather than believed.
    expect(opsItems({ ...nothing, caStatus: 'DONE', stcPlatform: 'somewhere', purchaseStatus: 'YES' }).every((i) => !i.done)).toBe(true);
  });
});

describe('working days', () => {
  const day = (s: string) => new Date(`${s}T00:00:00Z`);

  it('skips Saturdays and Sundays', () => {
    // 2026-11-20 is a Friday.
    expect(addWorkingDays(day('2026-11-20'), 1)).toEqual(day('2026-11-23'));
    expect(addWorkingDays(day('2026-11-20'), 2)).toEqual(day('2026-11-24'));
    expect(addWorkingDays(day('2026-11-20'), 5)).toEqual(day('2026-11-27'));
    expect(addWorkingDays(day('2026-11-16'), 5)).toEqual(day('2026-11-23'));
    // Counted from a weekend, the first working day is the Monday.
    expect(addWorkingDays(day('2026-11-21'), 1)).toEqual(day('2026-11-23'));
    expect(addWorkingDays(day('2026-11-20'), 0)).toEqual(day('2026-11-20'));
  });

  it('counts the working days that have passed', () => {
    expect(workingDaysBetween(day('2026-11-20'), day('2026-11-20'))).toBe(0);
    expect(workingDaysBetween(day('2026-11-20'), day('2026-11-22'))).toBe(0);
    expect(workingDaysBetween(day('2026-11-20'), day('2026-11-23'))).toBe(1);
    expect(workingDaysBetween(day('2026-11-20'), day('2026-11-27'))).toBe(5);
    expect(workingDaysBetween(day('2026-11-27'), day('2026-11-20'))).toBe(0);
    // The two agree: n working days after a day, n have passed.
    for (const n of [1, 2, 3, 7, 12]) expect(workingDaysBetween(day('2026-11-18'), addWorkingDays(day('2026-11-18'), n))).toBe(n);
  });
});

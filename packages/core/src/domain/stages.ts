// Order stages and the rules that hang off them. Pure functions, safe for browser code.

export const ORDER_STAGES = [
  'NEW',
  'FOLLOW_UP',
  'DESIGN',
  'PROPOSAL_SENT',
  'DEPOSIT_PAID',
  'PUSHED',
  'RETURNED',
  'IN_PROGRESS',
  'INSTALLED',
  'COMPLETED',
] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];

export const SIDE_STATES = ['NONE', 'LOST', 'ON_HOLD', 'CANCELLED'] as const;
export type SideState = (typeof SIDE_STATES)[number];

export const STAGE_LABEL: Record<OrderStage, string> = {
  NEW: 'New',
  FOLLOW_UP: 'Following up',
  DESIGN: 'Design',
  PROPOSAL_SENT: 'Proposal sent',
  DEPOSIT_PAID: 'Deposit paid',
  PUSHED: 'Pushed to Ops',
  RETURNED: 'Returned by Ops',
  IN_PROGRESS: 'With operations',
  INSTALLED: 'Installed, balance due',
  COMPLETED: 'Completed',
};

/** What each stage means, in a sentence, for pages that explain where an order stands. */
export const STAGE_HINT: Record<OrderStage, string> = {
  NEW: 'Nobody has opened this job yet.',
  FOLLOW_UP: 'The customer is being followed up.',
  DESIGN: 'The customer wants a proposal: the system is being designed in Pylon.',
  PROPOSAL_SENT: 'The proposal is with the customer. Keep following up until the deposit is paid.',
  DEPOSIT_PAID: 'The deposit is paid. Complete the folder and push the order to operations.',
  PUSHED: 'Waiting for operations to accept the order.',
  RETURNED: 'Operations sent the order back. See their reason, then push it again.',
  IN_PROGRESS: 'Operations is arranging the installation.',
  INSTALLED: 'The job is done. Waiting for the final payment.',
  COMPLETED: 'The final payment has arrived and the job is closed.',
};

export const SIDE_STATE_LABEL: Record<SideState, string> = {
  NONE: 'Active',
  LOST: 'Lost',
  ON_HOLD: 'On hold',
  CANCELLED: 'Cancelled',
};

/** The facts a stage is derived from. */
export interface StageFacts {
  /** The salesperson has opened the job. */
  opened: boolean;
  /** The customer's intent is clear and the design has started. */
  designing: boolean;
  /** A proposal has been sent to the customer. */
  proposalSent: boolean;
  /** State of the open deposit, if any. Rejected and withdrawn deposits count as NONE. */
  deposit: 'NONE' | 'PENDING' | 'CONFIRMED';
  /** Decision on the most recent handoff package. Withdrawn packages count as NONE. */
  handoff: 'NONE' | 'PENDING' | 'RETURNED' | 'ACCEPTED';
  /** Operations has marked the installation as done. */
  jobDone: boolean;
  /** The final payment has arrived. */
  completed: boolean;
}

/**
 * The single source of truth for an order's stage.
 *
 * Deriving the stage from facts (rather than nudging it forward event by event) keeps it correct
 * when events arrive out of order, when a deposit record is withdrawn, or when operations sends
 * an order back.
 */
export function deriveStage(f: StageFacts): OrderStage {
  if (f.handoff === 'ACCEPTED') {
    if (f.completed) return 'COMPLETED';
    return f.jobDone ? 'INSTALLED' : 'IN_PROGRESS';
  }
  if (f.handoff === 'PENDING') return 'PUSHED';
  if (f.handoff === 'RETURNED') return 'RETURNED';
  // Nothing counts before the job has been opened. A design or a payment that reached the order
  // from outside (Pylon knows the order by its number) waits there until someone takes the job up.
  if (!f.opened) return 'NEW';
  if (f.deposit !== 'NONE') return 'DEPOSIT_PAID';
  if (f.proposalSent) return 'PROPOSAL_SENT';
  return f.designing ? 'DESIGN' : 'FOLLOW_UP';
}

/** Position on the progress tracker. RETURNED shares a step with PUSHED. */
export const STAGE_STEPS: { key: OrderStage; label: string }[] = [
  { key: 'NEW', label: 'New' },
  { key: 'FOLLOW_UP', label: 'Following up' },
  { key: 'DESIGN', label: 'Design' },
  { key: 'PROPOSAL_SENT', label: 'Proposal sent' },
  { key: 'DEPOSIT_PAID', label: 'Deposit paid' },
  { key: 'PUSHED', label: 'Pushed' },
  { key: 'IN_PROGRESS', label: 'With operations' },
  { key: 'INSTALLED', label: 'Installed' },
  { key: 'COMPLETED', label: 'Completed' },
];

export function stageStepIndex(stage: OrderStage): number {
  const key = stage === 'RETURNED' ? 'PUSHED' : stage;
  return STAGE_STEPS.findIndex((s) => s.key === key);
}

const SALES_EDITABLE: ReadonlySet<OrderStage> = new Set(['NEW', 'FOLLOW_UP', 'DESIGN', 'PROPOSAL_SENT', 'DEPOSIT_PAID', 'RETURNED']);

/** Stages in which the sales side may still change the order's content. */
export function isSalesEditableStage(stage: OrderStage): boolean {
  return SALES_EDITABLE.has(stage);
}

/** The stages after operations has accepted an order, for filters. */
export const OPERATIONS_STAGES: OrderStage[] = ['IN_PROGRESS', 'INSTALLED', 'COMPLETED'];

/** Operations has accepted the order: the sale is made, and what happens next is theirs. */
export function isWithOperations(stage: OrderStage): boolean {
  return OPERATIONS_STAGES.includes(stage);
}

const IDLE_TRACKED: ReadonlySet<OrderStage> = SALES_EDITABLE;

/** Stages in which the ball is in the salesperson's court. Waiting on operations does not count. */
export function isIdleTrackedStage(stage: OrderStage): boolean {
  return IDLE_TRACKED.has(stage);
}

const AUTO_RETURN: ReadonlySet<OrderStage> = new Set(['NEW', 'FOLLOW_UP', 'DESIGN', 'PROPOSAL_SENT']);

/** Only orders without a deposit are taken back into the pool automatically. */
export function isAutoReturnStage(stage: OrderStage): boolean {
  return AUTO_RETURN.has(stage);
}

/** "In progress" for sales: not lost, not cancelled and not yet accepted by operations. */
export function isOpenOrder(o: { stage: OrderStage; sideState: SideState }): boolean {
  return o.sideState !== 'LOST' && o.sideState !== 'CANCELLED' && !isWithOperations(o.stage);
}

/** Still being worked on by anyone: not lost, not cancelled and not completed. */
export function isActiveOrder(o: { stage: OrderStage; sideState: SideState }): boolean {
  return o.sideState !== 'LOST' && o.sideState !== 'CANCELLED' && o.stage !== 'COMPLETED';
}

export type Check = { ok: true } | { ok: false; reason: string };
const ok: Check = { ok: true };
const no = (reason: string): Check => ({ ok: false, reason });

export interface SideStateInput {
  stage: OrderStage;
  sideState: SideState;
  deposit: StageFacts['deposit'];
}

/** Lost is for orders that have no open deposit. */
export function canMarkLost(o: SideStateInput): Check {
  if (o.sideState === 'LOST') return no('This order is already marked as lost.');
  if (o.sideState === 'CANCELLED') return no('This order has been cancelled.');
  if (o.stage === 'PUSHED' || isWithOperations(o.stage)) return no('This order is with operations.');
  if (o.deposit !== 'NONE') {
    return no('A deposit has been recorded for this order. Cancel the order instead of marking it lost.');
  }
  return ok;
}

/** Cancelled is for orders that already have a deposit on record. */
export function canCancel(o: SideStateInput): Check {
  if (o.sideState === 'CANCELLED') return no('This order is already cancelled.');
  if (o.sideState === 'LOST') return no('This order is marked as lost.');
  if (o.stage === 'INSTALLED' || o.stage === 'COMPLETED') return no('The installation is done. This order can no longer be cancelled.');
  if (o.deposit === 'NONE') {
    return no('No deposit has been recorded for this order. Mark it as lost instead of cancelling it.');
  }
  return ok;
}

export function canHold(o: SideStateInput): Check {
  if (o.sideState !== 'NONE') return no(`This order is ${SIDE_STATE_LABEL[o.sideState].toLowerCase()}.`);
  if (o.stage === 'PUSHED' || isWithOperations(o.stage)) return no('This order is with operations.');
  // Once an order has been to operations it is not parked: what they asked for gets fixed and it goes back.
  if (o.stage === 'RETURNED') return no('This order came back from operations. Fix what they asked for and push it again.');
  return ok;
}

export function canResume(o: SideStateInput): Check {
  return o.sideState === 'ON_HOLD' ? ok : no('This order is not on hold.');
}

export function canRestore(o: SideStateInput): Check {
  return o.sideState === 'LOST' ? ok : no('This order is not marked as lost.');
}

// ---------------------------------------------------------------------------
// Idle rules
// ---------------------------------------------------------------------------

export interface IdleThresholds {
  remindOwnerDays: number;
  remindManagerDays: number;
  returnToPoolDays: number;
}

export const DEFAULT_IDLE_THRESHOLDS: IdleThresholds = {
  remindOwnerDays: 5,
  remindManagerDays: 8,
  returnToPoolDays: 10,
};

export type IdleAction = 'NONE' | 'REMIND_OWNER' | 'REMIND_MANAGER' | 'RETURN_TO_POOL';

export interface IdleInput {
  stage: OrderStage;
  sideState: SideState;
  ownerId: string | null;
  lastStaffActivityAt: Date;
  /** 0 = nothing sent, 1 = owner reminded, 2 = managers reminded. */
  idleLevel: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function idleDays(lastStaffActivityAt: Date, now: Date): number {
  return (now.getTime() - lastStaffActivityAt.getTime()) / DAY_MS;
}

/** What the idle rules call for right now. Returns the most severe action that has not been taken yet. */
export function evaluateIdle(o: IdleInput, now: Date, t: IdleThresholds): IdleAction {
  if (!o.ownerId) return 'NONE';
  if (o.sideState !== 'NONE') return 'NONE';
  if (!isIdleTrackedStage(o.stage)) return 'NONE';
  const days = idleDays(o.lastStaffActivityAt, now);
  if (days >= t.returnToPoolDays && isAutoReturnStage(o.stage)) return 'RETURN_TO_POOL';
  if (days >= t.remindManagerDays && o.idleLevel < 2) return 'REMIND_MANAGER';
  if (days >= t.remindOwnerDays && o.idleLevel < 1) return 'REMIND_OWNER';
  return 'NONE';
}

/**
 * How idle an order is, for every list and figure that shows it: 0 not idle, 1 past the day the
 * salesperson is reminded, 2 past the day the managers are told, 3 past the day an order without a
 * deposit goes back to the pool. Counted from the last staff activity, whether or not a reminder has
 * gone out yet, so a figure never depends on when the reminder job last ran.
 */
export type IdleTier = 0 | 1 | 2 | 3;

export function idleTier(o: Pick<IdleInput, 'stage' | 'sideState' | 'ownerId' | 'lastStaffActivityAt'>, now: Date, t: IdleThresholds): IdleTier {
  if (!o.ownerId || o.sideState !== 'NONE' || !isIdleTrackedStage(o.stage)) return 0;
  const days = idleDays(o.lastStaffActivityAt, now);
  if (days >= t.returnToPoolDays) return 3;
  if (days >= t.remindManagerDays) return 2;
  return days >= t.remindOwnerDays ? 1 : 0;
}

/** The number of idle days at which each tier starts. */
export function idleTierDays(t: IdleThresholds): [owner: number, manager: number, pool: number] {
  return [t.remindOwnerDays, t.remindManagerDays, t.returnToPoolDays];
}

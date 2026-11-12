// Notification kinds: the many machine-readable notification types, grouped into a few plain
// categories people can filter by. Pure, safe for browser code.

export const NOTIFICATION_KINDS = ['leads', 'idle', 'deposits', 'handoff', 'tasks', 'documents', 'pylon', 'other'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  leads: 'Leads & assignments',
  idle: 'Idle reminders',
  deposits: 'Deposits',
  handoff: 'Handoff',
  tasks: 'Tasks',
  documents: 'Documents',
  pylon: 'Pylon',
  other: 'Other',
};

export interface NotificationKindRule {
  /** Types that belong to the kind by name. */
  types: readonly string[];
  /** Type prefixes that belong to the kind, so a new type in a family lands in the right place by itself. */
  prefixes: readonly string[];
}

/**
 * Which notification types make up each kind. A name listed here wins over any prefix. Whatever
 * matches nothing is "other", so a type nobody has classified yet never drops out of view.
 */
export const NOTIFICATION_KIND_RULES: Record<Exclude<NotificationKind, 'other'>, NotificationKindRule> = {
  leads: { types: ['order.assigned', 'order.unassigned', 'order.possible_duplicate'], prefixes: ['pool.', 'lead.', 'intake.'] },
  idle: { types: ['order.idle_owner', 'order.idle_manager', 'order.idle_returned'], prefixes: [] },
  deposits: { types: [], prefixes: ['deposit.', 'refund.'] },
  handoff: { types: [], prefixes: ['handoff.'] },
  tasks: { types: ['order.hold_ended'], prefixes: ['task.'] },
  documents: { types: [], prefixes: ['retention.'] },
  pylon: { types: [], prefixes: ['pylon.'] },
};

const CLASSIFIED = Object.entries(NOTIFICATION_KIND_RULES) as [Exclude<NotificationKind, 'other'>, NotificationKindRule][];

/** The kind a notification type belongs to. */
export function notificationKind(type: string): NotificationKind {
  for (const [kind, rule] of CLASSIFIED) if (rule.types.includes(type)) return kind;
  for (const [kind, rule] of CLASSIFIED) if (rule.prefixes.some((prefix) => type.startsWith(prefix))) return kind;
  return 'other';
}

// What operations keeps track of between accepting an order and closing the job, and the
// working-day arithmetic for the reminders after the installation. Pure functions, safe for
// browser code.

export const CA_STATUSES = ['TODO', 'APPLIED', 'APPROVED', 'NOT_REQUIRED'] as const;
export type CaStatus = (typeof CA_STATUSES)[number];
export const CA_STATUS_LABEL: Record<CaStatus, string> = {
  TODO: 'Not applied for yet',
  APPLIED: 'Applied for',
  APPROVED: 'Approved',
  NOT_REQUIRED: 'Not needed for this job',
};

/** Where a job is assigned for its certificates. */
export const STC_PLATFORMS = ['formbay', 'greendeal', 'bridgeselect', 'other'] as const;
export type StcPlatform = (typeof STC_PLATFORMS)[number];
export const STC_PLATFORM_LABEL: Record<StcPlatform, string> = {
  formbay: 'Formbay',
  greendeal: 'GreenDeal',
  bridgeselect: 'Bridge Select',
  other: 'Another platform',
};

export const DELIVERY_MODES = ['DELIVERY', 'PICKUP'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];
export const DELIVERY_MODE_LABEL: Record<DeliveryMode, string> = {
  DELIVERY: 'Delivered to the site',
  PICKUP: 'The installer picks it up',
};

export const PURCHASE_STATUSES = ['UNDECIDED', 'IN_STOCK', 'TO_ORDER', 'ORDERED'] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];
export const PURCHASE_STATUS_LABEL: Record<PurchaseStatus, string> = {
  UNDECIDED: 'Not checked yet',
  IN_STOCK: 'In stock, nothing to buy',
  TO_ORDER: 'Has to be ordered',
  ORDERED: 'Ordered',
};

/** The part of the operations record the list of items is worked out from. */
export interface OpsJobFacts {
  caStatus: string;
  caReference: string;
  stcPlatform: string | null;
  stcReference: string;
  installerName: string;
  electricianLicence: string;
  installDate: Date | null;
  deliveryMode: string | null;
  deliveryEta: Date | null;
  purchaseStatus: string;
}

export const OPS_ITEM_KEYS = ['ca', 'stc', 'installer', 'installDate', 'delivery', 'purchase'] as const;
export type OpsItemKey = (typeof OPS_ITEM_KEYS)[number];

export interface OpsItem {
  key: OpsItemKey;
  label: string;
  done: boolean;
  /** What is on record, or what is still open. */
  detail: string;
}

const isOneOf = <T extends string>(list: readonly T[], value: string | null): value is T => value !== null && (list as readonly string[]).includes(value);

const dateOnly = (d: Date): string =>
  new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);

/**
 * The things operations arranges for a job, each with whether it is settled. They are worked on
 * side by side: none of them waits for another.
 */
export function opsItems(job: OpsJobFacts): OpsItem[] {
  const ca = isOneOf(CA_STATUSES, job.caStatus) ? job.caStatus : 'TODO';
  const platform = isOneOf(STC_PLATFORMS, job.stcPlatform) ? job.stcPlatform : null;
  const delivery = isOneOf(DELIVERY_MODES, job.deliveryMode) ? job.deliveryMode : null;
  const purchase = isOneOf(PURCHASE_STATUSES, job.purchaseStatus) ? job.purchaseStatus : 'UNDECIDED';
  const installer = job.installerName.trim();
  const licence = job.electricianLicence.trim();
  return [
    {
      key: 'ca',
      label: 'Connection approval',
      done: ca === 'APPROVED' || ca === 'NOT_REQUIRED',
      detail: `${CA_STATUS_LABEL[ca]}${job.caReference.trim() ? ` (${job.caReference.trim()})` : ''}`,
    },
    {
      key: 'stc',
      label: 'Job assigned for the certificates',
      done: !!platform,
      detail: platform ? `${STC_PLATFORM_LABEL[platform]}${job.stcReference.trim() ? ` (${job.stcReference.trim()})` : ''}` : 'Not assigned yet',
    },
    {
      key: 'installer',
      label: 'Installer',
      done: !!installer && !!licence,
      detail: installer ? `${installer}${licence ? `, licence ${licence}` : ', licence number missing'}` : 'Not chosen yet',
    },
    {
      key: 'installDate',
      label: 'Installation date',
      done: !!job.installDate,
      detail: job.installDate ? dateOnly(job.installDate) : 'Not booked yet',
    },
    {
      key: 'delivery',
      label: 'Delivery',
      done: delivery === 'PICKUP' || (delivery === 'DELIVERY' && !!job.deliveryEta),
      detail:
        delivery === 'PICKUP'
          ? DELIVERY_MODE_LABEL.PICKUP
          : delivery === 'DELIVERY'
            ? job.deliveryEta
              ? `Expected on site ${dateOnly(job.deliveryEta)}`
              : 'To be delivered, day not known yet'
            : 'Not arranged yet',
    },
    {
      key: 'purchase',
      label: 'Stock',
      done: purchase === 'IN_STOCK' || purchase === 'ORDERED',
      detail: PURCHASE_STATUS_LABEL[purchase],
    },
  ];
}

/** The automatic e-mails to the customer, in the order they go out. */
export const NOTICE_KINDS = ['WELCOME', 'SCHEDULE', 'JOB_DONE'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
export const NOTICE_KIND_LABEL: Record<NoticeKind, string> = {
  WELCOME: 'Welcome',
  SCHEDULE: 'Installation and delivery dates',
  JOB_DONE: 'Thank you and balance',
};

// ---------------------------------------------------------------------------
// Working days
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Saturday or Sunday, for a date written as midnight UTC. Public holidays are not known here and count as working days. */
function isWeekend(day: Date): boolean {
  const weekday = day.getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * The day that lies a number of working days after another. Both are dates without a time,
 * written as midnight UTC. Saturdays and Sundays are skipped; public holidays are not.
 */
export function addWorkingDays(day: Date, workingDays: number): Date {
  let out = new Date(day.getTime());
  for (let left = Math.max(0, Math.floor(workingDays)); left > 0; ) {
    out = new Date(out.getTime() + DAY_MS);
    if (!isWeekend(out)) left--;
  }
  return out;
}

/** How many working days lie after the first day, up to and including the second. Zero when the second is not later. */
export function workingDaysBetween(from: Date, to: Date): number {
  let count = 0;
  for (let day = new Date(from.getTime() + DAY_MS); day.getTime() <= to.getTime(); day = new Date(day.getTime() + DAY_MS)) {
    if (!isWeekend(day)) count++;
  }
  return count;
}

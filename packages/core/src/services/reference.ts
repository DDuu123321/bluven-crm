import type { Db, DocScope, LeadSourceKind } from '@bluven/db';
import { newId } from '../ids';

/** Keys of the built-in document types that back quotes, contracts and deposits. */
export const DOC_TYPE = {
  signedContract: 'signed_contract',
  depositProof: 'deposit_proof',
  quote: 'quote',
} as const;

/** Key of the folder electricity bills are filed in. Files there are read for the meter number and usage. */
export const BILL_DOC_TYPE = 'electricity_bill';

/** A document that counts today: not deleted, not replaced by a newer version, not superseded. */
export const CURRENT_DOCUMENT = { deletedAt: null, supersededAt: null, replacedBy: { is: null } } as const;

/** Keys of the built-in lead sources. */
export const SOURCE_KEY = {
  manual: 'manual',
  csv: 'csv-import',
  bluven: 'bluven-website',
} as const;

interface DocTypeSeed {
  key: string;
  label: string;
  description: string;
  scope: DocScope;
  isRequiredForHandoff: boolean;
  isSystem: boolean;
  neverAutoDelete: boolean;
  sortOrder: number;
}

const DOC_TYPES: DocTypeSeed[] = [
  { key: DOC_TYPE.signedContract, label: 'Signed contract', description: 'The contract or proposal signed by the customer.', scope: 'ORDER', isRequiredForHandoff: false, isSystem: true, neverAutoDelete: true, sortOrder: 10 },
  { key: DOC_TYPE.depositProof, label: 'Deposit payment proof', description: 'Transfer screenshot, gateway receipt or finance approval.', scope: 'ORDER', isRequiredForHandoff: false, isSystem: true, neverAutoDelete: true, sortOrder: 20 },
  { key: DOC_TYPE.quote, label: 'Quote / proposal', description: 'The quote as sent to the customer.', scope: 'ORDER', isRequiredForHandoff: false, isSystem: true, neverAutoDelete: false, sortOrder: 30 },
  { key: BILL_DOC_TYPE, label: 'Electricity bill', description: 'A recent bill showing the NMI, retailer and usage.', scope: 'ORDER', isRequiredForHandoff: true, isSystem: false, neverAutoDelete: false, sortOrder: 40 },
  { key: 'install_location', label: 'Installation location photos', description: 'Where the panels, inverter and battery will go.', scope: 'PROPERTY', isRequiredForHandoff: true, isSystem: false, neverAutoDelete: false, sortOrder: 50 },
  { key: 'meter_box', label: 'Meter box / switchboard photos', description: 'Clear photos of the meter box and switchboard, door open.', scope: 'PROPERTY', isRequiredForHandoff: true, isSystem: false, neverAutoDelete: false, sortOrder: 60 },
  { key: 'additional_photos', label: 'Additional site photos', description: 'Anything else operations should see.', scope: 'PROPERTY', isRequiredForHandoff: false, isSystem: false, neverAutoDelete: false, sortOrder: 70 },
  { key: 'other', label: 'Other documents', description: '', scope: 'ORDER', isRequiredForHandoff: false, isSystem: false, neverAutoDelete: false, sortOrder: 90 },
];

const LOST_REASONS: [key: string, label: string][] = [
  ['no_response', 'No response'],
  ['price', 'Price too high'],
  ['competitor', 'Chose a competitor'],
  ['not_eligible', 'Not eligible (renter, strata or no approval)'],
  ['site_unsuitable', 'Roof or site unsuitable'],
  ['finance_declined', 'Finance declined'],
  ['not_interested', 'No longer interested'],
  ['duplicate', 'Duplicate lead'],
  ['invalid_contact', 'Invalid contact details'],
  ['other', 'Other'],
];

const SOURCES: [key: string, name: string, kind: LeadSourceKind][] = [
  [SOURCE_KEY.manual, 'Manual entry', 'MANUAL'],
  [SOURCE_KEY.csv, 'CSV import', 'CSV'],
  [SOURCE_KEY.bluven, 'Bluven website', 'BLUVEN'],
];

/** Texts to start from. Managers change, add and remove them under Administration. */
const STARTER_TEMPLATES: { name: string; subject: string; body: string }[] = [
  {
    name: 'First contact',
    subject: 'Your solar enquiry with Bluven',
    body: `Hi {{first_name}},

Thanks for getting in touch with Bluven about solar for {{address}}.

I would like to understand what you are after, so that I can put the right system together for you. When is a good time for a quick call? If it is easier, just reply to this e-mail.

It also helps a lot if you can send me a recent electricity bill. A photo is fine.

Regards,
{{my_first_name}}
Bluven`,
  },
  {
    name: 'Ask for the bill and photos',
    subject: 'A few things I need for your quote',
    body: `Hi {{first_name}},

To finish your quote I need a few things from you. Photos taken on a phone are fine:

- a recent electricity bill, all pages
- the meter box with the door open
- the switchboard
- the roof, from the street and from the back if you can

You can simply reply to this e-mail and attach them.

Regards,
{{my_first_name}}
Bluven`,
  },
  {
    name: 'Follow up on a quote',
    subject: 'Your Bluven quote',
    body: `Hi {{first_name}},

I wanted to check that the quote I sent for {{address}} has reached you, and whether you have any questions about it.

I am happy to go through it on the phone, or to adjust the system if something does not fit.

Regards,
{{my_first_name}}
Bluven`,
  },
  {
    name: 'After signing: deposit and next steps',
    subject: 'Next steps for your installation',
    body: `Hi {{first_name}},

Thank you for signing. The next step is the deposit. Once it has arrived, our operations team will contact you to book the installation.

If anything changes on your side in the meantime, please let me know.

Regards,
{{my_first_name}}
Bluven`,
  },
];

const TEMPLATES_SEEDED = 'emailTemplatesSeeded';

/**
 * Creates the reference rows the application relies on. Existing rows are left as they are, so
 * anything an admin has renamed or reconfigured survives a re-run.
 */
export async function ensureReferenceData(db: Db): Promise<void> {
  for (const t of DOC_TYPES) {
    // No retention period of their own: the built-in types follow the period in the settings,
    // until an admin gives one of them a different one.
    await db.documentType.upsert({ where: { key: t.key }, update: {}, create: { id: newId('dty'), ...t, retentionYears: null } });
  }
  for (const [i, [key, label]] of LOST_REASONS.entries()) {
    await db.lostReason.upsert({ where: { key }, update: {}, create: { id: newId('lrs'), key, label, sortOrder: (i + 1) * 10 } });
  }
  for (const [key, name, kind] of SOURCES) {
    await db.leadSource.upsert({ where: { key }, update: {}, create: { id: newId('src'), key, name, kind } });
  }
  // The starter texts are put in once. A manager who removed them does not get them back at the next deployment.
  if (!(await db.setting.findUnique({ where: { key: TEMPLATES_SEEDED } }))) {
    if ((await db.emailTemplate.count()) === 0) {
      for (const [i, t] of STARTER_TEMPLATES.entries()) await db.emailTemplate.create({ data: { id: newId('etp'), ...t, sortOrder: (i + 1) * 10 } });
    }
    await db.setting.create({ data: { key: TEMPLATES_SEEDED, value: true } });
  }
}

'use server';

import { ValidationError, importLeadCsv } from '@bluven/core';
import { runAction } from '@/lib/action';
import type { ActionResult } from '@/lib/action-types';
import { bool, files, str } from '@/lib/form';

/** Previews or runs a CSV import. The file travels with both submits, so nothing is kept on the server in between. */
export async function importCsvAction(formData: FormData): Promise<ActionResult> {
  return runAction(async (ctx) => {
    const file = files(formData, 'file')[0];
    if (!file) throw new ValidationError('Choose a CSV file.', { file: 'Choose a CSV file.' });
    if (file.size > 5 * 1024 * 1024) throw new ValidationError('The file is larger than 5 MB. Split it into smaller files.', { file: 'Too large.' });
    const sourceId = str(formData, 'sourceId');
    if (!sourceId) throw new ValidationError('Choose where these leads came from.', { sourceId: 'Choose a source.' });
    const dryRun = str(formData, 'mode') !== 'import';
    const summary = await importLeadCsv(ctx, await file.text(), { sourceId, dryRun, backfill: bool(formData, 'backfill') });
    return {
      message: dryRun ? undefined : `Imported: ${summary.created} new, ${summary.duplicates} merged into open orders, ${summary.alreadyReceived} already received, ${summary.failed} rejected.`,
      data: {
        dryRun,
        fileName: file.name,
        received: summary.received,
        created: summary.created,
        duplicates: summary.duplicates,
        alreadyReceived: summary.alreadyReceived,
        failed: summary.failed,
        ignoredColumns: summary.ignoredColumns,
        // Rows that need attention, capped so the response stays small.
        problems: summary.results.filter((r) => !r.ok).slice(0, 200).map((r) => ({ row: r.index + 2, error: r.error ?? '' })),
      },
    };
  });
}

import { cleanupStaged, getConfig, markQuoteSent, zonedTimeToUtc, type StagedFile } from '@bluven/core';
import { files, str } from '@/lib/form';
import { authenticate, errorResponse, json, readForm, stageFiles } from '@/lib/http';

/** Records that a quote version went to the customer, optionally with the file that was sent. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  let staged: StagedFile[] = [];
  try {
    const form = await readForm(request);
    staged = await stageFiles(files(form, 'file').slice(0, 1));
    // A time left at its pre-filled value means "now", to the second.
    const when = str(form, 'sentAt');
    const sentAt = when && when !== str(form, 'sentAtDefault') ? zonedTimeToUtc(when, getConfig().timeZone) : null;
    await markQuoteSent(auth.ctx, { quoteId: id, sentAt, file: staged[0] ?? null });
    return json({ ok: true });
  } catch (e) {
    await cleanupStaged(staged);
    return errorResponse(e);
  }
}

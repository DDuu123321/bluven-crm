import { archiveContract, cleanupStaged, requireEditableOrder, type StagedFile } from '@bluven/core';
import { bool, dateOnly, files, str } from '@/lib/form';
import { authenticate, errorResponse, json, readForm, stageFiles } from '@/lib/http';

/** Archives the signed contract (one or more files) against the quote version the customer signed. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  let staged: StagedFile[] = [];
  try {
    // Who may do this is settled before the upload is read, so a refused request costs nothing.
    await requireEditableOrder(auth.ctx, id);
    const form = await readForm(request);
    staged = await stageFiles(files(form, 'files'));
    await archiveContract(auth.ctx, {
      orderId: id,
      quoteId: str(form, 'quoteId') || null,
      signedOn: dateOnly(form, 'signedOn'),
      files: staged,
      replaceExisting: bool(form, 'replace'),
    });
    return json({ ok: true });
  } catch (e) {
    await cleanupStaged(staged);
    return errorResponse(e);
  }
}

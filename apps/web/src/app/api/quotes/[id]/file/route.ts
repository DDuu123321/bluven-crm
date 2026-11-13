import { ValidationError, attachQuoteFile, cleanupStaged, requireEditableQuote, type StagedFile } from '@bluven/core';
import { files } from '@/lib/form';
import { authenticate, errorResponse, json, readForm, stageFiles } from '@/lib/http';

/** Puts the file that will go to the customer on a quote version that has not been sent yet. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  let staged: StagedFile[] = [];
  try {
    // Who may do this is settled before the upload is read, so a refused request costs nothing.
    await requireEditableQuote(auth.ctx, id);
    const form = await readForm(request);
    staged = await stageFiles(files(form, 'file').slice(0, 1));
    if (!staged[0]) throw new ValidationError('Choose the file.', { file: 'Choose the file.' });
    await attachQuoteFile(auth.ctx, { quoteId: id, file: staged[0] });
    return json({ ok: true });
  } catch (e) {
    await cleanupStaged(staged);
    return errorResponse(e);
  }
}

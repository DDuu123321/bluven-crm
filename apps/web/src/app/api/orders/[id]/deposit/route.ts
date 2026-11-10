import { cleanupStaged, requireEditableOrder, submitDeposit, type StagedFile } from '@bluven/core';
import { files, money, str } from '@/lib/form';
import { authenticate, errorResponse, json, readForm, stageFiles } from '@/lib/http';

/** Sales submits proof that the deposit was paid. */
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
    await submitDeposit(auth.ctx, { orderId: id, amountCents: money(form, 'amount'), method: str(form, 'method'), note: str(form, 'note'), files: staged });
    return json({ ok: true });
  } catch (e) {
    await cleanupStaged(staged);
    return errorResponse(e);
  }
}

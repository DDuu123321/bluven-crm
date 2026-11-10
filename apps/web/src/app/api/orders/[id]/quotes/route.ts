import { cleanupStaged, createQuote, type StagedFile } from '@bluven/core';
import { files, kilo, money, str } from '@/lib/form';
import { authenticate, errorResponse, json, readForm, stageFiles } from '@/lib/http';

/** Records a quote version, optionally with the file that goes to the customer. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const { id } = await params;
  let staged: StagedFile[] = [];
  try {
    const form = await readForm(request);
    staged = await stageFiles(files(form, 'file').slice(0, 1));
    await createQuote(auth.ctx, {
      orderId: id,
      title: str(form, 'title'),
      dcWatts: kilo(form, 'systemKw'),
      storageWh: kilo(form, 'batteryKwh'),
      totalCents: money(form, 'total'),
      depositCents: money(form, 'deposit'),
      notes: str(form, 'notes'),
      file: staged[0] ?? null,
    });
    return json({ ok: true });
  } catch (e) {
    await cleanupStaged(staged);
    return errorResponse(e);
  }
}

import { audit, countAudit, formatDateTime, getConfig, iterateAudit } from '@bluven/core';
import { authenticate, errorResponse } from '@/lib/http';

const MAX_ROWS = 50_000;

/** Quotes a value for CSV and defuses spreadsheet formulas. */
function cell(value: unknown): string {
  let s = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * The filtered audit log as CSV. The export itself is recorded in the log. Rows are read and sent
 * a page at a time, so a large export does not have to fit in memory.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const p = new URL(request.url).searchParams;
  const filters = { actorId: p.get('actor'), action: p.get('action'), entityType: p.get('entity'), orderNo: p.get('order'), q: p.get('q'), from: p.get('from'), to: p.get('to') };
  try {
    const tz = getConfig().timeZone;
    const total = await countAudit(auth.ctx, filters);
    const pages = iterateAudit(auth.ctx, filters);
    // The first page is read before the export is logged, so the export's own entry is not in it.
    let next = await pages.next();
    await audit(auth.ctx.db, auth.ctx, { action: 'audit.export', entityType: 'AuditLog', entityId: 'export', summary: `Exported ${Math.min(total, MAX_ROWS)} of ${total} audit entries`, meta: filters });

    const encoder = new TextEncoder();
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const header = ['When', 'Who', 'Action', 'Description', 'Order', 'Entity', 'Entity id', 'IP address', 'Before', 'After', 'Context'].map(cell).join(',');
        controller.enqueue(encoder.encode(`\uFEFF${header}\r\n`));
      },
      async pull(controller) {
        try {
          if (next.done || sent >= MAX_ROWS) {
            controller.close();
            return;
          }
          let text = '';
          for (const r of next.value) {
            if (sent >= MAX_ROWS) break;
            text += [formatDateTime(r.at, tz), r.actorLabel, r.action, r.summary, r.orderNo, r.entityType, r.entityId, r.ip, r.before, r.after, r.meta].map(cell).join(',') + '\r\n';
            sent++;
          }
          controller.enqueue(encoder.encode(text));
          next = await pages.next();
        } catch (e) {
          console.error('[audit] export failed part-way', e);
          controller.error(e);
        }
      },
      async cancel() {
        await pages.return(undefined);
      },
    });
    return new Response(body, {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="bluven-audit-log.csv"`, 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

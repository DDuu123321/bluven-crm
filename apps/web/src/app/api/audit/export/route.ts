import { audit, formatDateTime, getConfig, searchAudit } from '@bluven/core';
import { authenticate, errorResponse } from '@/lib/http';

const MAX_ROWS = 50_000;

/** Quotes a value for CSV and defuses spreadsheet formulas. */
function cell(value: unknown): string {
  let s = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** The filtered audit log as CSV. The export itself is recorded in the log. */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const p = new URL(request.url).searchParams;
  const filters = { actorId: p.get('actor'), action: p.get('action'), entityType: p.get('entity'), orderNo: p.get('order'), q: p.get('q'), from: p.get('from'), to: p.get('to') };
  try {
    const tz = getConfig().timeZone;
    const lines = [['When', 'Who', 'Action', 'Description', 'Order', 'Entity', 'Entity id', 'IP address', 'Before', 'After', 'Context'].map(cell).join(',')];
    let page = 1;
    let total = 0;
    for (;;) {
      const result = await searchAudit(auth.ctx, { ...filters, page, pageSize: 5000 });
      total = result.total;
      for (const r of result.rows) {
        lines.push([formatDateTime(r.at, tz), r.actorLabel, r.action, r.summary, r.orderNo, r.entityType, r.entityId, r.ip, r.before, r.after, r.meta].map(cell).join(','));
      }
      if (page >= result.pageCount || lines.length > MAX_ROWS) break;
      page++;
    }
    await audit(auth.ctx.db, auth.ctx, { action: 'audit.export', entityType: 'AuditLog', entityId: 'export', summary: `Exported ${lines.length - 1} of ${total} audit entries`, meta: filters });
    return new Response('﻿' + lines.join('\r\n') + '\r\n', {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="bluven-audit-log.csv"`, 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

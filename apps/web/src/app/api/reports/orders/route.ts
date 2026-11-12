import { STAGE_LABEL, SIDE_STATE_LABEL, audit, countReportOrders, dateOnlyString, formatKw, formatKwh, getConfig, iterateReportOrders, localDateString, parseDateOnly } from '@bluven/core';
import { authenticate, errorResponse } from '@/lib/http';

const MAX_ROWS = 50_000;

/** Quotes a value for CSV and defuses spreadsheet formulas. */
function cell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const HEADER = [
  'Order',
  'Customer',
  'Address',
  'Source',
  'Salesperson',
  'Stage',
  'State',
  'Enquiry received',
  'Assigned',
  'First contact',
  'Quoted',
  'Signed',
  'First pushed to operations',
  'Handed over',
  'Lost',
  'Lost reason',
  'Cancelled',
  'Times returned by operations',
  'Last staff activity',
  'Solar',
  'Battery',
  'Quote total',
  'Deposit received',
  'Deposit received on',
];

/**
 * The orders whose enquiry was received in the period, as CSV: one row per order with the date it
 * reached each stage. A manager gets every order, a salesperson their own. The export is recorded
 * in the audit log, and rows are sent a page at a time.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const p = new URL(request.url).searchParams;
  const tz = getConfig().timeZone;
  const today = localDateString(new Date(), tz);
  const from = parseDateOnly(p.get('from') ?? '') ? p.get('from')! : today;
  const to = parseDateOnly(p.get('to') ?? '') ? p.get('to')! : today;
  const range = from <= to ? { from, to } : { from: to, to: from };
  try {
    const total = await countReportOrders(auth.ctx, range);
    const pages = iterateReportOrders(auth.ctx, range);
    let next = await pages.next();
    await audit(auth.ctx.db, auth.ctx, { action: 'report.export', entityType: 'Order', entityId: 'export', summary: `Exported ${Math.min(total, MAX_ROWS)} order${total === 1 ? '' : 's'} with enquiries from ${range.from} to ${range.to}`, meta: range });

    const day = (date: Date | null) => (date ? localDateString(date, tz) : '');
    const money = (cents: number | null | undefined) => (cents === null || cents === undefined ? '' : (cents / 100).toFixed(2));
    const encoder = new TextEncoder();
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`﻿${HEADER.map(cell).join(',')}\r\n`));
      },
      async pull(controller) {
        try {
          if (next.done || sent >= MAX_ROWS) {
            controller.close();
            return;
          }
          let text = '';
          for (const o of next.value) {
            if (sent >= MAX_ROWS) break;
            const quote = o.quotes[0];
            const deposit = o.deposits[0];
            text +=
              [
                o.orderNo,
                o.customerName,
                o.address,
                o.source.name,
                o.owner?.name ?? '',
                STAGE_LABEL[o.stage],
                o.sideState === 'NONE' ? '' : SIDE_STATE_LABEL[o.sideState],
                day(o.leadCreatedAt),
                day(o.assignedAt),
                day(o.firstContactedAt),
                day(o.quotedAt),
                // The signing date and the day the deposit arrived are calendar dates as entered.
                dateOnlyString(o.signedAt),
                day(o.firstPushedAt),
                day(o.handedOverAt),
                o.sideState === 'LOST' ? day(o.lostAt) : '',
                o.sideState === 'LOST' ? (o.lostReason?.label ?? '') : '',
                o.sideState === 'CANCELLED' ? day(o.cancelledAt) : '',
                o.returnCount,
                day(o.lastStaffActivityAt),
                quote ? formatKw(quote.dcWatts) : '',
                quote ? formatKwh(quote.storageWh) : '',
                money(quote?.totalCents),
                money(deposit ? (deposit.receivedAmountCents ?? deposit.amountCents) : null),
                deposit ? dateOnlyString(deposit.receivedOn) : '',
              ]
                .map(cell)
                .join(',') + '\r\n';
            sent++;
          }
          controller.enqueue(encoder.encode(text));
          next = await pages.next();
        } catch (e) {
          console.error('[report] export failed part-way', e);
          controller.error(e);
        }
      },
      async cancel() {
        await pages.return(undefined);
      },
    });
    return new Response(body, {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="bluven-orders-${range.from}-to-${range.to}.csv"`, 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

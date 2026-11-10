import { CSV_TEMPLATE_HEADERS } from '@bluven/core';
import { authenticate } from '@/lib/http';

const EXAMPLE = ['1042', '2026-11-09T10:21:00+11:00', 'Jane', 'Smith', '0412 345 678', 'jane@example.com', '12 Sample St', 'Parramatta', 'NSW', '2150', 'House', 'Solar; Battery', '6.6', '10', '350', '1-month', 'afternoon', 'Referred by a neighbour'];

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const csv = `${CSV_TEMPLATE_HEADERS.join(',')}\n${EXAMPLE.map((v) => (/[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')}\n`;
  return new Response(csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="bluven-lead-import-template.csv"', 'Cache-Control': 'no-store' },
  });
}

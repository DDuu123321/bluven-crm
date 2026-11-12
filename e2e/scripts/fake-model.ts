// A stand-in for the language model's service, for the end-to-end tests. It accepts the same
// request the real service does and answers each kind of work with a fixed, plausible answer,
// so the tests exercise the application's own client code without spending anything.
import http from 'node:http';
import { E2E } from '../env';

interface Seen {
  kind: string;
  model: string;
  effort: string | null;
  files: string[];
  text: string;
}
const seen: Seen[] = [];

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const kindOf = (system: string): string =>
  system.startsWith('You sort the files')
    ? 'attachment'
    : system.startsWith('You read Australian electricity bills')
      ? 'bill'
      : system.startsWith('You write the handover brief')
        ? 'brief'
        : system.startsWith('You help a salesperson')
          ? 'reply'
          : system.startsWith('You work inside the customer system')
            ? 'summary'
            : 'unknown';

function answer(kind: string, text: string): unknown {
  switch (kind) {
    case 'summary':
      return {
        headline: 'New enquiry for solar and a battery; nobody has spoken to the customer yet.',
        situation: 'The enquiry came in through the website. The customer wants solar with a battery and mentioned a tiled roof.',
        wants: ['Solar with a battery', 'Installation before summer'],
        concerns: ['Whether the tiled roof is suitable'],
        promises: [],
        nextStep: 'Call the customer and ask for a recent electricity bill.',
        facts: [{ label: 'Roof', value: 'Tiled, north-facing', source: 'enquiry form' }],
        hints: [{ field: 'roofType', value: 'Tile', source: 'enquiry form' }],
      };
    case 'attachment':
      return { folder: 'electricity_bill', confidence: 'high', description: 'AGL electricity bill for August to October 2026' };
    case 'bill':
      return {
        isBill: true,
        retailer: 'AGL',
        nmi: '41031234567',
        accountHolder: 'Ava Assist',
        supplyAddress: '8 Summary St, Epping NSW 2121',
        periodFrom: '2026-08-01',
        periodTo: '2026-10-31',
        usageKwh: 1656,
        averageDailyKwh: 18,
        amountDue: 612.4,
        tariff: 'Single rate',
        solarExportKwh: null,
        notes: '',
      };
    case 'reply': {
      const wants = /## What the salesperson wants to say\n(.+)/.exec(text)?.[1] ?? '';
      return { subject: 'ignored for a reply', body: `Hi Ava,\n\nThanks for the bill, that is all I need for the design.${wants ? ` ${wants}.` : ''} We can install on [installation date].\n\nSam` };
    }
    case 'brief':
      return {
        overview: 'Ava Assist bought a 6.6 kW solar system for her house in Epping.',
        system: ['6.6 kW solar', '$9,000.00 in total, $900.00 deposit received'],
        site: ['Tiled roof', 'About 18 kWh a day according to the AGL bill'],
        customer: ['Prefers e-mail'],
        promises: ['Installation before summer'],
        open: ['Supply phase is not recorded'],
      };
    default:
      return {};
  }
}

const server = http.createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    const path = new URL(req.url ?? '/', E2E.modelUrl).pathname;
    if (path === '/health') return send(200, { ok: true });
    if (path === '/__test/requests') return send(200, seen);
    if (path !== '/v1/messages' || req.method !== 'POST') return send(404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });
    if (req.headers.authorization !== 'Bearer e2e-model-key' && req.headers['x-api-key'] !== 'e2e-model-key') return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });

    const body = JSON.parse((await readBody(req)).toString()) as {
      model: string;
      system?: string;
      messages: { role: string; content: { type: string; text?: string; title?: string }[] }[];
      output_config?: { effort?: string; format?: { type: string } };
    };
    // The real service refuses these; so does the stand-in, so a regression shows up here.
    if (body.output_config?.format?.type !== 'json_schema') return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'output_config.format is required by this stand-in' } });
    if ('temperature' in body || 'top_p' in body || 'top_k' in body) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'sampling parameters are not accepted' } });

    const blocks = body.messages.flatMap((m) => m.content);
    const text = blocks.map((b) => b.text ?? '').join('\n');
    const kind = kindOf(body.system ?? '');
    seen.push({ kind, model: body.model, effort: body.output_config?.effort ?? null, files: blocks.filter((b) => b.type !== 'text').map((b) => `${b.type}:${b.title ?? ''}`), text });
    return send(200, {
      id: `msg_${seen.length}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text: JSON.stringify(answer(kind, text)) }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1500 + text.length, output_tokens: 250, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  } catch (e) {
    return send(500, { type: 'error', error: { type: 'api_error', message: e instanceof Error ? e.message : String(e) } });
  }
});

server.listen(E2E.modelPort, '127.0.0.1', () => console.log(`stand-in for the language model on ${E2E.modelUrl}`));

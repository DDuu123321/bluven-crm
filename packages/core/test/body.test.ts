import { describe, expect, it } from 'vitest';
import { readTextBody } from '../src';

const MB = 1024 * 1024;

function streamed(chunks: () => Uint8Array | null): { request: Request; pulled: () => number } {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks();
      if (next === null) controller.close();
      else {
        pulled++;
        controller.enqueue(next);
      }
    },
  });
  return { request: new Request('http://crm.test/hook', { method: 'POST', body, duplex: 'half' } as RequestInit), pulled: () => pulled };
}

describe('reading a body from outside', () => {
  it('returns the text of a body within the limit', async () => {
    const request = new Request('http://crm.test/hook', { method: 'POST', body: JSON.stringify({ hello: 'wörld' }) });
    expect(await readTextBody(request, MB)).toBe('{"hello":"wörld"}');
    expect(await readTextBody(new Request('http://crm.test/hook', { method: 'POST' }), MB)).toBe('');
  });

  it('refuses a declared length over the limit without reading anything', async () => {
    const { request, pulled } = streamed(() => new Uint8Array(1024));
    request.headers.set('content-length', String(5 * MB));
    expect(await readTextBody(request, MB)).toBeNull();
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  it('stops reading an undeclared, endless body at the limit instead of collecting it', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const { request, pulled } = streamed(() => chunk); // never ends
    expect(await readTextBody(request, MB)).toBeNull();
    // About 16 chunks make up the megabyte; a few more may have been read ahead. Not hundreds.
    expect(pulled()).toBeLessThan(40);
  });

  it('accepts a streamed body that stays within the limit', async () => {
    let left = 3;
    const { request } = streamed(() => (left-- > 0 ? new TextEncoder().encode('abc') : null));
    expect(await readTextBody(request, MB)).toBe('abcabcabc');
  });
});

import { describe, expect, it } from 'vitest';
import { baseSubject, decodeEntities, emailSnippet, htmlToText, normalizeEmailAddress, openSecret, parseAddressList, parseMessageIds, replySubject, sealSecret, stripQuotedReply, textToHtml } from '../src';

describe('addresses', () => {
  it('reads recipient lists the way mail systems write them', () => {
    expect(parseAddressList('Jane Smith <Jane.Smith@Example.com>, bob@example.com; "Lee, Kim" <kim@example.com>')).toEqual([
      { name: 'Jane Smith', address: 'jane.smith@example.com' },
      { name: '', address: 'bob@example.com' },
      { name: 'Lee, Kim', address: 'kim@example.com' },
    ]);
    // Zoho returns them HTML-encoded, and says "Not Provided" for an empty field.
    expect(parseAddressList('&quot;rebecca&quot;&lt;rebecca@zylker.com&gt;')).toEqual([{ name: 'rebecca', address: 'rebecca@zylker.com' }]);
    expect(parseAddressList('Not Provided')).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList('a@x.com, A@X.com, nonsense')).toEqual([{ name: '', address: 'a@x.com' }]);
    expect(normalizeEmailAddress('  <Jane@Example.COM> ')).toBe('jane@example.com');
    expect(normalizeEmailAddress('no address here')).toBeNull();
  });

  it('reads message ids out of headers', () => {
    expect(parseMessageIds('<a@x> <b@y>\r\n <a@x>')).toEqual(['a@x', 'b@y']);
    expect(parseMessageIds(undefined)).toEqual([]);
  });
});

describe('subjects', () => {
  it('finds the subject under any number of reply and forward marks', () => {
    expect(baseSubject('RE: Re: FW: Your solar quote')).toBe('Your solar quote');
    expect(baseSubject('回复：Re[2]: 报价')).toBe('报价');
    expect(baseSubject('Regarding the roof')).toBe('Regarding the roof');
    expect(replySubject('Re: RE: Your solar quote')).toBe('Re: Your solar quote');
    expect(replySubject('')).toBe('Re:');
  });
});

describe('message bodies', () => {
  it('turns an HTML message into readable text and nothing else', () => {
    const html = `<html><head><title>x</title><style>p{color:red}</style></head><body>
      <!-- preview --><div style="display:none">&#8203;</div>
      <p>Hi&nbsp;Sam,</p><p>Please see the <a href="https://example.com/q?a=1&amp;b=2">quote</a><br>and call me.</p>
      <ul><li>Solar</li><li>Battery &amp; inverter</li></ul>
      <script>alert(1)</script><img src="https://tracker.example/p.gif">
      <table><tr><td>Total</td><td>$9,000</td></tr></table></body></html>`;
    expect(htmlToText(html)).toBe('Hi Sam,\n\nPlease see the quote (https://example.com/q?a=1&b=2)\nand call me.\n\n• Solar\n• Battery & inverter\n\nTotal $9,000');
    // Markup that is cut off, or pretends to be something else, does not leak through.
    expect(htmlToText('<p>ok</p><script>steal()')).toBe('ok');
    expect(htmlToText('a &lt;b&gt; &amp; c &#x1F600; &#0; &bogus;')).toBe('a <b> & c 😀 &bogus;');
    expect(htmlToText('<a href="javascript:alert(1)">click</a>')).toBe('click');
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe('https://example.com');
  });

  it('decodes entities without producing control characters', () => {
    expect(decodeEntities('&amp;amp; &#65; &#x41; &#1; &#55357;')).toBe('&amp; A A  ');
  });

  it('writes plain text as simple, safe HTML', () => {
    const html = textToHtml('Hi <Jane>,\n\nSee https://example.com/a?b=1&c=2.\nThanks & regards');
    expect(html).toContain('Hi &lt;Jane&gt;,');
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a>.');
    expect(html).toContain('Thanks &amp; regards');
    expect(html).not.toContain('<Jane>');
    expect(htmlToText(html)).toBe('Hi <Jane>,\n\nSee https://example.com/a?b=1&c=2.\nThanks & regards');
  });

  it('keeps what the sender wrote and drops the conversation quoted underneath', () => {
    expect(stripQuotedReply('Yes please, Tuesday works.\n\nOn Mon, 9 Nov 2026 at 10:02, Sam Sales <sam@bluven.com.au> wrote:\n> Would Tuesday suit?\n> Sam')).toBe('Yes please, Tuesday works.');
    expect(stripQuotedReply('Sounds good.\n\nFrom: Sam Sales\nSent: Monday, 9 November 2026\nTo: Jane\nSubject: Quote\n\nHello')).toBe('Sounds good.');
    expect(stripQuotedReply('Thanks\n\n-----Original Message-----\nold text')).toBe('Thanks');
    // Nothing recognisable, or nothing above the quote: the text is left alone.
    expect(stripQuotedReply('From: the roof you can see the sea.\nLovely.')).toBe('From: the roof you can see the sea.\nLovely.');
    expect(stripQuotedReply('> quoted only\n> more')).toBe('> quoted only\n> more');
    expect(emailSnippet('  one\n two   three ', 9)).toBe('one two…');
  });
});

describe('sealed secrets', () => {
  it('opens only with the same key material and purpose, and only if untouched', () => {
    const sealed = sealSecret('1000.refresh-token', 'client-secret', 'mail-token');
    expect(sealed).not.toContain('refresh');
    expect(sealSecret('1000.refresh-token', 'client-secret', 'mail-token')).not.toBe(sealed); // a fresh nonce every time
    expect(openSecret(sealed, 'client-secret', 'mail-token')).toBe('1000.refresh-token');
    expect(openSecret(sealed, 'another-secret', 'mail-token')).toBeNull();
    expect(openSecret(sealed, 'client-secret', 'other-purpose')).toBeNull();
    const parts = sealed.split('.');
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith('AA') ? 'BB' : 'AA');
    expect(openSecret(parts.join('.'), 'client-secret', 'mail-token')).toBeNull();
    expect(openSecret('garbage', 'client-secret', 'mail-token')).toBeNull();
    expect(() => sealSecret('x', '', 'mail-token')).toThrow();
  });
});

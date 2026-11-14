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

describe('markup that is not well formed', () => {
  it('comes out the way a mail program would show it', () => {
    // Closed comments and styles go; what follows them stays.
    expect(htmlToText('<p>One</p><!-- note --><style>p { color: red }</style><p>Two</p>')).toBe('One\n\nTwo');
    // The comments Outlook reads, and the short forms of a comment.
    expect(htmlToText('<!--[if mso]><p>Outlook only</p><![endif]--><!--[if !mso]><!--><p>Shown</p><!--<![endif]-->')).toBe('Shown');
    expect(htmlToText('<p>A</p><!--><p>B</p><!---><p>C</p><!-- x --!><p>D</p>')).toBe('A\n\nB\n\nC\n\nD');
    // What is never closed hides the rest, as it does in a mail program.
    expect(htmlToText('<p>Shown</p><style>p { color: red } <p>never shown</p>')).toBe('Shown');
    expect(htmlToText('<p>Shown</p><SCRIPT>var a = "<p>never shown</p>"')).toBe('Shown');
    expect(htmlToText('<p>Before</p><!-- not closed <p>After</p>')).toBe('Before');
    // Each belongs to what opened first.
    expect(htmlToText('<style><!-- p { margin: 0 } </style><p>Hello</p>')).toBe('Hello');
    expect(htmlToText('<!-- <style> --><p>Hello</p><!-- </style> -->')).toBe('Hello');
    // A drawing or a title without an end loses its tag only.
    expect(htmlToText('<svg><p>Still here</p>')).toBe('Still here');
    // Links: the target is added when the text does not say it, a link that is never closed is plain text.
    expect(htmlToText('<a href="https://example.com/quote">Your quote</a> and <a href="https://example.com/x">https://example.com/x</a>')).toBe('Your quote (https://example.com/quote) and https://example.com/x');
    expect(htmlToText('<A HREF=\'https://example.com/a\'>First</A> then <a href="https://example.com/b">never closed')).toBe('First (https://example.com/a) then never closed');
    expect(htmlToText('<a name="top">Top</a> <a href="mailto:x@example.com">Write</a>')).toBe('Top Write');
    expect(htmlToText('<a title="More >" href="https://example.com/more">More</a> <a href="https://example.com/?a>b">Odd</a>')).toBe('More (https://example.com/more) Odd (https://example.com/?a>b)');
    // A "<" that opens nothing is text.
    expect(htmlToText('<p>3 < 5</p> and 2 < 4 < 8')).toBe('3 < 5\nand 2 < 4 < 8');
    // Letters whose small form is longer than the capital do not shift where things are cut.
    expect(htmlToText('<p>İbrahim İİİ</p><style>p{}</style><p>Merhaba <a href="https://example.com/a">İ link</a></p><!-- x --><p>Son</p>')).toBe('İbrahim İİİ\n\nMerhaba İ link (https://example.com/a)\n\nSon');
  });

  it('takes time in proportion to its length, whatever it is missing', () => {
    const size = 600_000;
    const many = (piece: string): string => piece.repeat(Math.floor(size / piece.length));
    const shapes = [
      many('<!-- never closed '),
      many('<!-- closed -->'),
      many('<!-- closed --!>'),
      many('<style>p{}'),
      many('<svg><path d="M0 0">'),
      many('<title>'),
      many('</style '),
      many('<a href="https://example.com/x">no end '),
      many('<a href="https://example.com/x'),
      `${many('<a ')}>`,
      `${many('<a x="')}>`,
      `<a href="https://example.com/x">${many('<')}</a>`,
      many('<a href="https://example.com/x">x</a>'),
      many('a < b '),
      many('<'),
      `${many('<p <li <div ')}>`,
      many('<p <li <div '),
      many('&amp &lt &nbsp '),
      `&${many('a')}`,
      many(' \n'),
    ];
    for (const html of shapes) {
      const started = performance.now();
      htmlToText(html);
      // The worst of these took minutes before. They need a few milliseconds now; a second allows for a slow machine.
      expect(performance.now() - started, html.slice(0, 24)).toBeLessThan(1000);
    }
    // Only the first million characters are looked at.
    expect(htmlToText('x'.repeat(1_200_000))).toHaveLength(1_000_000);
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

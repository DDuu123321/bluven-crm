// Pure helpers for e-mail: addresses, subjects, and turning message bodies into text and back.

export interface Mailbox {
  name: string;
  /** Lower-cased. */
  address: string;
}

const ADDRESS_RE = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/i;

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™' };

/** Decodes the HTML entities that occur in mail. Unknown ones are left as they are. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Control characters and anything outside Unicode stay out.
      return Number.isFinite(code) && code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function normalizeEmailAddress(raw: string | null | undefined): string | null {
  const match = ADDRESS_RE.exec((raw ?? '').trim());
  return match ? match[0].toLowerCase() : null;
}

/**
 * Reads a list of recipients as mail systems write it: `Name <a@b>`, `"Last, First" <a@b>`,
 * bare addresses, separated by commas or semicolons. Zoho returns these HTML-encoded and writes
 * "Not Provided" for an empty field. Entries without an address are dropped.
 */
export function parseAddressList(raw: string | null | undefined): Mailbox[] {
  const text = decodeEntities(raw ?? '').trim();
  if (!text || /^not provided$/i.test(text)) return [];
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  const seen = new Set<string>();
  const out: Mailbox[] = [];
  for (const part of parts) {
    const address = normalizeEmailAddress(part);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const name = part
      .replace(/<[^>]*>/g, ' ')
      .replace(ADDRESS_RE, ' ')
      .replace(/["']/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    out.push({ name, address });
  }
  return out;
}

/** The ids in a Message-ID, In-Reply-To or References header, without the angle brackets. */
export function parseMessageIds(raw: string | null | undefined): string[] {
  const ids: string[] = [];
  for (const match of (raw ?? '').matchAll(/<([^<>\s]{3,300})>/g)) ids.push(match[1]!);
  return [...new Set(ids)];
}

/** A subject without its "Re:" and "Fwd:" prefixes, for showing replies under what they answer. */
export function baseSubject(subject: string): string {
  let s = subject.trim();
  for (let i = 0; i < 10; i++) {
    const next = s.replace(/^(?:re|fw|fwd|aw|wg|回复|答复|转发)\s*(?:\[\d+\])?\s*[:：]\s*/i, '');
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

/** The subject for a reply: one "Re: ", however many the conversation has collected. */
export function replySubject(subject: string): string {
  const base = baseSubject(subject);
  return base ? `Re: ${base}` : 'Re:';
}

const BLOCK_TAGS = 'p|div|br|tr|h[1-6]|table|blockquote|section|article|header|footer|ul|ol|pre|hr';

/**
 * The readable text of an HTML message: no markup, no styles or scripts, no hidden preview text,
 * paragraphs and line breaks kept. This is what the CRM shows and searches; the HTML itself is
 * only ever displayed inside a sandbox.
 */
export function htmlToText(html: string): string {
  let s = html.replace(/\r\n?/g, '\n');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(head|style|script|title|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<(style|script)\b[\s\S]*$/gi, '');
  // Links keep their target when it says more than the text does.
  s = s.replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, d: string | undefined, q: string | undefined, inner: string) => {
    const href = decodeEntities(d ?? q ?? '').trim();
    const label = inner.replace(/<[^>]*>/g, '').trim();
    if (!/^https?:\/\//i.test(href) || !label) return inner;
    const shown = decodeEntities(label).replace(/\s+/g, ' ');
    return shown.includes(href.replace(/^https?:\/\//i, '').replace(/\/$/, '')) || shown === href ? shown : `${shown} (${href})`;
  });
  s = s.replace(/<li\b[^>]*>/gi, '\n• ').replace(/<\/li\s*>/gi, '');
  s = s.replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  s = s.replace(/<\/t[dh]\s*>/gi, ' ');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[​-‍⁠﻿­]/g, '');
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A plain-text message as simple HTML: paragraphs, line breaks, and links people can click. */
export function textToHtml(text: string): string {
  const paragraphs = text.replace(/\r\n?/g, '\n').trim().split(/\n{2,}/);
  const body = paragraphs
    .map((p) => {
      const html = escapeHtml(p).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, (url) => `<a href="${url}">${url}</a>`);
      return `<p style="margin:0 0 12px">${html.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937">${body}</div>`;
}

/** The start of a message, on one line, for lists. */
export function emailSnippet(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * The part of a reply that the sender wrote, without the conversation quoted underneath.
 * Recognises the usual separators; when none is found the whole text is returned.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.split('\n');
  const markers = [
    /^On .{6,120} wrote:$/i,
    /^-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}$/i,
    /^_{10,}$/,
    /^From:\s.+$/i,
    /^-{4,}\s*On .+ wrote\s*-{4,}$/i,
    /^在.{4,60}写道[:：]$/,
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const quotedBlock = line.startsWith('>') && lines.slice(i, i + 3).every((l) => !l.trim() || l.trim().startsWith('>'));
    const fromHeader = /^From:\s/i.test(line) && lines.slice(i + 1, i + 5).some((l) => /^(Sent|Date|To|Subject):\s/i.test(l.trim()));
    if (quotedBlock || (markers.some((m) => m.test(line)) && (!/^From:\s/i.test(line) || fromHeader))) {
      const kept = lines.slice(0, i).join('\n').trim();
      if (kept) return kept;
      break;
    }
  }
  return text.trim();
}

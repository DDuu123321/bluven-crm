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

/** No more of a message than this is turned into text. A message is never this long; what is, is not a message. */
const MAX_HTML_CHARS = 1_000_000;

// The steps below look for a closing mark after an opening one. Written as one pattern each they
// took time growing with the square of the length when the closing marks were missing: every
// opening mark sent the search to the end of the text. A message of a megabyte made that way held
// the reading of every mailbox up for minutes. Here no stretch of the text is searched twice.

/** Finds `needle` at or after a position. Asked for positions that never go back, it reads the text once in all. */
function finderOf(text: string, needle: string): (from: number) => number {
  let found = -2;
  return (from) => {
    if (found !== -1 && found < from) found = text.indexOf(needle, from);
    return found;
  };
}

/**
 * Cuts out what a mail program does not show as text: comments, styles, scripts, the head,
 * drawings. They are taken in the order they come, so a comment mark inside a style belongs to
 * the style, and a style inside a comment to the comment.
 */
function withoutHiddenParts(s: string): string {
  const opener = /<(?:!--|(head|style|script|title|noscript|template|svg)\b)/gi;
  const commentEnd = finderOf(s, '-->');
  const commentEndBang = finderOf(s, '--!>');
  const closers = new Map<string, RegExp>();
  const neverClosed = new Set<string>();
  let out = '';
  let at = 0;
  for (let m = opener.exec(s); m; m = opener.exec(s)) {
    const name = m[1]?.toLowerCase();
    let end = -1;
    if (!name) {
      // "<!-->" and "<!--->" are whole comments, and "--!>" closes one as "-->" does.
      const plain = commentEnd(m.index + 2);
      const bang = commentEndBang(m.index + 4);
      if (plain >= 0 && (bang < 0 || plain < bang)) end = plain + 3;
      else if (bang >= 0) end = bang + 4;
    } else if (!neverClosed.has(name)) {
      let closer = closers.get(name);
      if (!closer) closers.set(name, (closer = new RegExp(`</${name}\\s*>`, 'gi')));
      closer.lastIndex = opener.lastIndex;
      const found = closer.exec(s);
      if (found) end = found.index + found[0].length;
      else neverClosed.add(name);
    }
    if (end < 0) {
      // A comment, a style or a script that is never closed runs to the end of the message in a
      // mail program, and nothing after it is shown. The other tags go with the tags further down.
      if (!name || name === 'style' || name === 'script') return out + s.slice(at, m.index);
      continue;
    }
    out += s.slice(at, m.index);
    at = end;
    opener.lastIndex = end;
  }
  return out + s.slice(at);
}

/** Where the tag that begins at `from` ends: the first ">" outside a quoted value. -1 when it never ends. */
function tagEndOf(s: string, from: number): number {
  let quote = 0;
  let afterEquals = false;
  for (let i = from; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (quote) {
      if (ch === quote) quote = 0;
    } else if (ch === 62) {
      return i;
    } else if (afterEquals && (ch === 34 || ch === 39)) {
      quote = ch;
      afterEquals = false;
    } else if (ch === 61) {
      afterEquals = true;
    } else if (ch !== 32 && ch !== 9 && ch !== 10 && ch !== 12 && ch !== 13) {
      afterEquals = false;
    }
  }
  return -1;
}

/** Takes the tags out. A tag ends with ">", so after the last one there are none, and a long run of "<" with nothing closing it costs nothing. */
function withoutTags(s: string): string {
  const end = s.lastIndexOf('>') + 1;
  return s.slice(0, end).replace(/<[^>]*>/g, '') + s.slice(end);
}

/** Links keep their target when it says more than the text does. */
function withLinkTargets(s: string): string {
  const opener = /<a\b/gi;
  const closer = /<\/a\s*>/gi;
  let out = '';
  let at = 0;
  for (let m = opener.exec(s); m; m = opener.exec(s)) {
    const tagEnd = tagEndOf(s, m.index);
    if (tagEnd < 0) break;
    const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(s.slice(m.index, tagEnd + 1));
    if (!href) {
      opener.lastIndex = tagEnd + 1;
      continue;
    }
    closer.lastIndex = tagEnd + 1;
    const end = closer.exec(s);
    if (!end) break;
    const inner = s.slice(tagEnd + 1, end.index);
    const target = decodeEntities(href[1] ?? href[2] ?? '').trim();
    const label = withoutTags(inner).trim();
    let shown = inner;
    if (/^https?:\/\//i.test(target) && label) {
      const text = decodeEntities(label).replace(/\s+/g, ' ');
      shown = text.includes(target.replace(/^https?:\/\//i, '').replace(/\/$/, '')) || text === target ? text : `${text} (${target})`;
    }
    out += s.slice(at, m.index) + shown;
    at = end.index + end[0].length;
    opener.lastIndex = at;
  }
  return out + s.slice(at);
}

/**
 * The readable text of an HTML message: no markup, no styles or scripts, no hidden preview text,
 * paragraphs and line breaks kept. This is what the CRM shows and searches; the HTML itself is
 * only ever displayed inside a sandbox.
 */
export function htmlToText(html: string): string {
  let s = html.slice(0, MAX_HTML_CHARS).replace(/\r\n?/g, '\n');
  s = withLinkTargets(withoutHiddenParts(s));
  // As in withoutTags: what follows the last ">" holds no tag and is left alone.
  const lastTagEnd = s.lastIndexOf('>') + 1;
  let tagged = s.slice(0, lastTagEnd);
  tagged = tagged.replace(/<li\b[^>]*>/gi, '\n• ').replace(/<\/li\s*>/gi, '');
  tagged = tagged.replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  tagged = tagged.replace(/<\/t[dh]\s*>/gi, ' ');
  tagged = tagged.replace(/<[^>]*>/g, '');
  s = decodeEntities(tagged + s.slice(lastTagEnd));
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

// ---------------------------------------------------------------------------
// Ready-made texts
// ---------------------------------------------------------------------------

/** What a ready-made text can refer to. Each is written in double braces, for example {{first_name}}. */
export const TEMPLATE_FIELDS = {
  first_name: 'The customer’s first name',
  full_name: 'The customer’s full name',
  address: 'The address of the property',
  order_no: 'The order number',
  my_name: 'Your own name',
  my_first_name: 'Your own first name',
} as const;
export type TemplateField = keyof typeof TEMPLATE_FIELDS;

/**
 * Puts the values into a ready-made text. A field that has no value, and anything in braces that
 * is not a known field, is left as it is written, so the person sending sees that something is
 * still to be filled in.
 */
export function fillTemplate(text: string, values: Partial<Record<TemplateField, string>>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, name: string) => {
    // Only what was put into `values`: a name such as "constructor" is on every object, and is not a field.
    const key = name.toLowerCase();
    const value = Object.hasOwn(values, key) ? values[key as TemplateField] : undefined;
    return typeof value === 'string' && value.trim() ? value.trim() : whole;
  });
}

/** The names in double braces that are not known fields, for telling the person writing a template. */
export function unknownTemplateFields(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const name = m[1]!.toLowerCase();
    if (!Object.hasOwn(TEMPLATE_FIELDS, name)) found.add(m[1]!);
  }
  return [...found];
}

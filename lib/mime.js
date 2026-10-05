// Message parsing (Gmail API payloads) and RFC 822 reply construction.

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- base64 helpers ----------
export function bytesToBase64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
export function wrap76(b64) { return b64.replace(/.{1,76}/g, '$&\r\n').trimEnd(); }
export function base64UrlToBytes(s) {
  s = (s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- parsing ----------
export function header(msg, name) {
  const h = (msg.payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

export function parseAddress(v) {
  v = (v || '').trim();
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  const e = v.match(/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/);
  return { name: '', email: e ? e[0].toLowerCase() : '' };
}

export function parseAddressList(v) {
  return (v || '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(parseAddress).filter((a) => a.email);
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function walk(part, out) {
  if (!part) return;
  const type = (part.mimeType || '').toLowerCase();
  if (part.body?.data && !part.filename) {
    const text = dec.decode(base64UrlToBytes(part.body.data));
    if (type === 'text/plain' && !out.plain) out.plain = text;
    if (type === 'text/html' && !out.html) out.html = text;
  }
  for (const p of part.parts || []) walk(p, out);
}

export function bodyText(msg) {
  const out = {};
  walk(msg.payload, out);
  return out.plain || htmlToText(out.html || '') || msg.snippet || '';
}

/** Normalised summary of one Gmail message. */
export function summarize(msg) {
  const from = parseAddress(header(msg, 'From'));
  const replyTo = parseAddressList(header(msg, 'Reply-To'));
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds || [],
    subject: header(msg, 'Subject'),
    fromName: from.name,
    fromEmail: from.email,
    replyTo: replyTo[0]?.email || '',
    to: parseAddressList(header(msg, 'To')).map((a) => a.email),
    cc: parseAddressList(header(msg, 'Cc')).map((a) => a.email),
    messageId: header(msg, 'Message-ID') || header(msg, 'Message-Id'),
    references: header(msg, 'References'),
    date: Number(msg.internalDate) || 0,
    body: bodyText(msg),
  };
}

// ---------- building ----------
export function encodeHeader(v) {
  v = String(v ?? '').replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  // Split into chunks of whole characters so no encoded-word exceeds ~75 chars.
  const words = [];
  let chunk = '';
  for (const ch of v) {
    if (enc.encode(chunk + ch).length > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${bytesToBase64(enc.encode(w))}?=`).join('\r\n ');
}

function formatAddress(a) {
  if (typeof a === 'string') return a;
  return a.name ? `${encodeHeader(a.name.replace(/"/g, ''))} <${a.email}>` : a.email;
}

function filenameParams(name) {
  const safe = String(name || 'attachment').replace(/["\\\r\n]/g, '_');
  if (/^[\x20-\x7e]*$/.test(safe)) return `filename="${safe}"`;
  return `filename*=UTF-8''${encodeURIComponent(safe)}`;
}

function nameParam(name) {
  const safe = String(name || 'attachment').replace(/["\\\r\n]/g, '_');
  return /^[\x20-\x7e]*$/.test(safe) ? `name="${safe}"` : `name="${encodeHeader(safe)}"`;
}

/**
 * Builds an RFC 822 message. All bodies are base64 so the result is pure ASCII.
 * attachments: [{name, type, bytes: Uint8Array}]
 * inline:      [{cid, name, type, bytes}] images shown inside the HTML via src="cid:<cid>"
 */
export function buildMessage({ from, to, cc = [], subject, inReplyTo, references, html, text, attachments = [], inline = [] }) {
  const rnd = () => Math.random().toString(36).slice(2);
  const mixed = 'mixed_' + rnd();
  const alt = 'alt_' + rnd();
  const related = 'rel_' + rnd();
  const lines = [];
  if (from) lines.push(`From: ${formatAddress(from)}`);
  lines.push(`To: ${[].concat(to).map(formatAddress).join(', ')}`);
  if (cc.length) lines.push(`Cc: ${cc.map(formatAddress).join(', ')}`);
  lines.push(`Subject: ${encodeHeader(subject)}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references || inReplyTo) lines.push(`References: ${[references, inReplyTo].filter(Boolean).join(' ').trim()}`);
  lines.push('MIME-Version: 1.0');

  const altPart = [
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(bytesToBase64(enc.encode(text || htmlToText(html)))),
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(bytesToBase64(enc.encode(html || ''))),
    `--${alt}--`,
  ];

  // Inline images: multipart/related wraps the text/HTML alternatives plus the images.
  let bodyPart = altPart;
  if (inline.length) {
    bodyPart = [`Content-Type: multipart/related; boundary="${related}"`, '', `--${related}`, ...altPart];
    for (const img of inline) {
      bodyPart.push(
        `--${related}`,
        `Content-Type: ${img.type || 'image/png'}; ${nameParam(img.name)}`,
        `Content-Disposition: inline; ${filenameParams(img.name)}`,
        `Content-ID: <${img.cid}>`,
        `X-Attachment-Id: ${img.cid.split('@')[0]}`,
        'Content-Transfer-Encoding: base64',
        '',
        wrap76(bytesToBase64(img.bytes)),
      );
    }
    bodyPart.push(`--${related}--`);
  }

  if (!attachments.length) {
    return [...lines, ...bodyPart].join('\r\n');
  }
  const out = [...lines, `Content-Type: multipart/mixed; boundary="${mixed}"`, '', `--${mixed}`, ...bodyPart];
  for (const a of attachments) {
    out.push(
      `--${mixed}`,
      `Content-Type: ${a.type || 'application/octet-stream'}; ${nameParam(a.name)}`,
      `Content-Disposition: attachment; ${filenameParams(a.name)}`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(bytesToBase64(a.bytes)),
    );
  }
  out.push(`--${mixed}--`);
  return out.join('\r\n');
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fillPlaceholders(template, vars, { html = false } = {}) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) =>
    k in vars ? (html ? escapeHtml(vars[k]) : String(vars[k])) : m);
}

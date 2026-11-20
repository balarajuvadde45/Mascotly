// Shared helpers used across the Mascot server.
import crypto from 'node:crypto';

/** Short, URL-safe unique id. */
export function newId(prefix = '') {
  const id = crypto.randomBytes(9).toString('base64url');
  return prefix ? `${prefix}_${id}` : id;
}

/** UUID v4 when a longer opaque id is fine. */
export function uuid() {
  return crypto.randomUUID();
}

/** Cryptographically strong hex key. */
export function secretKey(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) {
    // Still do a comparison to keep timing roughly uniform, then fail.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export function nowIso() {
  return new Date().toISOString();
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Safe JSON.parse that returns fallback instead of throwing. */
export function safeJsonParse(text, fallback = null) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Lenient JSON extraction: finds the first balanced JSON object embedded in a
 * string (used for the brain's tool/action protocol where models may wrap JSON
 * in prose or code fences).
 */
export function extractJsonObject(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return safeJsonParse(text.slice(start, i + 1), null);
      }
    }
  }
  return null;
}

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#x27': "'", '#x2f': '/', '#x2F': '/',
};

export function decodeHtmlEntities(text) {
  return String(text).replace(/&#x?([0-9a-f]+);?|&([a-z]+);/gi, (m, hex, name) => {
    if (hex) {
      const code = hex.startsWith('x') || hex.startsWith('X') ? parseInt(hex.slice(1), 16) : parseInt(hex, 10);
      if (!Number.isNaN(code) && code > 0 && code < 0x110000) {
        try { return String.fromCodePoint(code); } catch { return m; }
      }
      return m;
    }
    const key = name.toLowerCase();
    if (key === 'amp') return '&';
    if (key === 'lt') return '<';
    if (key === 'gt') return '>';
    if (key === 'quot') return '"';
    if (key === 'apos' || key === '#39') return "'";
    if (key === 'nbsp') return ' ';
    const named = HTML_ENTITIES[name] || HTML_ENTITIES[key];
    return named != null ? named : m;
  });
}

export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Truncate a string to maxLen, appending an ellipsis marker when cut. */
export function truncate(text, maxLen = 400, marker = '…') {
  const s = String(text ?? '');
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen - marker.length)) + marker;
}

/** Remove control characters and collapse excessive whitespace. */
export function cleanText(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Strip surrounding code fences from a model reply. */
export function stripCodeFence(text) {
  const m = String(text ?? '').trim().match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : String(text ?? '').trim();
}

export function normalizeUrl(raw) {
  let url = String(raw ?? '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

export function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/** Split a string into a valid pathname-safe slug. */
export function slugify(text, maxLen = 48) {
  const slug = String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLen) || 'app';
}

/** Format byte counts for humans. */
export function humanBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

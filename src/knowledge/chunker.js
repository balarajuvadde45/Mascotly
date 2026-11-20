// Heading-aware, overlap-preserving chunker.
//
// Input text arrives as markdown-ish (HTML pages are converted to markdown-lite by
// the crawler). Chunks keep their heading path in metadata and start with a short
// heading breadcrumb for lexical retrieval quality.

const DEFAULTS = { targetChars: 900, overlapChars: 140, maxChunkChars: 2200, minChunkChars: 60 };

function isHeadingLine(line) {
  return /^#{1,6}\s+\S/.test(line);
}

function headingLevel(line) {
  const m = line.match(/^(#{1,6})\s+/);
  return m ? m[1].length : 0;
}

/** Split text into "blocks": headings act as boundaries; fenced code stays atomic. */
function toBlocks(text) {
  const lines = String(text ?? '').split('\n');
  const blocks = []; // {type:'heading'|'para', text}
  let buf = [];
  let inFence = false;

  const flush = () => {
    const t = buf.join('\n').trim();
    if (t) blocks.push({ type: 'para', text: t });
    buf = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && isHeadingLine(line)) {
      flush();
      blocks.push({ type: 'heading', text: line.replace(/^#+\s*/, '').trim(), level: headingLevel(line) });
      continue;
    }
    // Blank line ends a paragraph (outside fences).
    if (!inFence && line.trim() === '') {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

/** Split an over-long paragraph by sentence, with overlap. */
function splitLongParagraph(text, targetChars, overlapChars, maxChunkChars) {
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) || [text];
  const out = [];
  let cur = '';
  const push = () => {
    const t = cur.trim();
    if (t) out.push(t);
    cur = '';
  };
  for (const s of sentences) {
    if (s.length > maxChunkChars) {
      // Pathological run-on: hard split.
      push();
      for (let i = 0; i < s.length; i += targetChars) {
        const start = Math.max(0, i === 0 ? i : i - overlapChars);
        out.push(s.slice(start, i + targetChars).trim());
      }
      continue;
    }
    if (cur.length + s.length > targetChars && cur) {
      // Capture the overlap tail BEFORE flushing (push() clears the buffer).
      const tail = cur.slice(Math.max(0, cur.length - overlapChars));
      push();
      cur = tail.trim() ? `${tail.trim()} ` : '';
    }
    cur += s;
    if (cur.length >= maxChunkChars) push();
  }
  push();
  return out.filter(Boolean);
}

/**
 * @param {string} text
 * @param {object} opts { targetChars, overlapChars }
 * @returns {Array<{text, heading, headingPath}>}
 */
export function chunkText(text, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const blocks = toBlocks(text);
  const chunks = [];

  let headingPath = []; // [{level, text}]
  let buf = [];
  let bufLen = 0;

  const flush = () => {
    const t = buf.join('\n').trim();
    buf = [];
    bufLen = 0;
    if (!t) return;
    const crumb = headingPath.map((h) => h.text).join(' › ');
    chunks.push({
      text: t,
      heading: headingPath.length ? headingPath[headingPath.length - 1].text : '',
      headingPath: crumb,
    });
  };

  for (const block of blocks) {
    if (block.type === 'heading') {
      // Headings are natural section boundaries — always flush what we have.
      if (bufLen > 0) flush();
      // Maintain heading stack.
      while (headingPath.length && headingPath[headingPath.length - 1].level >= block.level) headingPath.pop();
      headingPath.push({ level: block.level, text: block.text });
      if (headingPath.length > 4) headingPath = headingPath.slice(-4);
      continue;
    }
    const pieces = block.text.length > o.maxChunkChars
      ? splitLongParagraph(block.text, o.targetChars, o.overlapChars, o.maxChunkChars)
      : [block.text];
    for (const piece of pieces) {
      if (bufLen > 0 && bufLen + piece.length > o.targetChars) flush();
      buf.push(piece);
      bufLen += piece.length + 1;
      if (bufLen >= o.maxChunkChars) flush();
    }
  }
  flush();

  // Final form: prepend breadcrumb, merge only same-section remnants (tiny
  // sections stay retrievable instead of being dropped).
  const merged = [];
  for (const c of chunks) {
    const text = (c.headingPath ? `[${c.headingPath}]\n${c.text}` : c.text).slice(0, o.maxChunkChars);
    const prev = merged[merged.length - 1];
    if (text.length < o.minChunkChars && prev && prev.headingPath === c.headingPath
      && prev.text.length + text.length <= o.maxChunkChars) {
      prev.text = `${prev.text}\n${text}`;
    } else {
      merged.push({ ord: merged.length, heading: c.heading, headingPath: c.headingPath, text });
    }
  }
  return merged;
}

/**
 * Chunk plain conversational review text: one review per chunk (grouped to ~targetChars).
 * Reviews arrive as lines/blocks of text where each review is separated by blank lines
 * or "- " bullets.
 */
export function chunkReviews(text, opts = {}) {
  const o = { ...DEFAULTS, targetChars: 1200 };
  const merged = { ...o, ...opts };
  // Reviews arrive as plain lines (one review per line) or blank-line separated blocks.
  const rawItems = String(text ?? '')
    .split(/\r?\n/)
    .map((s) => s.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);

  const chunks = [];
  let buf = [];
  let len = 0;
  for (const item of rawItems) {
    if (len > 0 && len + item.length > merged.targetChars) {
      chunks.push({ text: buf.join('\n---\n'), heading: 'reviews', headingPath: 'Reviews' });
      buf = [];
      len = 0;
    }
    buf.push(item);
    len += item.length + 5;
  }
  if (buf.length) chunks.push({ text: buf.join('\n---\n'), heading: 'reviews', headingPath: 'Reviews' });
  return chunks.map((c, ord) => ({ ...c, ord }));
}

// Tolerant parser for REA output (JSON Evidence records or human-readable text)
// → { sections, insights } that ingest turns into knowledge chunks.
import { extractJsonObject, cleanText, truncate } from '../util.js';

const MAX_SECTIONS = 40;
const MAX_ITEMS = 150;

function coerceItems(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((v) => {
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object') {
        const nameish = v.name || v.path || v.id || v.title || v.summary || v.description;
        if (typeof nameish === 'string' && nameish.trim()) {
          const extra = v.detail || v.evidence || v.kind || v.type;
          return extra ? `${nameish} — ${typeof extra === 'string' ? extra : ''}`.trim() : nameish;
        }
        return JSON.stringify(v).slice(0, 300);
      }
      return String(v);
    }).filter((s) => s && s.trim());
  }
  if (typeof value === 'string') return value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'object') {
    return Object.entries(value).slice(0, MAX_ITEMS).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 300));
  }
  return [String(value)];
}

function uniqueCap(list, cap = MAX_ITEMS) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = String(item).toLowerCase().slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(String(item).slice(0, 300));
    if (out.length >= cap) break;
  }
  return out;
}

function insightsFromRecord(rec) {
  const insights = {
    modules: [],
    features: [],
    entryPoints: [],
    stack: [],
    strings: [],
    evidence: [],
  };
  const pick = (obj, keys) => {
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    return undefined;
  };

  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, depth + 1));
      return;
    }
    const modules = pick(node, ['modules', 'module_list', 'javascript_modules']);
    if (modules) insights.modules.push(...coerceItems(modules));
    const features = pick(node, ['features', 'findings', 'capabilities', 'behaviors']);
    if (features) insights.features.push(...coerceItems(features));
    const entries = pick(node, ['entryPoints', 'entry_points', 'entries', 'boundaries']);
    if (entries) insights.entryPoints.push(...coerceItems(entries));
    const stack = pick(node, ['stack', 'runtime', 'technologies', 'tech_stack', 'frameworks']);
    if (stack) insights.stack.push(...coerceItems(stack));
    const strings = pick(node, ['strings', 'string_table', 'notable_strings']);
    if (strings) insights.strings.push(...coerceItems(strings));
    const evidence = pick(node, ['evidence', 'evidence_id', 'evidenceIds']);
    if (evidence) insights.evidence.push(...coerceItems(evidence, 30));
    for (const v of Object.values(node)) visit(v, depth + 1);
  };
  visit(rec);

  for (const key of Object.keys(insights)) {
    insights[key] = uniqueCap(insights[key]);
  }
  return insights;
}

function sectionsFromRecord(rec) {
  const sections = [];
  const addSection = (title, body) => {
    const text = cleanText(Array.isArray(body) ? body.map((b) => (typeof b === 'string' ? b : JSON.stringify(b))).join('\n') : String(body ?? ''));
    if (text && text.length > 3) {
      sections.push({ title: truncate(String(title), 80), text: truncate(text, 16_000) });
    }
  };

  const scalarSections = [];
  const pushScalars = (obj, prefix = '') => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      if (v == null) continue;
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        scalarSections.push({ title: key, text: String(v) });
      } else if (Array.isArray(v)) {
        addSection(key, v.slice(0, MAX_ITEMS));
      } else if (typeof v === 'object') {
        pushScalars(v, key);
      }
    }
  };

  // Top-level descriptive fields first (summary/target/limitations…).
  pushScalars(rec);

  // Large arrays as their own sections.
  for (const key of ['summary', 'limitations', 'unknowns', 'overview', 'description']) {
    if (rec[key] !== undefined) addSection(key, rec[key]);
  }
  if (Array.isArray(rec.graph?.nodes)) {
    addSection('graph.nodes', rec.graph.nodes.slice(0, MAX_ITEMS).map((n) => (typeof n === 'string' ? n : `${n.id || n.node_id || ''} ${n.role || n.type || ''} ${n.path || n.label || ''}`.trim())));
  }

  sections.push(...scalarSections);
  // Dedup by title, cap total.
  const seen = new Set();
  const out = [];
  for (const s of sections) {
    if (seen.has(s.title)) continue;
    seen.add(s.title);
    out.push(s);
    if (out.length >= MAX_SECTIONS) break;
  }
  return out;
}

function sectionsFromText(text) {
  const normalized = cleanText(text);
  // Markdown-ish headings?
  if (/^#{1,6}\s+\S/m.test(normalized)) {
    const sections = [];
    let current = { title: 'overview', lines: [] };
    for (const line of normalized.split('\n')) {
      const m = line.match(/^#{1,6}\s+(.*)$/);
      if (m) {
        if (current.lines.join('').trim()) sections.push({ title: truncate(current.title, 80), text: current.lines.join('\n').trim().slice(0, 16_000) });
        current = { title: m[1].trim(), lines: [] };
      } else {
        current.lines.push(line);
      }
    }
    if (current.lines.join('').trim()) sections.push({ title: truncate(current.title, 80), text: current.lines.join('\n').trim().slice(0, 16_000) });
    if (sections.length) return sections.slice(0, MAX_SECTIONS);
  }
  // Fall back to paragraph blocks.
  return normalized
    .split(/\n{2,}/)
    .map((p, i) => ({ title: `section ${i + 1}`, text: truncate(p.trim(), 8000) }))
    .filter((s) => s.text.length > 20)
    .slice(0, MAX_SECTIONS);
}

/**
 * Parse raw REA output.
 * @returns {{ sections: Array<{title,text}>, insights: object, format: 'json'|'text' }}
 */
export function parseReaOutput(rawText) {
  const text = String(rawText || '');
  const trimmed = text.trim();
  let record = null;
  if (trimmed.startsWith('{')) {
    try {
      record = JSON.parse(trimmed);
    } catch {
      record = extractJsonObject(trimmed);
    }
  }
  if (record && typeof record === 'object') {
    return {
      format: 'json',
      sections: sectionsFromRecord(record),
      insights: insightsFromRecord(record),
    };
  }
  return {
    format: 'text',
    sections: sectionsFromText(text),
    insights: {
      modules: uniqueCap(extractMatches(text, /(?:^|\n)\s*(?:[-*]\s*)?(?:module|file)[\s:]+([\w./@\\:-]+)/gi)),
      features: [],
      entryPoints: uniqueCap(extractMatches(text, /(?:entry[_ ]?point|main)[\s:]+([\w./@\\:-]+)/gi)),
      stack: uniqueCap(extractMatches(text, /\b(electron|node\.?js|chrome|chromium|v8|\.net|mono|python|java|go|rust)\b/gi)),
      strings: [],
      evidence: [],
    },
  };
}

function extractMatches(text, regex) {
  const out = [];
  let m;
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  while ((m = re.exec(text)) !== null && out.length < MAX_ITEMS) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Turn parsed sections into ingestable docs; small sections are grouped together. */
export function reaSectionsToDocs(sections, { target, mode }) {
  const docs = [];
  let pending = [];
  let pendingChars = 0;

  const flushPending = () => {
    if (!pending.length) return;
    docs.push({
      title: `REA · details (${pending.length} sections)`,
      url: '',
      text: pending.map((s) => `${s.title}\n${s.text}`).join('\n\n'),
      label: `REA analysis (${mode}): ${truncate(target, 80)}`,
      kind: 'rea',
      sourceType: 'rea',
    });
    pending = [];
    pendingChars = 0;
  };

  for (const s of sections) {
    const text = `${s.title}\n${s.text}`;
    if (text.length < 30) continue;
    if (text.length >= 50) {
      flushPending();
      docs.push({
        title: `REA · ${s.title}`,
        url: '',
        text,
        label: `REA analysis (${mode}): ${truncate(target, 80)}`,
        kind: 'rea',
        sourceType: 'rea',
      });
    } else {
      pending.push(s);
      pendingChars += text.length;
      if (pendingChars > 1500) flushPending();
    }
  }
  flushPending();
  return docs;
}

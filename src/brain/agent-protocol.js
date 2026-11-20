// Model-facing protocol parsing for the mascot brain.
//
//   {"mascot_tool":{"name":"search_knowledge","query":"…"}}   → extra retrieval round
//   {"mascot_action":{"name":"…","args":{…}}}                 → host action / escalation
//
// Both must appear as the final construct of a reply. Parsing is lenient about
// markdown fences and whitespace; everything before the protocol line is
// user-visible text.
import { extractJsonObject } from '../util.js';

const PROTOCOL_OPEN_RE = /(?:```json[ \t]*\r?\n)?[ \t]*\{\s*"mascot_(tool|action)"/g;
export const STREAM_TAIL_GUARD = 48; // chars held back while streaming so protocol JSON never leaks

export function findProtocolStart(text) {
  PROTOCOL_OPEN_RE.lastIndex = 0;
  let last = null;
  let m;
  while ((m = PROTOCOL_OPEN_RE.exec(text)) !== null) last = m;
  return last ? { index: last.index, kind: last[1] } : null;
}

/** Split a model reply into visible text + tool request + host action. */
export function parseProtocol(text) {
  let visible = String(text || '');
  let toolRequest = null;
  let action = null;
  const found = findProtocolStart(visible);
  if (found) {
    const candidate = extractJsonObject(visible.slice(found.index));
    if (candidate && typeof candidate === 'object') {
      if (found.kind === 'tool' && candidate.mascot_tool?.name) {
        const t = candidate.mascot_tool;
        toolRequest = {
          name: String(t.name || '').slice(0, 60),
          query: String(t.query || '').slice(0, 400),
          tool: t.tool ? String(t.tool).slice(0, 60) : undefined,
          args: (t.args && typeof t.args === 'object') ? t.args : undefined,
        };
        visible = visible.slice(0, found.index);
      } else if (found.kind === 'action' && candidate.mascot_action?.name) {
        action = {
          name: String(candidate.mascot_action.name),
          args: (candidate.mascot_action.args && typeof candidate.mascot_action.args === 'object')
            ? candidate.mascot_action.args
            : {},
        };
        visible = visible.slice(0, found.index);
      }
    }
  }
  // Clean fence remnants left behind by removal.
  visible = visible
    .replace(/```json\s*$/i, '')
    .replace(/```\s*$/i, '')
    .replace(/\n{3,}$/g, '\n\n')
    .trimEnd();
  return { visible, toolRequest, action };
}

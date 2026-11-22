// Mascotly agentic loop — the LLM decides what to do at each step.
//
// Pattern (Anthropic's canonical agent loop): gather context → take action →
// observe result → repeat until the goal is achieved. The LLM is the
// orchestrator; tools are the interface; the loop is the engine.
//
// The loop is provider-agnostic: it works with any LLM via the existing
// chat/stream interface, using the JSON tool protocol for tool calls.
//
// Used by:
//   • chat (astra tier) — the mascot chains tools for complex questions
//   • forge — the LLM drives the entire repo→bot pipeline via tools
//   • MCP — agents orchestrate Mascotly's capabilities
import { truncate, extractJsonObject } from './util.js';

/**
 * Parse tool calls from an LLM reply.
 * Supports both the mascot protocol and a generic multi-tool format:
 *   {"tool_calls":[{"name":"…","args":{…}}, …]}           — multiple calls
 *   {"mascot_tool":{"name":"…",…}}                          — legacy single call
 *   {"mascot_action":{"name":"…","args":{…}}}               — host action
 * @returns {{ visible: string, calls: Array<{name, args}>, action: object|null }}
 */
export function parseAgentReply(text) {
  const raw = String(text || '');
  let visible = raw;
  let calls = [];
  let action = null;

  // Extract balanced JSON objects — no regex lazy-match pitfalls with nested braces.
  const tryExtract = (text2, marker) => {
    const idx = text2.indexOf(marker);
    if (idx === -1) return null;
    const obj = extractJsonObject(text2.slice(idx));
    return obj;
  };

  // Multi-tool format: {"tool_calls":[…]}
  const multiObj = tryExtract(visible, '{"tool_calls"');
  if (multiObj && Array.isArray(multiObj.tool_calls)) {
    calls = multiObj.tool_calls.map((tc) => ({
      name: String(tc.name || tc.tool || '').slice(0, 60),
      args: (tc.args && typeof tc.args === 'object') ? tc.args : {},
    })).filter((tc) => tc.name);
    if (calls.length) {
      // Remove the tool_calls JSON from the visible text.
      const start = visible.indexOf('{"tool_calls"');
      const depth = { cur: 0, start: -1, end: -1, inStr: false, esc: false };
      for (let i = start; i < visible.length; i++) {
        const ch = visible[i];
        if (depth.inStr) { if (depth.esc) depth.esc = false; else if (ch === '\\') depth.esc = true; else if (ch === '"') depth.inStr = false; continue; }
        if (ch === '"') depth.inStr = true;
        else if (ch === '{') { if (depth.cur === 0) depth.start = i; depth.cur++; }
        else if (ch === '}') { depth.cur--; if (depth.cur === 0) { depth.end = i + 1; break; } }
      }
      if (depth.end > start) visible = visible.slice(0, start) + visible.slice(depth.end);
      visible = visible.trim();
    }
  }

  // Legacy single-tool protocol: {"mascot_tool":{…}}
  if (!calls.length) {
    const singleObj = tryExtract(visible, '{"mascot_tool"');
    if (singleObj && singleObj.mascot_tool) {
      const t = singleObj.mascot_tool;
      if (t.name) {
        calls.push({
          name: String(t.name).slice(0, 60),
          args: { ...(t.args && typeof t.args === 'object' ? t.args : {}), ...(t.query ? { query: t.query } : {}), ...(t.tool ? { tool: t.tool } : {}) },
        });
        // Remove from visible text
        const start = visible.indexOf('{"mascot_tool"');
        const depth = { cur: 0, start: -1, end: -1, inStr: false, esc: false };
        for (let i = start; i < visible.length; i++) {
          const ch = visible[i];
          if (depth.inStr) { if (depth.esc) depth.esc = false; else if (ch === '\\') depth.esc = true; else if (ch === '"') depth.inStr = false; continue; }
          if (ch === '"') depth.inStr = true;
          else if (ch === '{') { if (depth.cur === 0) depth.start = i; depth.cur++; }
          else if (ch === '}') { depth.cur--; if (depth.cur === 0) { depth.end = i + 1; break; } }
        }
        if (depth.end > start) visible = visible.slice(0, start) + visible.slice(depth.end);
        visible = visible.trim();
      }
    }
  }

  // Host action: {"mascot_action":{…}}
  const actionObj = tryExtract(visible, '{"mascot_action"');
  if (actionObj && actionObj.mascot_action?.name) {
    action = {
      name: String(actionObj.mascot_action.name),
      args: (actionObj.mascot_action.args && typeof actionObj.mascot_action.args === 'object')
        ? actionObj.mascot_action.args : {},
    };
    // Remove from visible text
    const start = visible.indexOf('{"mascot_action"');
    if (start !== -1) {
      const depth = { cur: 0, end: -1, inStr: false, esc: false };
      for (let i = start; i < visible.length; i++) {
        const ch = visible[i];
        if (depth.inStr) { if (depth.esc) depth.esc = false; else if (ch === '\\') depth.esc = true; else if (ch === '"') depth.inStr = false; continue; }
        if (ch === '"') depth.inStr = true;
        else if (ch === '{') { depth.cur++; }
        else if (ch === '}') { depth.cur--; if (depth.cur === 0) { depth.end = i + 1; break; } }
      }
      if (depth.end > start) visible = visible.slice(0, start) + visible.slice(depth.end);
    }
  }

  // Clean up fence remnants
  visible = visible
    .replace(/```json\s*$/i, '')
    .replace(/```\s*$/i, '')
    .replace(/\n{3,}$/g, '\n\n')
    .trimEnd();

  return { visible, calls, action };
}

/**
 * The core agentic loop: think → act → observe → repeat.
 *
 * @param {object} p
 * @param {object} p.llm — LLM client (from getLlm / router)
 * @param {Array<{name, description, execute}>} p.tools — available tools
 * @param {Array<{role, content}>} p.messages — conversation so far (system + user)
 * @param {number} [p.maxSteps] — max agentic steps (default 8)
 * @param {function} [p.onStep] — (step, toolName, args) => void
 * @param {object} [p.opts] — { temperature, maxTokens }
 * @returns {Promise<{ text: string, steps: Array<{tool, args, result}>, actions: Array }>}
 */
export async function runAgentLoop(p) {
  const { llm, tools, maxSteps = 8, onStep = () => {}, opts = {} } = p;
  const messages = [...p.messages];
  const steps = [];
  const actions = [];

  for (let step = 0; step < maxSteps; step++) {
    const response = await llm.chat(messages, {
      temperature: opts.temperature ?? 0.4,
      maxTokens: opts.maxTokens ?? 1600,
    });
    const raw = response.text || '';

    const { visible, calls, action } = parseAgentReply(raw);

    // No tool calls → the LLM is done. Return the visible text.
    if (!calls.length) {
      if (action) actions.push(action);
      return { text: visible || raw.trim(), steps, actions };
    }

    // Record the assistant's tool-call message.
    messages.push({ role: 'assistant', content: truncate(raw, 3000) });

    // Execute each tool call and feed results back.
    for (const call of calls) {
      const tool = tools.find((t) => t.name === call.name);
      onStep(step, call.name, call.args);

      let result;
      if (!tool) {
        result = { error: `Unknown tool: ${call.name}. Available: ${tools.map((t) => t.name).join(', ')}` };
      } else {
        try {
          result = await tool.execute(call.args || {});
        } catch (err) {
          result = { error: String(err.message || err).slice(0, 500) };
        }
      }

      steps.push({ step, tool: call.name, args: call.args, result });
      messages.push({
        role: 'user',
        content: `[Tool result: ${call.name}]\n${truncate(JSON.stringify(result), 6000)}\n\nContinue. You may call another tool or give your final answer.`,
      });
    }

    // Host action detected alongside tool calls — emit after loop.
    if (action) actions.push(action);
  }

  // Max steps reached — force a final answer.
  messages.push({
    role: 'user',
    content: 'You have used all available steps. Give your final answer now based on what you have gathered. No more tool calls.',
  });
  const final = await llm.chat(messages, {
    temperature: opts.temperature ?? 0.4,
    maxTokens: opts.maxTokens ?? 1600,
  });
  const { visible, action } = parseAgentReply(final.text || '');
  if (action) actions.push(action);
  return { text: visible || '', steps, actions };
}

/**
 * Build a system prompt for the agentic loop from a tool registry.
 * @param {string} role — the agent's identity/role
 * @param {Array<{name, description}>} tools
 * @param {string} guardrails — shared guardrails from prompts.js
 * @param {string} extra — additional context (knowledge, profile, etc.)
 */
export function buildAgentSystemPrompt(role, tools, guardrails, extra = '') {
  const toolLines = tools.map((t) =>
    `- ${t.name}: ${truncate(t.description, 220)}`
  ).join('\n');
  return [
    role,
    '',
    '# Tools available to you',
    'To use a tool, include a JSON block in your reply:',
    '{"tool_calls":[{"name":"<tool-name>","args":{...}}]}',
    'You can include multiple tool calls in one block. After each tool call, you will see the result and can continue.',
    'When you have enough information, give your final answer WITHOUT any tool call block.',
    '',
    '## Tools',
    toolLines,
    '',
    extra,
    '',
    guardrails,
  ].join('\n');
}

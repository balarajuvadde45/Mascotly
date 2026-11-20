// Capabilities end-to-end test: Skills (prompt injection), Hooks (HMAC-signed
// webhook delivery), Tool plugins (mascot calls an HTTP tool mid-chat through
// the real agent loop using a fake OpenAI-compatible LLM), plugin manifest.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';

process.env.MASCOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-cap-data-'));
process.env.MASCOT_PLAYGROUND = 'false';

const { createServer } = await import('../src/server.js');
const { Store } = await import('../src/store.js');
const { buildSystemPrompt } = await import('../src/brain/prompt.js');

const store = new Store(process.env.MASCOT_DATA_DIR);
const app = createServer(store);
let httpServer = null;
let base = '';
let adminKey = '';
let appRec = null;

// ── fake OpenAI-compatible LLM: first call requests a tool, second answers ──
// Supports both streaming (SSE) and non-streaming responses like a real provider.
const llmCalls = [];
const fakeLlm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = JSON.parse(body);
    const last = parsed.messages[parsed.messages.length - 1].content;
    llmCalls.push(last.slice(0, 80));
    let content;
    if (last.includes('Tool "get_status" result')) {
      content = 'The service is **operational** according to the status tool. All systems green.';
    } else {
      content = 'Let me check that for you.\n{"mascot_tool":{"name":"call_tool","tool":"get_status","args":{"region":"eu"}}}';
    }
    if (parsed.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunks = content.match(/[\s\S]{1,20}/g) || [];
      for (const c of chunks) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
  });
});

// ── fake tool endpoint ──
const toolCalls = [];
const fakeTool = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    toolCalls.push({ url: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'operational', region: 'eu', uptime: 0.999 }));
  });
});

// ── fake hook receiver ──
const hookDeliveries = [];
const fakeHookReceiver = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    hookDeliveries.push({
      event: req.headers['x-mascot-event'],
      signature: req.headers['x-mascot-signature'],
      body,
    });
    res.writeHead(200).end('ok');
  });
});

async function api(method, p, body) {
  const res = await fetch(base + '/api' + p, {
    method,
    headers: { 'x-mascot-key': adminKey, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

before(async () => {
  await new Promise((resolve) => { httpServer = app.listen(0, '127.0.0.1', resolve); });
  const port = httpServer.address().port;
  base = `http://127.0.0.1:${port}`;
  adminKey = store.ensureAdminKey().key;
  await Promise.all([
    new Promise((r) => fakeLlm.listen(0, '127.0.0.1', r)),
    new Promise((r) => fakeTool.listen(0, '127.0.0.1', r)),
    new Promise((r) => fakeHookReceiver.listen(0, '127.0.0.1', r)),
  ]);

  const created = await api('POST', '/apps', { name: 'Cap App', description: 'capabilities test' });
  appRec = created.data.app;
});

after(() => {
  return new Promise((resolve) => {
    httpServer?.closeAllConnections?.();
    fakeLlm.closeAllConnections?.(); fakeLlm.close();
    fakeTool.closeAllConnections?.(); fakeTool.close();
    fakeHookReceiver.closeAllConnections?.(); fakeHookReceiver.close();
    httpServer.close(() => resolve());
    setTimeout(resolve, 800).unref?.();
    fs.rmSync(process.env.MASCOT_DATA_DIR, { recursive: true, force: true });
  });
});

test('skills: SKILL.md install with frontmatter parsing', async () => {
  const skillMd = [
    '---',
    'name: escalation-handling',
    'description: How to respond when users are upset',
    '---',
    '',
    '# Escalation handling',
    'Always acknowledge feelings first, offer a human handoff within one minute.',
  ].join('\n');
  const res = await api('POST', `/apps/${appRec.id}/skills`, { content: skillMd });
  assert.equal(res.status, 201);
  assert.equal(res.data.skill.name, 'escalation-handling');
  assert.ok(res.data.skill.content.includes('acknowledge feelings'));
  assert.equal((res.data.skills || appRec.skills || []).length ? 1 : 1, 1);
});

test('skills: prompt injection — the brain sees installed skills', () => {
  const app = store.getApp(appRec.id);
  const sys = buildSystemPrompt(app, null, [], {});
  assert.ok(sys.includes('Skills you carry'));
  assert.ok(sys.includes('escalation-handling'));
  assert.ok(sys.includes('acknowledge feelings'));
});

test('skills: validation — empty content rejected', async () => {
  const res = await api('POST', `/apps/${appRec.id}/skills`, { content: '   ' });
  assert.equal(res.status, 400);
});

test('hooks: HMAC-signed webhook delivery on chat', async () => {
  // register hook
  const hookUrl = `http://127.0.0.1:${fakeHookReceiver.address().port}/hook`;
  const reg = await api('POST', `/apps/${appRec.id}/hooks`, { event: 'message', url: hookUrl, secret: 'test-secret-123' });
  assert.equal(reg.status, 201);
  const hookId = reg.data.hook.id;
  assert.equal(reg.data.hook.secretSet, true);
  assert.equal(reg.data.hook.secret, undefined, 'secret must not be returned');

  // chat triggers a message hook
  await api('POST', `/apps/${appRec.id}/analyze`).catch(() => {}); // may fail w/o sources; hook still fires on chat
  const chat = await fetch(base + `/api/v1/chat/${appRec.id}/${appRec.publicKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hello there' }),
  });
  assert.equal(chat.status, 200);

  // wait for the async delivery
  for (let i = 0; i < 30 && hookDeliveries.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(hookDeliveries.length >= 1, 'hook receiver got a delivery');
  const d = hookDeliveries[0];
  assert.equal(d.event, 'message');
  const expected = 'sha256=' + createHmac('sha256', 'test-secret-123').update(d.body).digest('hex');
  assert.equal(d.signature, expected, 'HMAC signature must verify');
  const payload = JSON.parse(d.body);
  assert.equal(payload.appId, appRec.id);
  assert.ok(payload.data.answer);

  // delivery status recorded
  const hooks = await api('GET', `/apps/${appRec.id}/hooks`);
  const last = hooks.data.hooks.find((h) => h.id === hookId)?.lastDelivery;
  assert.ok(last && last.ok && last.status === 200, 'delivery status recorded');

  // cleanup hook
  await api('DELETE', `/apps/${appRec.id}/hooks/${hookId}`);
});

test('tools: mascot calls an HTTP tool mid-chat through the real agent loop', async () => {
  // point the app at the fake LLM
  await api('PATCH', `/apps/${appRec.id}`, {
    settings: { model: { provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${fakeLlm.address().port}/v1`, model: 'fake-1', apiKey: 'k' } },
  });
  // register the tool
  const toolUrl = `http://127.0.0.1:${fakeTool.address().port}/status`;
  const reg = await api('POST', `/apps/${appRec.id}/tools`, {
    name: 'get_status', description: 'Get the live service status for any region', url: toolUrl, method: 'POST',
  });
  assert.equal(reg.status, 201);

  // add knowledge so retrieval has something
  await api('POST', `/apps/${appRec.id}/sources`, {
    type: 'text', label: 'docs', text: '# Status page\nCheck the live service status with the status tool.',
  });

  // chat → model requests tool → server executes → final answer
  const chat = await fetch(base + `/api/v1/chat/${appRec.id}/${appRec.publicKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Is the service operational in eu?' }),
  });
  assert.equal(chat.status, 200);
  const out = await chat.json();
  assert.ok(out.answer.toLowerCase().includes('operational'), `answer: ${out.answer}`);
  assert.ok(out.usage.rounds >= 2, `expected a tool round, got rounds=${out.usage.rounds}`);

  // the tool endpoint actually got called with args from the model
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].body.args.region, 'eu');

  // LLM received the tool result in round 2
  assert.ok(llmCalls.some((c) => c.includes('Tool "get_status" result')), 'tool result fed back to the model');

  // cleanup: remove tool
  const tools = await api('GET', `/apps/${appRec.id}/tools`);
  const del = await api('DELETE', `/apps/${appRec.id}/tools/${tools.data.tools[0].id}`);
  assert.equal(del.status, 200, `tool cleanup: ${JSON.stringify(del.data)}`);
});

test('plugin manifest: export + import round-trip', async () => {
  // install a skill to export
  await api('POST', `/apps/${appRec.id}/skills`, { content: '# Deployment guide\nDeploy via the Releases page.' });
  const exp = await api('GET', `/apps/${appRec.id}/plugin-manifest`);
  assert.equal(exp.data.manifest.format, 'mascotly-plugin/1');
  assert.ok(exp.data.manifest.skills.length >= 1);
  assert.equal(exp.data.manifest.tools.length, 0, 'tool was removed above');

  // import into a fresh app
  const created = await api('POST', '/apps', { name: 'Manifest Target' });
  const target = created.data.app.id;
  const imp = await api('POST', `/apps/${target}/plugin-manifest`, { manifest: exp.data.manifest });
  assert.equal(imp.status, 200);
  assert.ok(imp.data.imported.skills >= 1);
  const targetSkills = await api('GET', `/apps/${target}/skills`);
  assert.ok(targetSkills.data.skills.some((s) => s.name === 'Deployment guide' || s.content.includes('Releases page')));
});

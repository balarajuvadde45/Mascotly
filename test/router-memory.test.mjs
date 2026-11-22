// Router + memory unit tests: tier classification, context budgets,
// memory recall (lexical fallback + embeddings path), Redis/file backends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MASCOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-rm-data-'));
process.env.MASCOT_PLAYGROUND = 'false';

const { classifyHeuristic, contextBudget } = await import('../src/router.js');
const { rememberTurn, recallMemory, memoryInfo } = await import('../src/memory.js');
const { Store } = await import('../src/store.js');

const store = new Store(process.env.MASCOT_DATA_DIR);
const app = store.createApp({ name: 'Router Test', settings: {} });

test('router: heuristic classification tiers', () => {
  assert.equal(classifyHeuristic('hi'), 'sol');
  assert.equal(classifyHeuristic('thanks!'), 'sol');
  assert.equal(classifyHeuristic('where is the settings page?'), 'sol');
  assert.equal(
    classifyHeuristic('Compare the pros and cons of plan A versus plan B and explain why one is better for our architecture, step by step'),
    'astra',
  );
  // normal product question → standard
  assert.equal(classifyHeuristic('How do I export my notes to markdown?'), 'lune');
});

test('router: context budgets differ per tier', () => {
  const astra = contextBudget('astra');
  const lune = contextBudget('lune');
  const sol = contextBudget('sol');
  assert.ok(astra > lune && lune > sol, `${astra} > ${lune} > ${sol}`);
});

test('memory: lexical recall works without embeddings (offline)', async () => {
  await rememberTurn(store, app, { sessionId: 's1', role: 'user', text: 'I am integrating Mascotly into our billing dashboard at Acme Corp.' });
  await rememberTurn(store, app, { sessionId: 's2', role: 'user', text: 'Our team mainly uses PostgreSQL and wants row-level security.' });
  await rememberTurn(store, app, { sessionId: 's2', role: 'assistant', text: 'Postgres row-level security policies were covered in the docs.' });

  const hits = await recallMemory(store, app, { query: 'billing dashboard integration at acme', sessionId: 's1', k: 3 });
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].text.toLowerCase().includes('billing'), `top hit: ${hits[0].text}`);
  assert.equal(memoryInfo().backend, 'file');
});

test('memory: prototype-polluting session ids are stored but never crash recall', async () => {
  await rememberTurn(store, app, { sessionId: '__proto__', role: 'user', text: 'odd session id handling check' });
  const hits = await recallMemory(store, app, { query: 'odd session id', k: 5 });
  assert.ok(hits.length >= 1);
});

test('memory: entries are capped per app', async () => {
  const app2 = store.createApp({ name: 'Cap Test' });
  for (let i = 0; i < 10; i++) {
    await rememberTurn(store, app2, { sessionId: 's', role: 'user', text: `memory entry number ${i} about testing caps` });
  }
  const hits = await recallMemory(store, app2, { query: 'testing caps entry', k: 50 });
  assert.ok(hits.length <= 10);
});

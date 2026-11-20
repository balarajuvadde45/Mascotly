// Unit tests: store, chunker, retriever, tokenizer, html conversion, protocol parser, REA parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MASCOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-test-data-'));
process.env.MASCOT_PLAYGROUND = 'false';

const { Store } = await import('../src/store.js');
const { chunkText, chunkReviews } = await import('../src/knowledge/chunker.js');
const { Retriever, makeSnippet } = await import('../src/knowledge/retriever.js');
const { tokenize } = await import('../src/knowledge/tokenize.js');
const { htmlToMarkdownLite, extractLinks, parseRobots } = await import('../src/knowledge/crawler.js');
const { parseProtocol } = await import('../src/brain/agent-protocol.js');
const { parseReaOutput, reaSectionsToDocs } = await import('../src/rea/parser.js');
const { MockLlm } = await import('../src/providers/llm.js');

// ---------- store ----------
test('store: app lifecycle + persistence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-store-'));
  const store = new Store(dir);
  const app = store.createApp({ name: 'Test App' });
  assert.ok(app.id.startsWith('app_'));
  assert.ok(app.publicKey.length >= 24);
  assert.notEqual(app.secretKey, app.publicKey);

  // Sources/chunks/profile (flush the debounced writer before re-reading from disk)
  store.saveSources(app.id, [{ id: 'src_1', type: 'text', label: 'L' }]);
  store.saveChunks(app.id, [{ id: 'ch_1', text: 'hello world' }]);
  store.saveProfile(app.id, { summary: 's' });
  store.saveSession(app.id, { id: 'ses_1', createdAt: 't', updatedAt: 't', messages: [] });
  store.flushAll();

  // Read from a second Store instance over the same dir.
  const store2 = new Store(dir);
  const loaded = store2.getApp(app.id);
  assert.equal(loaded.name, 'Test App');
  assert.equal(store2.listApps().length, 1);

  assert.equal(store2.getSources(app.id)[0].id, 'src_1');
  assert.equal(store2.getChunks(app.id).length, 1);
  assert.equal(store2.getProfile(app.id).summary, 's');
  assert.ok(store2.getSession(app.id, 'ses_1'));
  assert.equal(store2.listSessions(app.id).length, 1);
  assert.equal(store2.getSession(app.id, '../evil'), null);
  assert.equal(store.deleteSession(app.id, 'ses_1'), true);

  // Delete
  store.deleteApp(app.id);
  assert.equal(store.getApp(app.id), null);
  assert.equal(store.listApps().length, 0);
  assert.equal(new Store(dir).listApps().length, 0);
});

// ---------- chunker ----------
test('chunker: heading-aware splitting + breadcrumbs', () => {
  const md = [
    '# Guide',
    '## Install',
    'Run npm install to add the package. ' + 'Details follow here. '.repeat(20),
    '## Usage',
    'Import and call the function. It returns a promise.',
    '### Advanced',
    'Options can be passed as the second argument.',
  ].join('\n');
  const chunks = chunkText(md, { targetChars: 200 });
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.some((c) => c.headingPath.includes('Install')));
  assert.ok(chunks.some((c) => c.text.startsWith('[Guide › Usage')));
  assert.ok(chunks.every((c) => c.text.length <= 2400));
});

test('chunker: long paragraphs get sentence-split with overlap', () => {
  const long = 'This is a sentence about alpha. '.repeat(80);
  const chunks = chunkText(long, { targetChars: 300, maxChunkChars: 900 });
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.text.length <= 950));
});

test('chunker: fenced code blocks stay atomic', () => {
  const md = '## Code\n```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\nAfter.';
  const chunks = chunkText(md);
  const codeChunk = chunks.find((c) => c.text.includes('const a = 1;'));
  assert.ok(codeChunk);
  assert.ok(codeChunk.text.includes('const c = 3;'), 'code block must not be split mid-fence');
});

test('chunkReviews: groups review lines', () => {
  const reviews = Array.from({ length: 30 }, (_, i) => `Review ${i}: the app is great and I use it daily for notes ${i}.`).join('\n');
  const chunks = chunkReviews(reviews, { targetChars: 500 });
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].headingPath === 'Reviews');
});

// ---------- retriever ----------
function makeCorpus() {
  return [
    { id: 'c1', text: 'Aurora Notes syncs notes end-to-end encrypted between devices. Pair with a 6-character code.', headingPath: 'Sync', meta: { label: 'docs' } },
    { id: 'c2', text: 'Quick Capture opens with Cmd+Shift+Space from anywhere in the OS.', headingPath: 'Capture', meta: { label: 'docs' } },
    { id: 'c3', text: 'The graph view renders connections between notes with backlinks.', headingPath: 'Graph', meta: { label: 'docs' } },
    { id: 'c4', text: 'Aurora is a fictional note app used for testing retrieval quality.', headingPath: 'About', meta: { label: 'docs' } },
  ];
}

test('retriever: bm25 finds the right chunk', () => {
  const r = new Retriever(makeCorpus());
  const results = r.search('how does encrypted sync work', { k: 2 });
  assert.ok(results.length >= 1);
  assert.equal(results[0].chunk.id, 'c1');
  assert.ok(results[0].score > 0);
});

test('retriever: hybrid local vectors fuse with bm25', () => {
  const r = new Retriever(makeCorpus());
  assert.ok(r.localVectors, 'local tfidf vectors should exist without dense embeddings');
  const results = r.search('keyboard shortcut for capture', { k: 3 });
  assert.equal(results[0].chunk.id, 'c2');
  const results2 = r.search('backlinks graph', { k: 3 });
  assert.equal(results2[0].chunk.id, 'c3');
});

test('retriever: empty corpus and dense-vector path', () => {
  const empty = new Retriever([]);
  assert.deepEqual(empty.search('anything', { k: 2 }), []);

  const corpus = makeCorpus().map((c, i) => ({ ...c, embedding: i === 0 ? [1, 0, 0, 0] : [0, 1, 0, 0] }));
  const r = new Retriever(corpus);
  const results = r.search('sync encryption', { k: 1, queryEmbedding: [1, 0.1, 0, 0] });
  assert.equal(results[0].chunk.id, 'c1');
});

test('makeSnippet centers on query terms', () => {
  const text = ('filler '.repeat(60)) + ' KEYWORD-TARGET-HERE ' + ('tail '.repeat(60));
  const s = makeSnippet(text, ['keyword-target-here'], 120);
  assert.ok(s.includes('KEYWORD-TARGET-HERE'));
  assert.ok(s.length <= 240);
});

test('tokenizer: stopwords and tokens', () => {
  const toks = tokenize('How does the Sync work? the-the 42x beta-version');
  assert.ok(toks.includes('sync'));
  assert.ok(!toks.includes('the'));
  assert.ok(toks.includes('42x'));
  assert.ok(toks.includes('beta-version'));
});

// ---------- crawler html ----------
test('htmlToMarkdownLite: strips scripts, keeps headings and title', () => {
  const html = `<html><head><title>Docs | MyApp</title><style>.x{color:red}</style></head>
  <body><nav>Home About</nav><main><h1>Welcome</h1><p>Hello <b>world</b> &amp; friends.</p>
  <script>alert('evil')</script><ul><li>Item one</li><li>Item two</li></ul>
  <pre><code>npm install myapp</code></pre></main><footer>copyright</footer></body></html>`;
  const { title, text } = htmlToMarkdownLite(html);
  assert.equal(title, 'Docs | MyApp');
  assert.ok(!text.includes('alert'));
  assert.ok(!text.includes('copyright'));
  assert.ok(!text.includes('<b>'));
  assert.ok(text.includes('## Welcome'));
  assert.ok(text.includes('- Item one'));
  assert.ok(text.includes('npm install myapp'));
  assert.ok(text.includes('& friends'.replace('&', '&')), 'entities decoded');
});

test('extractLinks resolves relative URLs', () => {
  const links = extractLinks('<a href="/docs/a">a</a> <a href="https://x.dev/b">b</a> <a href="mailto:x@y.z">m</a>', 'https://app.dev/guide/');
  assert.ok(links.includes('https://app.dev/docs/a'));
  assert.ok(links.includes('https://x.dev/b'));
  assert.ok(!links.some((l) => l.startsWith('mailto')));
});

test('robots parsing: disallow/allow with longest-match', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/public/\nCrawl-delay: 2');
  assert.equal(rules.disallow.length, 1);
  assert.equal(rules.crawlDelay, 2);
});

// ---------- brain protocol ----------
test('parseProtocol: plain answer untouched', () => {
  const { visible, toolRequest, action } = parseProtocol('Hello world, this is an answer.');
  assert.equal(visible, 'Hello world, this is an answer.');
  assert.equal(toolRequest, null);
  assert.equal(action, null);
});

test('parseProtocol: tool request (fenced and bare)', () => {
  const a = parseProtocol('Let me look that up.\n```json\n{"mascot_tool":{"name":"search_knowledge","query":"pricing"}}\n```');
  assert.equal(a.toolRequest.query, 'pricing');
  assert.equal(a.visible, 'Let me look that up.');

  const b = parseProtocol('Looking...\n{"mascot_tool":{"name":"search_knowledge","query":"sync"}}');
  assert.equal(b.toolRequest.query, 'sync');
});

test('parseProtocol: host action', () => {
  const r = parseProtocol('Opening that for you.\n{"mascot_action":{"name":"navigate","args":{"url":"https://x.dev"}}}');
  assert.equal(r.action.name, 'navigate');
  assert.equal(r.action.args.url, 'https://x.dev');
  assert.equal(r.visible, 'Opening that for you.');
});

test('parseProtocol: ignores non-protocol JSON', () => {
  const r = parseProtocol('Here is config:\n```json\n{"model":"gpt"}\n```');
  assert.equal(r.toolRequest, null);
  assert.equal(r.action, null);
  assert.ok(r.visible.includes('"model":"gpt"'));
});

// ---------- REA parser ----------
test('rea parser: JSON evidence record → sections + insights', () => {
  const json = JSON.stringify({
    target: '/app/electron.asar',
    summary: 'An Electron note-taking app.',
    modules: [{ path: 'main.js' }, { path: 'renderer/notes.js' }, 'preload.js'],
    features: ['window management', 'markdown editor', 'auto-update'],
    entry_points: ['main.js'],
    runtime: 'electron 30 / node 20',
    strings: ['menu.file.open', 'settings.sync'],
    graph: { nodes: [{ id: 'n1', path: 'main.js', role: 'entry' }] },
    limitations: ['static analysis only'],
  });
  const parsed = parseReaOutput(json);
  assert.equal(parsed.format, 'json');
  assert.ok(parsed.sections.length >= 4);
  assert.ok(parsed.insights.modules.includes('main.js'));
  assert.ok(parsed.insights.features.some((f) => f.includes('markdown editor')));
  assert.ok(parsed.insights.stack.includes('electron 30 / node 20'));
  const docs = reaSectionsToDocs(parsed.sections, { target: '/app', mode: 'rea' });
  assert.ok(docs.length >= 4);
  assert.ok(docs[0].title.startsWith('REA ·'));
});

test('rea parser: text fallback → sections', () => {
  const text = '# Analysis\n\nThe app is an Electron bundle.\n\n## Modules\n\nmain.js\nrenderer.js\n';
  const parsed = parseReaOutput(text);
  assert.equal(parsed.format, 'text');
  assert.ok(parsed.sections.length >= 2);
  assert.ok(parsed.sections.some((s) => s.title === 'Analysis'));
});

// ---------- mock llm ----------
test('mock llm: composes an answer from knowledge blocks', async () => {
  const llm = new MockLlm({ provider: 'mock' });
  const system = 'Knowledge:\n[1] (docs · https://x.dev)Aurora syncs notes with end-to-end encryption between devices.\n\n[2] (docs)Quick Capture uses Cmd+Shift+Space.';
  const res = await llm.chat([
    { role: 'system', content: system },
    { role: 'user', content: 'How does sync work?' },
  ]);
  assert.ok(res.text.includes('Aurora syncs notes'));

  const greet = await llm.chat([{ role: 'system', content: '' }, { role: 'user', content: 'hello' }]);
  assert.ok(greet.text.toLowerCase().includes('hello'));
});

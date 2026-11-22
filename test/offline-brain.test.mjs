// Offline answer synthesis engine — the use-case matrix.
// Every answer must be COMPOSED from knowledge (intent-aware, cited, varied),
// never a raw excerpt dump.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MASCOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-offline-data-'));
process.env.MASCOT_PLAYGROUND = 'false';

const { synthesizeAnswer } = await import('../src/brain/offline.js');

const app = {
  id: 'app_test', name: 'Docsify', slug: 'docsify', description: 'docs generator',
  mascot: { name: 'Docsy', emoji: '📚', tagline: 'Docsify docs assistant' },
  settings: {},
};
const profile = {
  summary: 'Docsify turns markdown into documentation sites instantly.',
  features: ['Quick start', 'Plugins', 'Themes', 'Full-text search'],
  suggestions: ['How do I get started?', 'What plugins exist?'],
  audience: 'developers',
};

const mk = (id, headingPath, text) => ({
  chunk: { id, text, headingPath, meta: { label: 'Docsify docs' } },
  rank: parseInt(id, 10),
});
const contexts = [
  mk('0', 'What is docsify', 'Docsify is a magical documentation site generator. It requires no statically built HTML files. Instead, it dynamically loads and parses your markdown files and displays them as a website.'),
  mk('1', 'Quick start', 'To get started, create an index.html file and deploy it on GitHub Pages. Add the docsify script tag to your index.html and place your markdown files next to it.'),
  mk('2', 'Plugins — full text search', 'The full-text search plugin adds a smart search bar to your documentation. Add search.min.js to your index.html to enable it.'),
  mk('3', 'Themes', 'Docsify ships multiple themes. You can switch themes by changing the CSS link in index.html.'),
];
const citationsFor = (results) => results.map((r, i) => ({
  n: i + 1, chunkId: r.chunk.id, label: 'Docsify docs', url: 'https://docsify.js.org', snippet: r.chunk.text.slice(0, 100),
}));

function ask(question, extra = {}) {
  const ctx = extra.contexts || contexts;
  return synthesizeAnswer({
    question, contexts: ctx, citations: citationsFor(ctx), app, profile,
    history: extra.history || [], showOfflineNote: true,
  });
}

test('definition: "What is docsify?" leads with a real definition', () => {
  const { text, used } = ask('What is docsify?');
  assert.ok(used > 0, 'uses knowledge');
  assert.ok(text.includes('documentation site generator'), `composes the definition: ${text.slice(0, 160)}`);
  assert.ok(/\[1\]/.test(text), 'cites sources inline');
  assert.ok(!text.includes("Here's what I found in the app knowledge"), 'no excerpt-dump template');
  assert.ok(!/^- \[/.test(text.split('\n')[0]), 'opens with prose, not bullets');
});

test('definition: subject capitalized and led', () => {
  const { text } = ask('What is docsify and why should I use it?');
  assert.ok(text.startsWith('**'), 'definition leads with the subject');
});

test('howto: "How do I get started?" becomes steps', () => {
  const { text } = ask('How do I get started with docsify?');
  assert.ok(/\b1\./.test(text), 'numbered steps');
  assert.ok(text.toLowerCase().includes('index.html'), 'references the actual how-to content');
  assert.ok(/\[2\]/.test(text), 'cites the quick-start chunk');
});

test('troubleshooting intent surfaces fix-oriented sentences', () => {
  const ctx = [mk('7', 'Troubleshooting', 'If search does not work, check that search.min.js is loaded after docsify.js. If styles are missing, verify the theme CSS link.')];
  const { text } = ask('search is not working on my site', { contexts: ctx });
  assert.ok(/check|verify/i.test(text), `fix-oriented: ${text.slice(0, 200)}`);
});

test('list: "What themes exist?" becomes bullets', () => {
  const { text } = ask('list the available themes');
  assert.ok(/^- /m.test(text), 'bullet list');
  assert.ok(text.toLowerCase().includes('theme'), 'on-topic');
});

test('greet: friendly, persona-aware, suggests starter questions, no citations', () => {
  const { text, used } = ask('hi');
  assert.equal(used, 0);
  assert.ok(text.includes('Docsify') || text.includes('Docsy'));
  assert.ok(!/\[\d\]/.test(text), 'no citations for greetings');
  assert.ok(!text.includes('offline fallback brain'));
});

test('identity: describes itself from the profile', () => {
  const { text } = ask('What can you do?');
  assert.ok(text.includes('Docsify'), 'names the app');
  assert.ok(text.includes('Plugins') || text.includes('Themes'), 'lists real capabilities');
});

test('thanks: short warm close', () => {
  const { text, used } = ask('thanks');
  assert.equal(used, 0);
  assert.ok(text.length < 120);
});

test('no-knowledge: honest miss + closest topics (weak-match gate)', () => {
  const ctx = [mk('9', 'Widget configuration', 'The widget renders inside a shadow DOM boundary. Colors come from the CSS variables.')];
  const { text, used } = ask('how do I launch a rocket to mars?', { contexts: ctx });
  assert.equal(used, 0);
  assert.ok(/outside my knowledge|don't have a solid answer/i.test(text), `honest: ${text.slice(0, 140)}`);
});

test('variety: two different definition questions do not share an opener', () => {
  const a = ask('What is docsify?').text.split('\n')[0];
  const ctx = [mk('5', 'Configuration', 'Configuration is set in window.$docsify. Options control the sidebar, search and theming.')];
  const b = ask('Explain the configuration options.', { contexts: ctx }).text.split('\n')[0];
  // they must differ in structure or lead — no single hardcoded opener
  assert.notEqual(a, b, 'openers vary by question');
});

test('offline note is present but subtle (single short line)', () => {
  const { text } = ask('What is docsify?');
  const noteMatch = text.match(/_Answered from indexed knowledge[^_]*_/);
  assert.ok(noteMatch, 'disclosure present');
  assert.ok(noteMatch[0].length < 140, 'subtle');
  assert.equal(text.match(/_Answered/g)?.length, 1, 'appears once');
});

test('showOfflineNote:false (LLM fallback path) omits the note', () => {
  const r = synthesizeAnswer({
    question: 'What is docsify?', contexts, citations: citationsFor(contexts),
    app, profile, showOfflineNote: false,
  });
  assert.ok(!r.text.includes('_Answered from indexed knowledge'));
});

test('boilerplate (donate/sponsor) is penalized out of answers', () => {
  const ctx = [
    mk('4', 'Donate', 'Please consider donating if you think docsify is helpful. Buy the author a cup of coffee.'),
    mk('5', 'What is docsify', 'Docsify is a documentation site generator with no build step.'),
  ];
  const { text } = ask('What is docsify?', { contexts: ctx });
  assert.ok(!text.toLowerCase().includes('donating'), 'boilerplate excluded');
  assert.ok(text.includes('documentation site generator'));
});

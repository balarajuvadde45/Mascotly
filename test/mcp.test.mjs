// MCP server end-to-end test: spawn mcp/server.js, speak JSON-RPC over stdio,
// and run create → ingest → analyze → search → chat → embed snippet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-mcp-data-'));
const SERVER_SCRIPT = path.resolve(__dirname, '..', 'mcp', 'server.js');

class McpClient {
  constructor() {
    this.child = spawn(process.execPath, [SERVER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MASCOT_DATA_DIR: DATA_DIR, MASCOT_PLAYGROUND: 'false' },
    });
    this.exited = new Promise((resolve) => this.child.on('exit', resolve));
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (d) => {
      this.buffer += d.toString();
      let idx;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // ignore non-JSON stdout noise
        }
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
    this.child.stderr.on('data', () => { /* diagnostics only */ });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP request ${method} timed out`)), 30000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async call(name, args) {
    const msg = await this.request('tools/call', { name, arguments: args || {} });
    assert.ok(msg.result, `tools/call ${name} produced no result: ${JSON.stringify(msg).slice(0, 200)}`);
    let payload;
    try {
      payload = JSON.parse(msg.result.content[0].text);
    } catch {
      payload = { message: msg.result.content[0].text };
    }
    if (msg.result.isError) throw new Error(payload.message || payload.error || 'tool error');
    return payload;
  }

  async close() {
    this.child.stdin.end();
    this.child.kill();
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 2000))]);
  }
}

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('MCP: initialize handshake', async () => {
  const client = new McpClient();
  try {
    const msg = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    assert.equal(msg.result.protocolVersion, '2024-11-05');
    assert.equal(msg.result.serverInfo.name, 'mascot');
    assert.ok(Array.isArray((await client.request('tools/list', {})).result.tools));
    assert.ok((await client.request('tools/list', {})).result.tools.length >= 8);
  } finally {
    await client.close();
  }
});

test('MCP: full flow — create, ingest, analyze, search, chat, snippet', async () => {
  const client = new McpClient();
  try {
    const created = await client.call('mascot_create_app', {
      name: 'MCP Flow App',
      description: 'Created by the MCP end-to-end test.',
    });
    assert.ok(created.app.id.startsWith('app_'));
    const appId = created.app.id;

    const ingested = await client.call('mascot_add_source', {
      appId,
      type: 'text',
      text: '# Widget docs\nThe test widget answers questions about deployments. Deploys take four minutes. Rollbacks are one click under Releases.',
    });
    assert.ok(ingested.chunkCount >= 1);

    const analysis = await client.call('mascot_analyze', { appId });
    assert.equal(analysis.engine, 'heuristic');
    assert.ok(analysis.summary.length > 5);

    const search = await client.call('mascot_search', { appId, query: 'how long does deploy take' });
    assert.ok(search.results.length >= 1);

    const chatOut = await client.call('mascot_chat', { appId, message: 'How long does a deploy take?' });
    assert.ok(chatOut.answer.toLowerCase().includes('deploy'));
    assert.ok(chatOut.citations.length >= 1);

    const snippet = await client.call('mascot_embed_snippet', { appId, serverUrl: 'http://localhost:4242' });
    assert.ok(snippet.snippet.includes('mascot-widget.js'));
    assert.ok(snippet.snippet.includes(appId));

    const listed = await client.call('mascot_list_apps', {});
    assert.ok(listed.apps.some((a) => a.id === appId));

    const deleted = await client.call('mascot_delete_app', { appId, confirm: true });
    assert.equal(deleted.deleted, 'MCP Flow App');
  } finally {
    await client.close();
  }
});

test('MCP: delete without confirm fails safely', async () => {
  const client = new McpClient();
  try {
    const created = await client.call('mascot_create_app', { name: 'Delete Guard' });
    await assert.rejects(
      () => client.call('mascot_delete_app', { appId: created.app.id }),
      /confirm/,
    );
  } finally {
    await client.close();
  }
});

#!/usr/bin/env node
// Mascot CLI: headless management without the dashboard.
//   mascot serve                 start the server (same as npm start)
//   mascot create-app --name X   create an app, print keys + embed snippet
//   mascot list                  list apps
//   mascot setup --client X      register the MCP server into a harness agent
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcUrl = (p) => pathToFileURL(path.join(__dirname, '..', 'src', p)).href;

const [command, ...rest] = process.argv.slice(2);

function argValue(flag) {
  const idx = rest.indexOf(flag);
  if (idx === -1) return undefined;
  return rest[idx + 1];
}

async function runSetup() {
  const { applySetup, installSkill, CLIENT_IDS } = await import(srcUrl('agent-setup.js'));
  const clients = [];
  for (let i = 0; i < rest.length; i++) {
    // Skip flag values that are themselves flags (`--client --dry-run`).
    if (rest[i] === '--client' && rest[i + 1] && !rest[i + 1].startsWith('--')) clients.push(rest[i + 1]);
  }
  const dryRun = rest.includes('--dry-run');
  const withSkill = rest.includes('--install-skill');
  const targets = clients.includes('all')
    ? CLIENT_IDS.filter((c) => c !== 'generic')
    : clients;

  if (!targets.length) {
    console.log(`Register the Mascot MCP server with harness agents.

Usage:
  mascot setup --client claude_code           # one client
  mascot setup --client all                   # every detected client
  mascot setup --client codex --install-skill # also install the Mascot agent skill
  mascot setup --client claude_code --dry-run # preview without writing

Clients: ${CLIENT_IDS.filter((c) => c !== 'generic').join(', ')} (generic = print manual instructions)
`);
    return;
  }

  for (const clientId of targets) {
    if (clientId === 'generic') {
      console.log(`\ngeneric setup — add to your agent's MCP config manually:\n  {\n    "mcpServers": {\n      "mascot": {\n        "command": ${JSON.stringify(process.execPath)},\n        "args": [${JSON.stringify(path.join(__dirname, '..', 'mcp', 'server.js'))}]\n      }\n    }\n  }`);
      continue;
    }
    try {
      const result = applySetup(clientId, { dryRun });
      if (result.skipped) {
        console.log(`✗ ${result.label}: ${result.reason}`);
        continue;
      }
      if (result.unchanged) {
        console.log(`= ${result.label}: already registered (${result.file})`);
      } else if (dryRun) {
        console.log(`◇ ${result.label} (dry-run) → ${result.file}`);
        console.log(`  backup would be: ${result.backupPath}`);
        console.log(`  change: ${result.before ? 'replace existing mascot entry' : 'add new mascot entry'}`);
      } else {
        console.log(`✓ ${result.label}: ${result.message}${result.exists ? ` (backup: ${result.backupPath})` : ''}`);
      }
      if (withSkill) {
        const skill = installSkill(clientId, { dryRun });
        console.log(`${dryRun ? '◇' : skill.installed ? '✓' : 'ℹ'} skill: ${skill.message}`);
      }
    } catch (err) {
      console.error(`✗ ${clientId}: ${err.message}`);
    }
  }
}

async function getStore() {
  const { createStore } = await import(srcUrl('store-factory.js'));
  const store = await createStore();
  if (typeof store.init === 'function') await store.init();
  return store;
}

function printApp(app) {
  console.log(`\n  ${app.name}`);
  console.log(`  appId     : ${app.id}`);
  console.log(`  publicKey : ${app.publicKey}`);
  console.log(`  secretKey : ${app.secretKey}`);
  console.log(`  created   : ${app.createdAt}`);
}

async function main() {
  switch (command) {
    case 'serve': {
      await import(srcUrl('index.js'));
      break;
    }
    case 'setup': {
      await runSetup();
      break;
    }
    case 'create-app': {
      const name = argValue('--name');
      if (!name) {
        console.error('Usage: mascot create-app --name "My App" [--description "..."] [--docs-url https://...] [--action name:description ...]');
        process.exit(1);
      }
      const store = await getStore();
      // Each --action flag maps to one action; description may itself contain ':'.
      const actions = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] !== '--action') continue;
        const value = rest[i + 1] || '';
        const colonIdx = value.indexOf(':');
        actions.push({
          name: colonIdx === -1 ? value : value.slice(0, colonIdx),
          description: colonIdx === -1 ? '' : value.slice(colonIdx + 1),
        });
      }
      const app = store.createApp({
        name,
        description: argValue('--description') || '',
        mascot: { actions },
      });
      if (argValue('--docs-url')) {
        const { ingestUrl } = await import(srcUrl('knowledge/ingest.js'));
        const { analyzeApp } = await import(srcUrl('analysis/analyzer.js'));
        const { createJob } = await import(srcUrl('jobs.js'));
        console.log(`  ingesting ${argValue('--docs-url')} …`);
        try {
          await ingestUrl(store, app, { url: argValue('--docs-url') });
        } catch (err) {
          console.warn(`  docs ingest failed: ${err.message}`);
        }
        await analyzeApp(store, app, createJob(app.id, 'analyze', 'cli analysis')).catch((err) => console.warn(`  analysis failed: ${err.message}`));
      }
      printApp(app);
      console.log(`\n  Embed snippet:`);
      console.log(`  <script src="http://localhost:4242/widget/mascot-widget.js"></script>`);
      console.log(`  <script>window.Mascot.init({ server: 'http://localhost:4242', appId: '${app.id}', publicKey: '${app.publicKey}' });</script>\n`);
      break;
    }
    case 'list': {
      const store = await getStore();
      const apps = store.listApps();
      if (!apps.length) {
        console.log('  No apps yet. Create one: mascot create-app --name "My App"');
        break;
      }
      for (const app of apps) {
        console.log(`  ${app.id}  ${app.name}  (publicKey ${app.publicKey.slice(0, 8)}…, messages: ${app.stats?.messages ?? 0})`);
      }
      break;
    }
    default: {
      console.log(`Mascot CLI

  mascot serve                 start the Mascot server
  mascot create-app --name X   create an app and print keys + embed snippet
        [--description "..."] [--docs-url https://...] [--action name:desc]
  mascot list                  list apps
  mascot setup --client X      register the MCP server into a harness agent
        (claude_code, codex, cursor, windsurf, gemini_cli, claude_desktop, vscode, all)
        [--dry-run] [--install-skill]
`);
      if (command && command !== '--help' && command !== '-h') process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

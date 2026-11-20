// Harness-agent setup: registers the Mascot MCP server into supported agent
// clients (Claude Code, Codex, Cursor, Windsurf, Gemini CLI, Claude Desktop,
// VS Code) — REA-style, with read-only plans (--dry-run), backups, and idempotent
// merges that never touch unrelated configuration.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const MCP_SERVER_PATH = path.join(REPO_ROOT, 'mcp', 'server.js');
export const SKILL_SOURCE_DIR = path.join(REPO_ROOT, 'skills', 'mascotly');

function mcpEntry() {
  // Absolute node binary + absolute script path: works from any cwd.
  return { command: process.execPath, args: [MCP_SERVER_PATH] };
}

function homedir(...parts) {
  return path.join(os.homedir(), ...parts);
}

function claudeDesktopConfig() {
  if (process.platform === 'win32') return homedir('AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return homedir('Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return null; // not officially supported on linux
}

export const CLIENTS = {
  claude_code: {
    label: 'Claude Code',
    configPaths: () => [homedir('.claude.json')],
    format: 'json',
    skillDir: () => homedir('.claude', 'skills', 'mascotly'),
  },
  claude_desktop: {
    label: 'Claude Desktop',
    configPaths: () => [claudeDesktopConfig()].filter(Boolean),
    format: 'json',
  },
  codex: {
    label: 'Codex CLI',
    configPaths: () => [homedir('.codex', 'config.toml')],
    format: 'toml',
  },
  cursor: {
    label: 'Cursor',
    configPaths: () => [homedir('.cursor', 'mcp.json')],
    format: 'json',
  },
  windsurf: {
    label: 'Windsurf',
    configPaths: () => [homedir('.codeium', 'windsurf', 'mcp_config.json')],
    format: 'json',
  },
  gemini_cli: {
    label: 'Gemini CLI',
    configPaths: () => [homedir('.gemini', 'settings.json')],
    format: 'json',
  },
  vscode: {
    label: 'VS Code (current workspace)',
    configPaths: () => [path.join(process.cwd(), '.vscode', 'mcp.json')],
    format: 'vscode', // .vscode/mcp.json uses a "servers" root key, not "mcpServers"
  },
};

export const CLIENT_IDS = [...Object.keys(CLIENTS), 'generic'];

// ---------- JSON merge ----------

function planJson(clientId, cfg, file) {
  let existing = {};
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`${file} exists but is not valid JSON — fix it manually or remove it first.`);
    }
  }
  // Never touch configs whose shape we don't understand.
  if (existing !== null && (typeof existing !== 'object' || Array.isArray(existing))) {
    throw new Error(`${file} has an unexpected top-level shape (${Array.isArray(existing) ? 'array' : typeof existing}) — fix it manually.`);
  }
  existing = existing || {};
  if (existing.mcpServers !== undefined && (typeof existing.mcpServers !== 'object' || Array.isArray(existing.mcpServers) || existing.mcpServers === null)) {
    throw new Error(`${file} has a non-object "mcpServers" — fix it manually.`);
  }
  const rootKey = cfg.format === 'vscode' ? 'servers' : 'mcpServers';
  const before = JSON.stringify(existing[rootKey]?.mascot ?? null);
  const servers = { ...(existing[rootKey] || {}), mascot: mcpEntry() };
  const merged = { ...existing, [rootKey]: servers };
  const after = JSON.stringify(servers.mascot);
  const unchanged = before === after;
  return { merged, unchanged, before, after, rootKey };
}

// ---------- TOML merge (Codex) ----------

function tomlBlock() {
  const entry = mcpEntry();
  return [
    '[mcp_servers.mascot]',
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(', ')}]`,
  ].join('\n');
}

function planToml(clientId, cfg, file) {
  const block = tomlBlock();
  let existing = '';
  if (fs.existsSync(file)) existing = fs.readFileSync(file, 'utf8');
  // Line-wise replacement: everything from the section header until the next
  // line starting with '[' (or EOF). No regex-bracket surprises.
  const lines = existing.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === '[mcp_servers.mascot]');
  const blockLines = block.split('\n');
  let merged;
  let before = null;
  if (startIdx !== -1) {
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) { endIdx = i; break; }
    }
    before = lines.slice(startIdx, endIdx).join('\n').trim();
    merged = [...lines.slice(0, startIdx), ...blockLines, ...lines.slice(endIdx)].join('\n');
  } else {
    const sep = existing.trim().length ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
    merged = existing + sep + block + '\n';
  }
  const unchanged = before === block;
  return { merged, unchanged, before, after: block };
}

// ---------- public API ----------

export function planSetup(clientId) {
  const cfg = CLIENTS[clientId];
  if (!cfg) throw new Error(`Unknown client: ${clientId}. Supported: ${Object.keys(CLIENTS).join(', ')}, generic`);
  const file = cfg.configPaths()[0];
  if (!file) return { clientId, label: cfg.label, skipped: true, reason: 'not available on this platform' };
  const plan = cfg.format === 'toml' ? planToml(clientId, cfg, file) : planJson(clientId, cfg, file);
  return {
    clientId,
    label: cfg.label,
    file,
    exists: fs.existsSync(file),
    backupPath: `${file}.mascot-backup`,
    format: cfg.format,
    ...plan,
  };
}

export function applySetup(clientId, { dryRun = false } = {}) {
  const plan = planSetup(clientId);
  if (plan.skipped) return plan;
  if (plan.unchanged) {
    return { ...plan, applied: false, message: 'already registered — nothing to change' };
  }
  if (dryRun) {
    return { ...plan, applied: false, message: 'dry-run: no changes written' };
  }
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  if (fs.existsSync(plan.file) && !fs.existsSync(plan.backupPath)) {
    // Keep the FIRST backup (pre-Mascot state) — never clobber it on re-runs.
    fs.copyFileSync(plan.file, plan.backupPath);
  }
  if (plan.format === 'json' || plan.format === 'vscode') {
    fs.writeFileSync(plan.file, JSON.stringify(plan.merged, null, 2) + '\n');
  } else {
    fs.writeFileSync(plan.file, plan.merged);
  }
  return { ...plan, applied: true, message: `registered Mascot MCP server in ${plan.file}` };
}

export function installSkill(clientId, { dryRun = false } = {}) {
  const cfg = CLIENTS[clientId];
  const targetDir = typeof cfg?.skillDir === 'function' ? cfg.skillDir() : null;
  const sourceFile = path.join(SKILL_SOURCE_DIR, 'SKILL.md');
  if (!targetDir) {
    return { installed: false, message: `no skill auto-install for ${clientId} — copy ${SKILL_SOURCE_DIR} into your agent's skills directory` };
  }
  if (!fs.existsSync(sourceFile)) {
    return { installed: false, message: `skill source missing (${sourceFile}) — copy it manually` };
  }
  const targetFile = path.join(targetDir, 'SKILL.md');
  if (dryRun) return { installed: false, targetFile, message: 'dry-run' };
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(sourceFile, targetFile);
  return { installed: true, targetFile, message: `skill installed at ${targetFile}` };
}

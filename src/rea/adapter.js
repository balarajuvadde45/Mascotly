// REA (Reverse Engineer Anything) adapter — https://github.com/morluto/rea
//
// Shells out to the `rea` CLI (or `npx -y rea-agents@latest`) with array-spawned,
// strictly validated arguments — never a shell string on POSIX. Output is size-capped
// and handed to the tolerant parser. Everything degrades gracefully when REA is absent.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { truncate } from '../util.js';

const SHELL_METACHARS = /[&|<>`"';\r\n$*?[\]{}!\\]/;

const detectionCache = { at: 0, result: null };
const DETECT_TTL_MS = 10 * 60_000;

function runOnce(command, args, { timeoutMs, maxOutputBytes, windowsShell }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    let child;
    try {
      child = spawn(command, args, {
        shell: windowsShell,
        windowsHide: true,
        env: { ...process.env, REA_NONINTERACTIVE: '1' },
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err.message), timedOut: false, truncated: false });
      return;
    }

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      if (Buffer.byteLength(stdout) + d.length <= maxOutputBytes) stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 20_000) stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: stderr || String(err.message), timedOut: false, truncated: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !killed,
        code,
        stdout,
        stderr,
        timedOut: killed,
        truncated: Buffer.byteLength(stdout) >= maxOutputBytes,
      });
    });
  });
}

function windowsNeedsShell(command) {
  return process.platform === 'win32' && (/\.cmd$/i.test(command) || /^(npx|rea)$/i.test(path.basename(command)));
}

async function tryCommand(command, args, timeoutMs) {
  const useShell = windowsNeedsShell(command);
  if (useShell) {
    for (const part of [command, ...args]) {
      if (SHELL_METACHARS.test(part)) return { ok: false, code: -1, stdout: '', stderr: 'rejected unsafe argument for shell spawn', timedOut: false };
    }
  }
  return runOnce(command, args, { timeoutMs, maxOutputBytes: 200_000, windowsShell: useShell });
}

/** Detect an REA CLI: global `rea`, else `npx -y rea-agents@latest`. Cached 10 min. */
export async function detectRea() {
  if (config.rea.command && config.rea.command !== 'auto') {
    return { mode: 'explicit', command: config.rea.command, prefixArgs: [] };
  }
  if (detectionCache.result && Date.now() - detectionCache.at < DETECT_TTL_MS) {
    return detectionCache.result;
  }
  // 1) Global rea binary.
  const direct = await tryCommand('rea', ['--version'], 20_000);
  let result;
  if (direct.ok) {
    result = { mode: 'rea', command: 'rea', prefixArgs: [], version: truncate(direct.stdout.trim(), 120) };
  } else {
    // 2) npx fallback (downloads on first use; slow — only when actually needed).
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    result = {
      mode: 'npx',
      command: npx,
      prefixArgs: ['-y', 'rea-agents@latest'],
      version: null,
      note: 'REA not installed globally; will run via npx (first run downloads the package).',
    };
  }
  detectionCache.result = result;
  detectionCache.at = Date.now();
  return result;
}

export async function reaStatus() {
  const det = await detectRea();
  return {
    mode: det.mode,
    command: det.command,
    version: det.version || null,
    note: det.note || null,
    timeoutMs: config.rea.timeoutMs,
  };
}

export const REA_KINDS = {
  javascript: ['analyze-javascript-application'],
  asar: ['analyze-javascript-application'],
};

/**
 * Run REA analysis on a local target.
 * @param {object} opts { target, kind ('javascript'|'asar'|'custom'), command?, args?, onStep? }
 */
export async function runReaAnalysis(opts) {
  const { target, kind = 'javascript', command = '', args = [], onStep = () => {} } = opts;

  // Validate target path.
  const absTarget = path.resolve(String(target || ''));
  if (!fs.existsSync(absTarget)) {
    throw new Error(`Target path does not exist: ${absTarget}`);
  }

  const det = await detectRea();
  const useShell = windowsNeedsShell(det.command);
  const validate = (parts) => {
    for (const p of parts) {
      if (typeof p !== 'string' || !p.trim()) throw new Error('Empty command argument');
      if (p.length > 4096) throw new Error('Command argument too long');
      if (useShell && SHELL_METACHARS.test(p)) {
        throw new Error(`Unsafe character in argument: ${truncate(p, 40)}`);
      }
    }
  };

  let argv;
  if (kind === 'custom') {
    if (!command) throw new Error('kind "custom" requires a rea sub-command');
    const sub = String(command).trim();
    if (!/^[a-z][a-z0-9-]*$/i.test(sub)) throw new Error('Invalid rea sub-command');
    if (args.length > 24) throw new Error('Too many arguments (max 24)');
    validate([sub, ...args, absTarget]);
    argv = [...det.prefixArgs, sub, ...args, absTarget];
  } else {
    const base = REA_KINDS[kind];
    if (!base) throw new Error(`Unknown REA kind: ${kind}`);
    validate([...base, absTarget]);
    argv = [...det.prefixArgs, ...base, absTarget, '--json'];
  }

  onStep(`running: ${det.command} ${argv.join(' ').slice(0, 160)}…`, 20);

  // With shell:true (Windows .cmd shims) Node joins args unquoted — quote any
  // argument containing spaces so paths like "C:\Program Files\…" survive.
  const finalArgv = useShell ? argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : argv;

  const res = await runOnce(det.command, finalArgv, {
    timeoutMs: config.rea.timeoutMs,
    maxOutputBytes: config.rea.maxOutputBytes,
    windowsShell: useShell,
  });

  return {
    ok: res.ok,
    mode: det.mode,
    command: `${det.command} ${argv.join(' ')}`,
    target: absTarget,
    stdout: res.stdout,
    stderr: truncate(res.stderr, 4000),
    timedOut: res.timedOut,
    truncatedOutput: res.truncated,
    exitCode: res.code,
  };
}

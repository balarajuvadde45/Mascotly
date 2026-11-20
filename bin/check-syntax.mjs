// Syntax-check every JS source file (ESM-aware) without executing it.
// Copies each file to a temp dir as .mjs and runs `node --check` on it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-check-'));

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const files = [
  ...walk(path.join(root, 'src')),
  ...walk(path.join(root, 'bin')),
  ...walk(path.join(root, 'public')),
];

let failures = 0;
for (const file of files) {
  const rel = path.relative(root, file).replace(/[\\/]/g, '__');
  const target = path.join(tmp, rel.replace(/\.mjs$/, '') + '.mjs');
  fs.copyFileSync(file, target);
  const res = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (res.status !== 0) {
    failures++;
    console.error(`✗ ${path.relative(root, file)}\n${res.stderr}`);
  } else {
    console.log(`✓ ${path.relative(root, file)}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} file(s) failed syntax check` : `\nAll ${files.length} files parse cleanly`);
process.exit(failures ? 1 : 0);

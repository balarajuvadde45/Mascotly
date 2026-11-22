// Bot starter page bundle — the static files Forge generates/deploys for a
// newly created mascot (works on Vercel, S3, or any static host).
import fs from 'node:fs';
import path from 'node:path';

export function starterPageBundle({ appName, appId, publicKey, serverUrl }) {
  const safe = (x) => String(x || '').replace(/[<>'"`\\]/g, '');
  const name = safe(appName);
  const server = safe(serverUrl || 'http://localhost:4242').replace(/\/+$/, '');
  const id = safe(appId);
  const key = safe(publicKey);
  return [
    {
      path: 'index.html',
      content: `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${name} — AI assistant</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0b12;color:#f2f3f7;font-family:Inter,-apple-system,sans-serif;text-align:center}
main{max-width:560px;padding:32px}h1{font-size:34px;letter-spacing:-.02em}p{color:#8b90a0;line-height:1.6}
.cta{display:inline-block;margin-top:18px;padding:12px 22px;border-radius:12px;background:#7c6cff;color:#fff;font-weight:700;text-decoration:none}</style></head>
<body><main><div style="font-size:56px">🤖</div><h1>${name}</h1>
<p>Your AI assistant, powered by a self-hosted Mascotly server. Click the mascot bubble in the corner — or the button below — to start chatting.</p>
<a class="cta" href="#" onclick="window.Mascotly && window.Mascotly.open(); return false;">Chat now</a></main>
<script src="${server}/widget/mascot-widget.js"></script>
<script>window.Mascotly.init({ server: '${server}', appId: '${id}', publicKey: '${key}' });</script>
</body></html>`,
    },
    { path: 'vercel.json', content: JSON.stringify({ cleanUrls: true }, null, 2) },
    {
      path: 'README.md',
      content: `# ${name} — bot starter (deployed by Mascotly Forge)\n\nA static page with your Mascotly widget embedded.\n\n## Deploy\n- Vercel: \`npx vercel --prod\` in this folder.\n- Any static host: upload this folder.\n\nThe mascot talks to your Mascotly server at ${server} (appId ${id}). Keep that server running.`,
    },
  ];
}

/** Optional: save the bundle to a folder for manual hosting. */
export function saveBundle(bundle, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of bundle) fs.writeFileSync(path.join(dir, f.path), f.content);
  return dir;
}

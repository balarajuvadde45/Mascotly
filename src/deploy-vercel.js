// Vercel REST API deployment — deploys the Forge bot starter bundle.
// Uses POST /v13/deployments with inline files (docs: vercel.com/docs/rest-api/deployments).
// MASCOT_VERCEL_API overrides the API base (tests/self-host).
import { truncate } from './util.js';

const API = () => (process.env.MASCOT_VERCEL_API || 'https://api.vercel.com').replace(/\/+$/, '');

export async function deployBundleToVercel({ token, projectName, files }) {
  if (!token) throw new Error('A Vercel token is required (create one at vercel.com/account/tokens)');
  if (!Array.isArray(files) || !files.length) throw new Error('No files to deploy');

  const res = await fetch(`${API()}/v13/deployments${projectName ? `?name=${encodeURIComponent(projectName)}` : ''}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: projectName || 'mascotly-bot',
      target: 'production',
      projectSettings: { framework: null },
      files: files.map((f) => ({ file: f.path, data: f.content })),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error?.message || truncate(JSON.stringify(data), 300);
    throw new Error(`Vercel deployment failed (${res.status}): ${detail}`);
  }
  return {
    id: data.id,
    url: data.url ? `https://${data.url}` : null,
    alias: Array.isArray(data.alias) ? data.alias[0] : null,
    readyState: data.readyState || 'QUEUED',
    projectName: data.project?.name || projectName,
  };
}

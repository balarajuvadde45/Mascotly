// REA ingest service — shared by the HTTP route and the MCP server.
// Runs REA on a local target, parses the output, commits knowledge, and
// folds structured insights into the app profile.
import { runReaAnalysis } from './adapter.js';
import { parseReaOutput, reaSectionsToDocs } from './parser.js';
import { addSourceRecord, commitSource } from '../knowledge/ingest.js';
import { invalidateRetriever } from '../knowledge/service.js';
import { truncate } from '../util.js';

export async function runReaIngest(store, app, { target, kind = 'javascript', command = '', args = [] }, onStep = () => {}) {
  const result = await runReaAnalysis({
    target,
    kind: kind === 'asar' ? 'asar' : kind === 'custom' ? 'custom' : 'javascript',
    command,
    args: Array.isArray(args) ? args.map(String) : [],
    onStep,
  });
  if (!result.ok) {
    throw new Error(`REA exited with code ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}. ${truncate(result.stderr, 300)}`);
  }
  onStep(`parsing output (${result.stdout.length} chars)`, 70);
  const parsed = parseReaOutput(result.stdout);
  const docs = reaSectionsToDocs(parsed.sections, { target: result.target, mode: result.mode });
  if (!docs.length) throw new Error('REA produced no parsable sections');

  const source = addSourceRecord(store, app, {
    type: 'rea',
    label: `REA: ${truncate(result.target, 90)}`,
    detail: { target: result.target, kind, mode: result.mode, command: truncate(result.command, 200) },
  });
  await commitSource(store, app, source, docs, { extraDetail: { sections: docs.length } });
  invalidateRetriever(app.id);

  // Store structured insights on the profile and fold detected features in.
  const profile = store.getProfile(app.id) || {
    summary: '', purpose: '', features: [], audience: '', limitations: [], faqs: [], tone: '', suggestions: [],
  };
  profile.reaInsights = {
    target: result.target,
    mode: result.mode,
    format: parsed.format,
    ...parsed.insights,
    analyzedAt: new Date().toISOString(),
  };
  if (parsed.insights.features?.length) {
    const seen = new Set(profile.features.map((f) => f.toLowerCase()));
    for (const f of parsed.insights.features) {
      if (!seen.has(f.toLowerCase())) { profile.features.push(truncate(f, 180)); seen.add(f.toLowerCase()); }
      if (profile.features.length >= 18) break;
    }
  }
  if (!profile.lastAnalyzedAt) profile.lastAnalyzedAt = new Date().toISOString();
  store.saveProfile(app.id, profile);

  return {
    sourceId: source.id,
    sections: docs.length,
    format: parsed.format,
    target: result.target,
    mode: result.mode,
    insights: Object.fromEntries(Object.entries(parsed.insights).map(([k, v]) => [k, v.length])),
  };
}

// Offline answer synthesis engine.
//
// When no LLM provider is configured, this composes genuine answers from the
// indexed knowledge: it understands the question's intent, scores every
// candidate sentence from the retrieved chunks against the query, and assembles
// a cited, structured answer (definitions lead, how-tos become steps,
// troubleshooting becomes checks, lists become bullets).
//
// This is extractive generation — every claim still comes from real knowledge,
// but the shape, selection and ordering are computed per question instead of
// dumping excerpts. When a real LLM provider is configured, the chat path uses
// full generation instead and this engine is only the fallback.
import { tokenize } from '../knowledge/tokenize.js';
import { truncate } from '../util.js';

const STOP_EXTRA = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'i', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'to', 'of', 'in', 'for', 'on', 'with', 'and', 'or', 'can', 'how', 'what', 'why', 'when', 'where', 'which', 'who']);

// ───────────────────────── intent detection ─────────────────────────

export function detectIntent(question) {
  const q = String(question || '').trim();
  const lower = q.toLowerCase();
  if (/^(hi|hii+|hello|hey|yo|sup|good\s*(morning|evening|afternoon)|howdy)\b/.test(lower)) return { type: 'greet' };
  if (/^(thanks|thank you|thx|ty|cheers)\b/.test(lower)) return { type: 'thanks' };
  if (/(who are you|what are you\b|what can you (do|help)|how can you help|your name|introduce yourself)/.test(lower)) return { type: 'identity' };
  if (/(not working|doesn'?t work|does not work|error|failing|broken|stuck|crash|fails|issue with|problem with|fix|debug|troubleshoot)/.test(lower)) return { type: 'troubleshooting' };
  if (/^(how (do|to|can|does|would)|what('s| is) the (way|process|procedure)|steps to)/.test(lower)) return { type: 'howto' };
  if (/(compare|difference between|vs\.?( |\b)|versus|pros and cons|better than|which (is|one) better)/.test(lower)) return { type: 'compare' };
  if (/^(list|what are the|which (are|options)|options for|types of|kinds of)/.test(lower)) return { type: 'list' };
  if (/^(what (is|are|was|were)|what's|who (is|was)|tell me about|explain|describe|meaning of|define)\b/.test(lower)) return { type: 'definition' };
  if (/^(why)\b/.test(lower)) return { type: 'why' };
  if (/(can it|does it|is it|do i need|is there)\b/.test(lower)) return { type: 'info' };
  return { type: 'info' };
}

function subjectTerms(question) {
  const tokens = tokenize(question);
  return tokens.filter((t) => !STOP_EXTRA.has(t) && t.length > 1);
}

// ───────────────────────── sentence extraction ─────────────────────────

/** Emoji codepoint density — sentences that are mostly :emoji: notation are noise. */
function isEmojiNoise(text) {
  const tokens = String(text).split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const emojiCount = tokens.filter((t) => /^:[a-z_0-9]+:?$/i.test(t)).length;
  return emojiCount / tokens.length > 0.35;
}

/** Sentence looks like a changelog entry / commit list line. */
function isCommitNoise(text) {
  return /(\[#\d+\]\(|\b[0-9a-f]{7,40}\b\()/i.test(text) && text.length < 200;
}

function splitSentences(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  let buffer = '';
  let isListItem = false;
  const flush = () => {
    const t = buffer.trim();
    if (t) out.push({ text: t, listItem: isListItem });
    buffer = '';
    isListItem = false;
  };
  for (const rawLine of lines) {
    const line = rawLine.replace(/^#+\s*/, '').replace(/^>\s*/, '').trim();
    if (!line) { flush(); continue; }
    const listItem = /^([-*•]|\d+[.)])\s+/.test(line);
    const clean = line.replace(/^([-*•]|\d+[.)])\s+/, '');
    if (listItem) { flush(); out.push({ text: clean, listItem: true }); continue; }
    isListItem = false;
    buffer += (buffer ? ' ' : '') + clean;
    // sentence boundary: terminal punctuation followed by space+capital or end
    if (/[.!?]["')]?\s*$/.test(clean) && clean.length > 24) flush();
    else if (buffer.length > 340) flush();
  }
  flush();
  return out.filter((s) => s.text.length > 12 && s.text.length < 420 && !isEmojiNoise(s.text));
}

// ───────────────────────── scoring ─────────────────────────

function scoreSentences(pool, qTerms, intent) {
  // Rare terms are worth more (inverse document frequency across the pool).
  const df = new Map();
  for (const item of pool) {
    const seen = new Set(item.tokens);
    for (const t of qTerms) if (seen.has(t)) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = (t) => {
    const d = df.get(t) || 0;
    return 1 + Math.log(1 + (pool.length - d) / (d + 0.5));
  };

  return pool.map((item) => {
    const s = item;
    const st = new Set(s.tokens);
    let score = 0;
    let covered = 0;
    for (const t of qTerms) {
      if (st.has(t)) { covered++; score += idf(t) * 1.2; }
    }
    if (qTerms.length) score += (covered / qTerms.length) * 2.2;

    const lower = s.text.toLowerCase();
    // cue bonuses per intent
    if (intent === 'definition') {
      if (/\b(is|are|means|refers to|stands for)\b/.test(lower)) score += 1.5;
      // "X is a/an/the <noun>" definitional shape — the ideal lead sentence
      if (/^[a-z0-9 .'\-[\]>()…—-]{0,60}\b(is|are)\s+(a|an|the)\b/.test(lower)) score += 2.0;
    }
    if (intent === 'howto' && /\b(install|run|press|click|create|add|set|use|open|navigate|type|choose|select|enable|paste|write)\b/.test(lower)) score += 1.3;
    if (intent === 'troubleshooting' && /\b(check|verify|make sure|error|fail|expire|invalid|stuck|conflict|delete|remove|toggle|re-?install|clear)\b/.test(lower)) score += 1.3;
    if (intent === 'why' && /\b(because|so that|in order to|reason|due to|since)\b/.test(lower)) score += 1.0;
    if (intent === 'list' && s.listItem) score += 1.2;
    if (intent === 'compare' && /\b(instead|whereas|unlike|but|however|on the other hand|compared)\b/.test(lower)) score += 1.0;

    // noise (changelog / release-note chunks) sinks the sentence
    if (s.noise) score -= 3.0;

    // structural bonuses
    if (s.position <= 1) score += 0.55;              // early in its chunk
    if (s.headingMatch) score += 0.9;                // chunk heading matches the query
    if (s.listItem && intent !== 'howto') score += 0.25;
    // length fit
    if (s.text.length < 34) score -= 0.8;
    if (s.text.length > 330) score -= 0.5;
    // boilerplate: flagged + hard-excluded from selection (never quoted)
    if (/\b(copyright|all rights reserved|buy a cup of coffee|donat(e|ing|ion)|sponsor|subscribe|patreon)\b/i.test(s.text)) { score -= 2.4; s.boilerplate = true; }
    if (/^[<|_=\-#]/.test(s.text)) score -= 1.5;

    return { ...s, score: Number(score.toFixed(3)), covered };
  });
}

function dedupe(sentences) {
  const kept = [];
  const keptTokenSets = [];
  for (const s of sentences) {
    const tokens = new Set(s.tokens);
    let dup = false;
    for (const kt of keptTokenSets) {
      let inter = 0;
      for (const t of tokens) if (kt.has(t)) inter++;
      const union = tokens.size + kt.size - inter;
      if (union && inter / union > 0.55) { dup = true; break; }
    }
    if (!dup) { kept.push(s); keptTokenSets.push(tokens); }
  }
  return kept;
}

// ───────────────────────── composition ─────────────────────────

function withCitation(sentence, n) {
  return sentence.text.replace(/\s*$/, '') + ` [${n}]`;
}

function pickVariation(options, seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return options[h % options.length];
}

/**
 * Compose an offline answer from retrieved knowledge.
 * @param {object} p { question, contexts, citations, app, profile, memory, history, showOfflineNote }
 * @returns {{ text: string, used: number }}
 */
export function synthesizeAnswer(p) {
  const { question, app, profile } = p;
  const citations = p.citations || [];
  const intent = detectIntent(question);
  const qTerms = subjectTerms(question);

  // conversational intents that don't need knowledge
  if (intent.type === 'greet') {
    const suggestions = (profile?.suggestions || []).slice(0, 2);
    const lines = [
      pickVariation([
        `Hey! ${app.mascot?.emoji || ''} Great to see you.`,
        `Hi there!${app.mascot?.name ? ` ${app.mascot.name} here.` : ''}`,
        `Hello! 👋`,
      ], question),
      `I know my way around **${app.name}**${suggestions.length ? ' — for example, you could ask me: ' + suggestions.map((s) => `"${s}"`).join(' or ') : '. Ask me anything about how it works.'}`,
    ];
    return { text: lines.join('\n\n'), used: 0 };
  }
  if (intent.type === 'thanks') {
    return { text: pickVariation([
      'Anytime! 🙂 If anything else comes up, just ask.',
      'Happy to help! Ping me whenever you need more.',
      'You\'re welcome — I\'m here whenever you need me.',
    ], question), used: 0 };
  }
  if (intent.type === 'identity') {
    const features = (profile?.features || []).slice(0, 5);
    const lines = [
      `I'm **${app.mascot?.name || 'the mascot'}** ${app.mascot?.emoji || '🤖'} — ${app.mascot?.tagline || 'the AI assistant'} for **${app.name}**.`,
      features.length
        ? `I can answer questions about things like:\n${features.map((f) => `- ${f}`).join('\n')}`
        : `I answer questions using the knowledge this app's owner has indexed for me.`,
      `Ask me anything about ${app.name} — that's what I'm here for.`,
    ];
    return { text: lines.join('\n\n'), used: 0 };
  }

  // knowledge-grounded intents
  const pool = [];
  for (const r of p.contexts || []) {
    const n = citations.findIndex((c) => c.chunkId === r.chunk.id);
    const citeN = n >= 0 ? n + 1 : null;
    // changelog / release-note chunks are keyword soup: version-link headings,
    // dense commit hashes and issue links. Flag the whole chunk.
    const heading = r.chunk.headingPath || '';
    const commitPatterns = (r.chunk.text.match(/\[#\d+\]\(|\b[0-9a-f]{7,40}\b\)|github\.com\/[^/]+\/[^/]+\/(?:commit|compare|releases?)/gi) || []).length;
    const chunkNoise = /changelog|release notes|what's changed/i.test(heading)
      || /^\[[^\]]*\]\(https?:\/\//.test(heading)
      || commitPatterns >= 3;
    const sentences = splitSentences(r.chunk.text);
    sentences.forEach((s, idx) => {
      const tokens = tokenize(s.text);
      const headingLower = (r.chunk.headingPath || '').toLowerCase();
      const headingMatch = qTerms.some((t) => headingLower.includes(t));
      pool.push({
        ...s,
        tokens,
        position: idx,
        citeN,
        noise: chunkNoise,
        headingMatch,
        chunkRank: r.rank ?? citations.findIndex((c) => c.chunkId === r.chunk.id),
        heading: r.chunk.headingPath || '',
      });
    });
  }

  if (!pool.length) {
    // Pool is empty — either the app has no knowledge or all sentences were noise.
    // If the question also has no overlap with the app's own vocabulary, it's
    // an out-of-scope question rather than a knowledge gap.
    const appWords = new Set(tokenize(
      (app.name || '') + ' ' + (app.description || '') + ' ' + (profile?.summary || '')
    ));
    const qWords = subjectTerms(question);
    const isOutOfScope = qWords.length > 0 && !qWords.some((w) => appWords.has(w));
    if (isOutOfScope) {
      return {
        text: [
          `That's outside my knowledge about **${app.name}** — I'm here to help with questions about this application.`,
          '',
          profile?.features?.length ? 'Things I can help with: ' + profile.features.slice(0, 3).join(', ') + '.' : '',
        ].filter(Boolean).join('\n'),
        used: 0,
        outOfScope: true,
      };
    }
    return {
      text: [
        `I don't have anything indexed about **${app.name}** yet, so I can't answer "${truncateQuestion(question)}" reliably.`,
        '',
        'The app owner can fix this by adding knowledge sources (docs URL, GitHub repo, files) and re-running the analyzer.',
      ].join('\n'),
      used: 0,
    };
  }

  const scored = scoreSentences(pool, qTerms, intent.type).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const selectable = scored.filter((s) => !s.boilerplate);

  // ── Out-of-scope guardrail ──
  // A question is out of scope when its content terms don't overlap with ANY
  // retrieved knowledge sentence (covered === 0 for every sentence). That means
  // the retrieval engine couldn't match it to the app's knowledge at all — it's
  // a general-knowledge question the mascot shouldn't try to answer.
  const aboutApp = qTerms.length > 0
    && scored.some((s) => s.covered > 0 && !s.noise);

  // Confidence gate: nothing in the pool overlaps the question meaningfully.
  const maxCoverage = Math.max(...scored.map((s) => s.covered), 0);
  const weak = !qTerms.length || (best.score < 1.2 && maxCoverage === 0);

  // Selection floor: higher for knowledge-grounded intents so weak/coincidental matches don't leak through.
  const selectionFloor = intent.type === 'howto' || intent.type === 'list' ? 1.2 : 1.5;
  const selected = dedupe(selectable.filter((s) => s.score > selectionFloor)).slice(0, intent.type === 'howto' || intent.type === 'list' ? 6 : 5);

  // Out-of-scope refusal: zero term overlap with any non-noise knowledge sentence.
  if (!aboutApp && intent.type !== 'greet' && intent.type !== 'thanks' && intent.type !== 'identity') {
    const mascotName = app.mascot?.name || 'the mascot';
    const text = [
      `That's outside my knowledge about **${app.name}** — I'm here to help with questions about this application.`,
      '',
      profile?.features?.length ? 'Things I can help with: ' + profile.features.slice(0, 3).join(', ') + '.' : '',
    ].filter(Boolean).join('\n');
    return { text, used: 0, outOfScope: true };
  }

  if (weak || !selected.length) {
    const relatedHeadings = [...new Set(pool.filter((s) => !s.noise).map((s) => s.heading).filter(Boolean))].slice(0, 4);
    const lines = [
      `I don't have a solid answer for "${truncateQuestion(question)}" in my indexed knowledge yet.`,
      '',
      relatedHeadings.length ? `Closest topics I do know about: ${relatedHeadings.map((h) => `**${h}**`).join(', ')}.` : '',
      '',
      'The app owner can add more knowledge sources so I can cover this — or try one of the topics above.',
    ].filter(Boolean);
    return { text: lines.join('\n'), used: 0 };
  }

  // Compose per intent — sentences stay in their original order for coherence.
  const order = (a, b) => (a.chunkRank - b.chunkRank) || (a.position - b.position);
  let body = '';
  let used = 0;

  const citeSentence = (s) => withCitation(s, s.citeN || 1);

  if (intent.type === 'howto') {
    const steps = selected.slice(0, 6);
    body = pickVariation([
      'Here\'s how to do it:',
      'Step by step:',
      'This is the process:',
    ], question) + '\n\n' + steps.map((s, i) => `${i + 1}. ${citeSentence(s)}`).join('\n');
    used = steps.length;
  } else if (intent.type === 'list') {
    const items = selected.slice(0, 7);
    body = pickVariation([
      'Here\'s what I have on that:',
      'From the docs:',
      'This covers it:',
    ], question) + '\n\n' + items.map((s) => `- ${citeSentence(s)}`).join('\n');
    used = items.length;
  } else if (intent.type === 'troubleshooting') {
    const items = selected.slice(0, 5);
    body = pickVariation([
      'A few things worth checking:',
      'Based on the docs, here\'s what to look at:',
      'This usually comes down to one of these:',
    ], question) + '\n\n' + items.map((s) => `- ${citeSentence(s)}`).join('\n');
    used = items.length;
  } else if (intent.type === 'definition' || intent.type === 'compare' || intent.type === 'why') {
    const lead = selected[0];
    const rest = selected.slice(0, 4);
    // When the user asks about the app itself ("What is docsify?"), lead with
    // the analyzer's distilled definition instead of a raw knowledge sentence.
    const appNameCore = (app.name || '').toLowerCase().split(/\s+/)[0];
    const aboutApp = qTerms.some((t) => t.includes(appNameCore) || appNameCore.includes(t));
    const summaryLead = aboutApp && profile?.summary && intent.type === 'definition'
      ? capitalize(truncate(profile.summary, 320))
      : null;
    if (summaryLead) {
      body = `**${capitalize(qTerms.slice(0, 3).join(' ') || 'It')}** — ${summaryLead}` + (rest.length ? '\n\n' + rest.map((s) => `- ${citeSentence(s)}`).join('\n') : '');
      used = rest.length;
    } else {
      body = `**${capitalize(qTerms.slice(0, 3).join(' ') || 'It')}** — ${lead.text} [${lead.citeN || 1}]` + (rest.length ? '\n\n' + rest.map((s) => `- ${citeSentence(s)}`).join('\n') : '');
      used = 1 + rest.length;
    }
  } else {
    // info: short prose, then optional bullets
    const prose = selected.slice(0, 2);
    const bullets = selected.slice(2, 4);
    body = prose.map((s) => citeSentence(s)).join(' ');
    if (bullets.length) body += '\n\n' + bullets.map((s) => `- ${citeSentence(s)}`).join('\n');
    used = prose.length + bullets.length;
  }

  // Close with sources when citations were used.
  const citedNums = [...new Set(selected.slice(0, used).map((s) => s.citeN).filter(Boolean))];
  const sourceLines = [];
  if (citedNums.length) {
    const labels = citedNums.map((n) => {
      const c = citations.find((c2) => c2.n === n);
      return c ? `[${n}] ${c.label}` : null;
    }).filter(Boolean);
    if (labels.length) sourceLines.push(`Sources: ${labels.join(' · ')}`);
  }

  const offlineNote = p.showOfflineNote === false ? '' : '\n\n_Answered from indexed knowledge — offline mode. Add an LLM provider for fully conversational replies._';

  const text = [body, ...sourceLines].filter(Boolean).join('\n') + offlineNote;
  return { text, used };
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function truncateQuestion(q) {
  const t = String(q || '').trim();
  return t.length > 60 ? t.slice(0, 57) + '…' : t || 'that';
}

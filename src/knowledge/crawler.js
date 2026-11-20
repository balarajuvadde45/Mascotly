// Web crawling primitives: polite fetch (robots.txt-aware), HTML → markdown-lite
// conversion, link extraction, sitemap parsing and GitHub repository ingestion.
// Zero dependencies — global fetch + regex-based HTML handling.
import { decodeHtmlEntities, normalizeUrl, originOf, truncate } from '../util.js';
import { config } from '../config.js';

// ---------- fetch helpers ----------

export async function fetchPage(url, { timeoutMs, maxChars, accept } = {}) {
  const opts = {
    timeoutMs: timeoutMs ?? config.crawl.timeoutMs,
    maxChars: maxChars ?? config.crawl.maxCharsPerPage,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': config.crawl.userAgent,
        accept: accept || 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
    });
    const contentType = res.headers.get('content-type') || '';
    const raw = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      contentType,
      body: truncate(raw, opts.maxChars, ''),
      url: res.url || url, // final URL after redirects
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- robots.txt ----------

const robotsCache = new Map(); // origin -> { rules, fetchedAt }

function parseRobots(text) {
  const rules = { allow: [], disallow: [], crawlDelay: null };
  let appliesToUs = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, fieldRaw, valueRaw] = m;
    const field = fieldRaw.toLowerCase();
    const value = valueRaw.trim();
    if (field === 'user-agent') {
      appliesToUs = value === '*' || /mascotbot/i.test(value);
    } else if (appliesToUs) {
      if (field === 'disallow') rules.disallow.push(value);
      else if (field === 'allow') rules.allow.push(value);
      else if (field === 'crawl-delay') {
        const d = parseFloat(value);
        if (Number.isFinite(d)) rules.crawlDelay = d;
      }
    }
  }
  return rules;
}

export { parseRobots };

function pathMatches(pattern, pathname) {
  if (pattern === '') return false;
  if (pattern === '/') return true;
  // Simple wildcard match: '*' as wildcard.
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}`);
  return re.test(pathname);
}

async function getRobots(origin) {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < 3600_000) return cached.rules;
  let rules = { allow: [], disallow: [], crawlDelay: null, absent: true };
  try {
    const res = await fetchPage(`${origin}/robots.txt`, { maxChars: 100_000, accept: 'text/plain,*/*' });
    if (res.ok && /disallow|user-agent/i.test(res.body)) {
      rules = parseRobots(res.body);
      rules.absent = false;
    }
  } catch {
    // Network failure on robots.txt: treat as allowed but remember briefly.
  }
  robotsCache.set(origin, { rules, fetchedAt: Date.now() });
  return rules;
}

export async function canFetch(url) {
  const u = new URL(url);
  const rules = await getRobots(u.origin);
  if (rules.absent) return true;
  const path = u.pathname + (u.search || '');
  const longestMatch = (patterns) => patterns.reduce(
    (best, p) => (pathMatches(p, path) && p.length > best ? p.length : best),
    -1
  );
  const allowMatch = longestMatch(rules.allow);
  const disallowMatch = longestMatch(rules.disallow);
  if (disallowMatch === -1) return true;
  return allowMatch >= disallowMatch;
}

// ---------- HTML → markdown-lite ----------

const BLOCK_TAGS = 'p|div|section|article|tr|ul|ol|table|blockquote|h[1-6]|li|pre|figcaption|dl|dt|dd|form|main|header|footer';

function stripTagBlocks(html, tag) {
  return html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
}

export function htmlToMarkdownLite(html) {
  let out = String(html ?? '');

  // Drop things that never help knowledge.
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of ['script', 'style', 'noscript', 'svg', 'iframe', 'template', 'canvas', 'video', 'audio', 'object', 'embed']) {
    out = stripTagBlocks(out, tag);
  }
  for (const tag of ['nav', 'header', 'footer', 'aside']) {
    // Only drop the first occurrence pair safely; nested identical tags are rare here.
    out = stripTagBlocks(out, tag);
  }

  // Prefer main/article content when present.
  const mainMatch = out.match(/<(main|article)[^>]*role=["']?main["']?[^>]*>([\s\S]*?)<\/\1>/i)
    || out.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || out.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (mainMatch && mainMatch[mainMatch.length === 3 ? 2 : 1]?.trim().length > 400) {
    out = mainMatch[mainMatch.length === 3 ? 2 : 1];
  }

  const titleMatch = out.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';

  // Code blocks before generic tag stripping so whitespace survives.
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
    const text = code.replace(/<[^>]+>/g, '').replace(/\s+$/g, '');
    return `\n\`\`\`\n${decodeHtmlEntities(text)}\n\`\`\`\n`;
  });

  // Headings → ## markers (h1..h6 collapsed to ## / ### for chunker).
  out = out.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, lvl, inner) => {
    const hashes = Number(lvl) <= 2 ? '##' : '###';
    return `\n${hashes} ${inner.replace(/<[^>]+>/g, '').trim()}\n`;
  });

  // List items → bullets.
  out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_, inner) => `\n- ${inner.replace(/<[^>]+>/g, '').trim()}`);

  // Table rows → pipe lines.
  out = out.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi, (_, row) => {
    const cells = [...row.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)\s*>/gi)]
      .map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    return `\n| ${cells.join(' | ')} |`;
  });

  // Break tags → newlines, then strip everything else.
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  out = out.replace(/<[^>]+>/g, ' ');

  out = decodeHtmlEntities(out);
  out = out
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text: out };
}

export function extractLinks(html, baseUrl) {
  const links = new Set();
  const re = /<a\b[^>]*\shref\s*=\s*["']([^"'#]+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const abs = absoluteUrl(m[1], baseUrl);
    if (abs) links.add(abs);
  }
  return [...links];
}

function absoluteUrl(href, base) {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

// ---------- sitemap ----------

export async function fetchSitemapUrls(sitemapUrl, maxUrls = 25) {
  const urls = [];
  const queue = [normalizeUrl(sitemapUrl)];
  const seen = new Set();
  while (queue.length && urls.length < maxUrls) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    let body = '';
    try {
      const res = await fetchPage(current, { accept: 'application/xml,text/xml,*/*', maxChars: 4_000_000 });
      if (!res.ok) continue;
      body = res.body;
    } catch {
      continue;
    }
    if (/<sitemapindex/i.test(body)) {
      const locs = [...body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
      for (const loc of locs.slice(0, 10)) {
        if (/\.xml(\?|$)/i.test(loc)) queue.push(loc);
      }
      continue;
    }
    for (const m of body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
      const u = normalizeUrl(m[1]);
      if (u && !urls.includes(u)) urls.push(u);
      if (urls.length >= maxUrls) break;
    }
  }
  return urls;
}

// ---------- GitHub ----------

const GH_API = 'https://api.github.com';

export async function fetchGithubRepo(repo, { maxFiles = 20, branch } = {}) {
  const clean = String(repo || '').trim().replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  const m = clean.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new Error('Repository must look like owner/name');
  const [, owner, name] = m;

  const headers = {
    'user-agent': config.crawl.userAgent,
    accept: 'application/vnd.github+json',
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const metaRes = await fetch(`${GH_API}/repos/${owner}/${name}`, { headers });
  if (!metaRes.ok) throw new Error(`GitHub repo lookup failed (${metaRes.status}). ${metaRes.status === 404 ? 'Check owner/name and that the repo is public.' : metaRes.status === 403 ? 'GitHub API rate limit may be hit — set GITHUB_TOKEN.' : ''}`);
  const meta = await metaRes.json();
  const ref = branch || meta.default_branch || 'main';

  const files = [];

  // README
  try {
    const readmeRes = await fetch(`${GH_API}/repos/${owner}/${name}/readme`, {
      headers: { ...headers, accept: 'application/vnd.github.raw' },
    });
    if (readmeRes.ok) {
      files.push({ path: 'README.md', text: await readmeRes.text() });
    }
  } catch { /* optional */ }

  // Docs tree (.md/.mdx under docs/, or repo-root *.md)
  try {
    const treeRes = await fetch(`${GH_API}/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers });
    if (treeRes.ok) {
      const tree = await treeRes.json();
      const candidates = (tree.tree || [])
        .filter((e) => e.type === 'blob'
          && /\.(md|mdx|markdown|txt)$/i.test(e.path)
          && (e.path.startsWith('docs/') || !e.path.includes('/'))
          && (e.size ?? 0) < 200_000)
        .slice(0, maxFiles);
      for (const entry of candidates) {
        if (files.length >= maxFiles + 1) break;
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(ref)}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
        try {
          const r = await fetchPage(rawUrl, { accept: 'text/plain,*/*', maxChars: 200_000 });
          if (r.ok) files.push({ path: entry.path, text: r.body });
        } catch { /* skip file */ }
      }
    }
  } catch { /* optional */ }

  return {
    meta: {
      fullName: meta.full_name,
      description: meta.description || '',
      homepage: meta.homepage || '',
      topics: meta.topics || [],
      stars: meta.stargazers_count ?? null,
      defaultBranch: ref,
      language: meta.language || '',
    },
    files,
  };
}

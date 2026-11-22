/* Mascotly Dashboard — vanilla JS SPA (hash routing, zero dependencies). */
(function () {
  'use strict';

  var appEl = document.getElementById('app');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;
  var jobTimers = [];

  var state = {
    key: localStorage.getItem('mascot_admin_key') || '',
    route: { page: 'apps', appId: null, tab: 'overview' },
    appData: null, // { app, knowledge, hasProfile }
    profile: null,
    sources: [],
    sessions: [],
    chat: { messages: [], busy: false },
    reaStatus: null,
    createBusy: false,
  };

  // ------------------------------------------------------------ helpers

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, ms || 3200);
  }

  function stopJobPolling() {
    jobTimers.forEach(clearInterval);
    jobTimers = [];
  }

  async function api(method, path, body) {
    var opts = {
      method: method,
      headers: { 'x-mascot-key': state.key },
    };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var res = await fetch('/api' + path, opts);
    var data = null;
    try { data = await res.json(); } catch (e) { /* empty */ }
    if (res.status === 401) {
      localStorage.removeItem('mascot_admin_key');
      state.key = '';
      render();
      throw new Error(data && data.message ? data.message : 'Unauthorized — check your admin key');
    }
    if (!res.ok) {
      throw new Error(data && data.message ? data.message : 'Request failed (' + res.status + ')');
    }
    return data;
  }

  function timeAgo(iso) {
    if (!iso) return '—';
    var d = Date.now() - new Date(iso).getTime();
    if (d < 60e3) return Math.max(1, Math.round(d / 1e3)) + 's ago';
    if (d < 3600e3) return Math.round(d / 60e3) + 'm ago';
    if (d < 86400e3) return Math.round(d / 3600e3) + 'h ago';
    return new Date(iso).toLocaleDateString();
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied ✓'); }, function () { toast('Copy failed'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Copied ✓'); } catch (e) { toast('Copy failed'); }
      ta.remove();
    }
  }

  function statusBadge(status) {
    var cls = { ready: 'ready', done: 'done', error: 'error', failed: 'failed', pending: 'pending', running: 'running' }[status] || 'neutral';
    return '<span class="badge ' + cls + '">' + esc(status) + '</span>';
  }

  // ------------------------------------------------------------ routing

  function parseHash() {
    var hash = location.hash.replace(/^#\/?/, '') || 'apps';
    var parts = hash.split('/').filter(Boolean);
    if (parts[0] === 'app' && parts[1]) {
      return { page: 'app', appId: parts[1], tab: parts[2] || 'overview' };
    }
    return { page: parts[0] || 'apps', appId: null, tab: null };
  }

  function nav(hash) { location.hash = hash; }

  window.addEventListener('hashchange', function () {
    stopJobPolling();
    state.route = parseHash();
    state.chat = { messages: [], busy: false };
    render();
  });

  // ------------------------------------------------------------ login

  function renderLogin() {
    appEl.innerHTML = ''
      + '<div class="login-wrap"><div class="login">'
      + '  <div class="logo"><span class="m">🤖</span> Mascotly Dashboard</div>'
      + '  <p class="muted">Enter your admin key to manage mascots. It lives in <span class="mono">data/admin.json</span> (or the MASCOT_ADMIN_KEY env var) and is printed on server boot.</p>'
      + '  <label class="field"><span>Admin key</span><input type="password" id="key-input" placeholder="paste admin key" autocomplete="current-password" /></label>'
      + '  <button id="key-go" style="width:100%">Enter dashboard</button>'
      + '</div></div>';
    var go = function () {
      var v = document.getElementById('key-input').value.trim();
      if (!v) return toast('Key required');
      state.key = v;
      localStorage.setItem('mascot_admin_key', v);
      api('GET', '/system').then(function () {
        state.route = parseHash();
        render();
        toast('Welcome back 👋');
      }).catch(function (err) {
        localStorage.removeItem('mascot_admin_key');
        state.key = '';
        toast(err.message);
      });
    };
    document.getElementById('key-go').onclick = go;
    document.getElementById('key-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    document.getElementById('key-input').focus();
  }

  // ------------------------------------------------------------ shell + apps list

  function shell(content) {
    var r = state.route;
    var inApp = r.page === 'app';
    appEl.innerHTML = ''
      + '<div class="shell">'
      + '  <aside class="sidebar">'
      + '    <div class="logo"><span class="m">🤖</span> Mascotly</div>'
      + '    <a class="nav ' + (r.page === 'apps' ? 'active' : '') + '" href="#/apps">📋 All mascots</a>'
      + '    <a class="nav ' + (r.page === 'forge' ? 'active' : '') + '" href="#/forge">🔥 Forge from repo</a>'
      + '    <a class="nav ' + (r.page === 'create' ? 'active' : '') + '" href="#/create">➕ New mascot</a>'
      + '    <div class="spacer"></div>'
      + '    <div class="foot"><a href="/" target="_blank">landing ↗</a> · <a href="https://github.com/morluto/mascotly" target="_blank" rel="noopener">github ↗</a><br/>v0.1.0</div>'
      + '  </aside>'
      + '  <main class="main">' + content + '</main>'
      + '</div>';
  }

  async function renderApps() {
    var data;
    try { data = await api('GET', '/apps'); } catch (e) { return toast(e.message); }
    var sys = null;
    try { sys = await api('GET', '/system'); } catch (e) { /* ignore */ }
    var llmLine = sys ? ('brain: ' + (sys.providers.llm.configured ? esc(sys.providers.llm.provider + ' · ' + sys.providers.llm.model) : '⚠ offline fallback (no LLM configured)')) : '';
    var reaLine = sys ? ('REA: ' + (sys.providers.rea.mode === 'rea' ? 'installed ✓' : sys.providers.rea.mode === 'npx' ? 'via npx' : 'not detected')) : '';

    var rows = data.apps.map(function (a) {
      return ''
        + '<tr>'
        + '<td><a href="#/app/' + esc(a.id) + '"><b>' + esc(a.name) + '</b></a><div class="muted" style="font-size:12px">' + esc(a.mascot.emoji) + ' ' + esc(a.mascot.name) + '</div></td>'
        + '<td><span class="badge ' + (a.hasProfile ? 'ready' : 'pending') + '">' + (a.hasProfile ? 'analyzed' : 'not analyzed') + '</span></td>'
        + '<td class="mono">' + a.knowledge.chunks + ' chunks<br/><span class="muted">' + a.knowledge.sources.total + ' sources</span></td>'
        + '<td class="mono">' + a.stats.messages + ' msgs<br/><span class="muted">' + esc(timeAgo(a.stats.lastChatAt)) + '</span></td>'
        + '<td style="text-align:right"><a class="btn secondary small" href="#/app/' + esc(a.id) + '">open</a></td>'
        + '</tr>';
    }).join('');

    shell(''
      + '<div class="topbar"><h1>Your mascots</h1><a class="btn" href="#/create">➕ New mascot</a></div>'
      + '<div class="grid cols-3">'
      + '  <div class="stat"><div class="v">' + data.apps.length + '</div><div class="l">apps</div></div>'
      + '  <div class="stat"><div class="v mono" style="font-size:14px;padding-top:5px">' + llmLine + '</div><div class="l">LLM provider</div></div>'
      + '  <div class="stat"><div class="v mono" style="font-size:14px;padding-top:5px">' + reaLine + '</div><div class="l">reverse engineering</div></div>'
      + '</div>'
      + (data.apps.length
        ? '<div class="card"><table><thead><tr><th>app</th><th>status</th><th>knowledge</th><th>activity</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="card empty">No mascots yet.<br/><br/><a class="btn" href="#/create">Create your first mascot</a></div>')
      + '<h2>Quickstart</h2>'
      + '<div class="card"><p>1. Create a mascot and give it knowledge (docs URL, repo, files).</p>'
      + '<p>2. Embed it anywhere:</p>'
      + '<div class="snippet">&lt;script src="' + esc(location.origin) + '/widget/mascot-widget.js"&gt;&lt;/script&gt;\n&lt;script&gt;\n  window.Mascotly.init({ server: \'' + esc(location.origin) + '\', appId: \'app_...\', publicKey: \'pk_...\' });\n&lt;/script&gt;</div>'
      + '</div>');
  }

  // ------------------------------------------------------------ forge
  var forgeState = { result: null, busy: false };
  try { forgeState.result = JSON.parse(sessionStorage.getItem('mascotly_forge_result') || 'null'); } catch (e) { forgeState.result = null; }
  function saveForgeResult(r) {
    forgeState.result = r;
    try { sessionStorage.setItem('mascotly_forge_result', JSON.stringify(r)); } catch (e) { /* noop */ }
  }

  function renderForge() {
    var r = forgeState.result;
    shell(''
      + '<div class="topbar"><h1>🔥 Forge — repo → mascot</h1></div>'
      + '<div class="card"><p class="muted" style="margin:0 0 6px">Give Mascotly any repository (public, or private with a GitHub token). It ingests the code and docs, analyzes what the app is and what its users ask, designs a mascot with skills, and hands you the embed snippet — plus an optional one-shot Vercel deploy of a bot starter page.</p>'
      + '<p class="muted" style="margin:0">Requires an LLM provider — the Forge needs a real brain to design the bot.</p></div>'
      + '<div class="card">'
      + '  <div class="grid cols-2">'
      + '    <label class="field"><span>Repository (owner/name or GitHub URL) *</span><input type="text" id="f-repo" placeholder="docsifyjs/docsify"/></label>'
      + '    <label class="field"><span>What should the bot do? (intent, free text)</span><input type="text" id="f-intent" placeholder="A docs assistant that helps new users get started"/></label>'
      + '    <label class="field"><span>GitHub token (optional — private repos)</span><input type="password" id="f-gh" placeholder="ghp_…"/></label>'
      + '    <label class="field"><span>Vercel token (optional — deploy a starter page)</span><input type="password" id="f-vc" placeholder="vercel token"/></label>'
      + '  </div>'
      + '  <button id="f-go">🔥 Forge the mascot</button>'
      + '  <div id="f-progress" style="margin-top:14px"></div>'
      + '</div>'
      + (r ? renderForgeResult(r) : '')
    );
    bindForgeEvents();
  }

  function renderForgeResult(r) {
    return ''
      + '<h2>🔥 Forged: ' + esc(r.appName) + '</h2>'
      + '<div class="card">'
      + '  <h3>What the repo is</h3><p class="muted">' + esc(r.analysis.whatItIs || '') + '</p>'
      + '  <h3>Users</h3><p class="muted">' + esc(r.analysis.users || '') + '</p>'
      + '  <h3>Top questions the bot should answer</h3><ul>' + (r.analysis.topQuestions || []).map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>'
      + '  <h3>The mascot</h3><div class="pill-row">'
      + '    <span class="pill">' + esc((r.spec.mascot && r.spec.mascot.emoji) || '🤖') + ' ' + esc((r.spec.mascot && r.spec.mascot.name) || '') + '</span>'
      + '    <span class="pill">' + esc((r.spec.mascot && r.spec.mascot.tagline) || '') + '</span>'
      + '    <span class="pill">' + esc(r.intentLabel || 'forge') + '</span>'
      + '  </div>'
      + '  <h3>Skills installed</h3><ul>' + (r.spec.skills || []).map(function (sn) { return '<li class="mono">' + esc(sn) + '</li>'; }).join('') + '</ul>'
      + '</div>'
      + '<div class="card"><h3>Embed snippet</h3><div class="snippet" id="forge-snippet">' + esc(r.snippet) + '<button class="copy secondary small" data-target="forge-snippet">copy</button></div>'
      + '<a class="btn secondary small" style="margin-top:10px" href="#/app/' + esc(r.appId) + '/overview">Open the forged app →</a> '
      + '<button class="ghost small" id="forge-clear">Start a new forge</button></div>'
      + '<div class="card"><h3>Deployment</h3>'
      + (r.deploy.vercel && r.deploy.vercel.url
        ? '<p>✅ Bot starter deployed: <a href="' + esc(r.deploy.vercel.url) + '" target="_blank" rel="noopener">' + esc(r.deploy.vercel.url) + '</a></p>'
        : '<p class="muted">' + ((r.deploy.vercel && r.deploy.vercel.steps) ? r.deploy.vercel.steps.map(esc).join('<br/>') : '') + '</p>')
      + '<p class="muted" style="margin-top:8px"><b>AWS:</b> ' + esc((r.deploy.aws && r.deploy.aws.steps || []).join(' · ')) + '</p>'
      + '</div>';
  }

  function bindForgeEvents() {
    var go = document.getElementById('f-go');
    if (!go) return;
    go.onclick = async function () {
      if (forgeState.busy) return;
      var repo = document.getElementById('f-repo').value.trim();
      if (!repo) return toast('Repository required');
      forgeState.busy = true;
      go.disabled = true;
      var progress = document.getElementById('f-progress');
      progress.innerHTML = '<div class="progress"><div style="width:4%"></div></div><div class="muted" style="margin-top:6px">Forging… ingesting the repo, analyzing, designing the mascot.</div>';
      try {
        var res = await api('POST', '/forge', {
          repo: repo,
          intent: document.getElementById('f-intent').value.trim(),
          githubToken: document.getElementById('f-gh').value.trim() || undefined,
          vercelToken: document.getElementById('f-vc').value.trim() || undefined,
        });
        if (res.inline) {
          saveForgeResult(res.result);
          forgeState.busy = false;
          renderForge();
          return;
        }
        var iv = setInterval(async function () {
          try {
            var jr = await api('GET', '/forge/jobs/' + res.jobId);
            var job = jr.job;
            var bar = progress.querySelector('.progress > div');
            if (bar) bar.style.width = Math.max(4, job.progress || 4) + '%';
            progress.querySelector('.muted').textContent = job.steps.length ? job.steps[job.steps.length - 1].name : 'working…';
            if (job.status === 'done' || job.status === 'failed') {
              clearInterval(iv);
              forgeState.busy = false;
              if (job.status === 'failed') {
                progress.innerHTML = '<span class="badge failed">failed</span> <span class="muted">' + esc(job.error || '') + '</span>';
                go.disabled = false;
                return;
              }
              // Reconstruct the result from the created app (job.result carries app.id).
              var appId = job.result && job.result.appId;
              if (!appId) { progress.innerHTML = '<span class="badge failed">forge produced no app</span>'; return; }
              var full = await api('GET', '/apps/' + appId);
              var profile = (await api('GET', '/apps/' + appId + '/profile')).profile || {};
              var manifest = (await api('GET', '/apps/' + appId + '/plugin-manifest')).manifest || {};
              var server = location.origin;
              saveForgeResult({
                appId: appId,
                appName: full.app.name,
                publicKey: full.app.publicKey,
                analysis: { whatItIs: profile.summary || '', users: profile.audience || '', topQuestions: (profile.suggestions || []).concat(full.app.mascot.suggestions || []) },
                spec: { mascot: full.app.mascot, skills: (manifest.skills || []).map(function (sk) { return sk.name; }) },
                intentLabel: (job.result && job.result.intentLabel) || 'forge',
                snippet: '<script src="' + server + '/widget/mascot-widget.js"></script>\n<script>\n  window.Mascotly.init({ server: \'' + server + '\', appId: \'' + appId + '\', publicKey: \'' + full.app.publicKey + '\' });\n</script>',
                deploy: (job.result && job.result.deploy) || {},
              });
              renderForge();
            }
          } catch (e) { clearInterval(iv); window.__pollErr = String(e && e.message || e); }
        }, 1500);
      } catch (e) {
        toast(e.message);
        forgeState.busy = false;
        go.disabled = false;
        progress.innerHTML = '';
      }
    };
    var clearBtn = document.getElementById('forge-clear');
    if (clearBtn) clearBtn.onclick = function () {
      try { sessionStorage.removeItem('mascotly_forge_result'); } catch (e) { /* noop */ }
      forgeState.result = null;
      renderForge();
    };
    var copy = document.querySelector('#forge-snippet .copy');
    if (copy) copy.onclick = function () {
      var t = document.getElementById('forge-snippet');
      copyText(t.textContent.replace(/copy$/, ''));
    };
  }

  // ------------------------------------------------------------ create

  function renderCreate() {
    shell(''
      + '<div class="topbar"><h1>New mascot</h1></div>'
      + '<div class="card">'
      + '  <p class="muted">Give your mascot an identity and a first knowledge source. You can refine everything later. After creation, add more sources and run the analyzer from the app page.</p>'
      + '  <label class="field"><span>App name *</span><input type="text" id="c-name" placeholder="My App" /></label>'
      + '  <label class="field"><span>What does the app do? (description)</span><textarea id="c-desc" placeholder="A minimal note-taking app for developers…"></textarea></label>'
      + '  <div class="grid cols-2">'
      + '    <label class="field"><span>Docs URL (optional, crawled right away)</span><input type="url" id="c-docs" placeholder="https://yourapp.com/docs" /></label>'
      + '    <label class="field"><span>GitHub repo (owner/name, optional)</span><input type="text" id="c-repo" placeholder="yourorg/yourrepo" /></label>'
      + '  </div>'
      + '  <div class="grid cols-3">'
      + '    <label class="field"><span>Mascotly name</span><input type="text" id="c-mname" placeholder="Mottie" /></label>'
      + '    <label class="field"><span>Emoji</span><input type="text" id="c-emoji" value="🤖" maxlength="4" /></label>'
      + '    <label class="field"><span>Accent color</span><input type="color" id="c-color" value="#6c5ce7" /></label>'
      + '  </div>'
      + '  <label class="field"><span>Greeting</span><input type="text" id="c-greet" placeholder="Hi! I\'m Mottie — ask me anything about this app." /></label>'
      + '  <button id="c-go">Create mascot →</button>'
      + '</div>');
    document.getElementById('c-go').onclick = async function () {
      if (state.createBusy) return;
      var name = document.getElementById('c-name').value.trim();
      if (!name) return toast('App name is required');
      state.createBusy = true;
      this.disabled = true;
      try {
        var payload = {
          name: name,
          description: document.getElementById('c-desc').value.trim(),
          mascot: {
            name: document.getElementById('c-mname').value.trim() || 'Mottie',
            emoji: document.getElementById('c-emoji').value.trim() || '🤖',
            color: document.getElementById('c-color').value,
            greeting: document.getElementById('c-greet').value.trim() || undefined,
          },
        };
        var docsUrl = document.getElementById('c-docs').value.trim();
        var repo = document.getElementById('c-repo').value.trim();
        if (docsUrl) payload.docsUrl = docsUrl;
        var created = await api('POST', '/apps', payload);
        var app = created.app;
        if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo)) {
          try { await api('POST', '/apps/' + app.id + '/sources', { type: 'github', repo: repo }); } catch (e) { toast('GitHub source failed: ' + e.message); }
        }
        toast('Mascotly created ✓');
        nav('#/app/' + app.id + '/overview');
      } catch (e) {
        toast(e.message);
        this.disabled = false;
      } finally {
        state.createBusy = false;
      }
    };
  }

  // ------------------------------------------------------------ app detail

  var TABS = ['overview', 'mascot', 'knowledge', 'capabilities', 'rea', 'chat', 'sessions', 'settings'];

  function tabNav(active, appId) {
    return '<div class="tabs">' + TABS.map(function (t) {
      return '<a href="#/app/' + esc(appId) + '/' + t + '" class="' + (active === t ? 'active' : '') + '">' + t + '</a>';
    }).join('') + '</div>';
  }

  async function loadAppData(appId) {
    var data = await api('GET', '/apps/' + appId);
    state.appData = data;
    try { state.profile = (await api('GET', '/apps/' + appId + '/profile')).profile; } catch (e) { state.profile = null; }
    try { state.sources = (await api('GET', '/apps/' + appId + '/sources')).sources; } catch (e) { state.sources = []; }
    try { state.sessions = (await api('GET', '/apps/' + appId + '/sessions')).sessions; } catch (e) { state.sessions = []; }
    try { state.reaStatus = await api('GET', '/apps/' + appId + '/rea/status'); } catch (e) { state.reaStatus = null; }
  }

  async function renderAppPage() {
    var r = state.route;
    if (!TABS.includes(r.tab)) r.tab = 'overview'; // normalize unknown tab hashes
    try { await loadAppData(r.appId); } catch (e) { return toast(e.message); }
    if (r.tab === 'capabilities') { await loadCapabilities(r.appId).catch(function () {}); }
    var data = state.appData;
    var app = data.app;
    var head = ''
      + '<div class="topbar">'
      + '  <div><h1>' + esc(app.mascot.emoji) + ' ' + esc(app.name) + ' <span class="muted" style="font-size:13px;font-weight:400">· ' + esc(app.mascot.name) + '</span></h1>'
      + '  <div class="muted mono" style="font-size:12px">appId: ' + esc(app.id) + ' · publicKey: ' + esc(app.publicKey) + '</div></div>'
      + '  <button class="secondary" id="analyze-btn">' + (state.profile ? '🔄 Re-run analyzer' : '⚡ Run analyzer') + '</button>'
      + '</div>'
      + tabNav(r.tab, app.id);
    var body = '';
    switch (r.tab) {
      case 'mascot': body = tabMascotly(app); break;
      case 'knowledge': body = tabKnowledge(app); break;
      case 'capabilities': body = tabCapabilities(app); break;
      case 'rea': body = tabRea(app); break;
      case 'chat': body = tabChat(app); break;
      case 'sessions': body = tabSessions(app); break;
      case 'settings': body = tabSettings(app); break;
      default: body = tabOverview(app);
    }
    shell(head + body);

    var analyzeBtn = document.getElementById('analyze-btn');
    if (analyzeBtn) {
      analyzeBtn.onclick = async function () {
        analyzeBtn.disabled = true;
        try {
          var res = await api('POST', '/apps/' + app.id + '/analyze');
          if (res.inline) {
            // Serverless mode analyzed inline within the request.
            if (res.ok === false) throw new Error(res.message || 'analysis failed');
            toast('Analysis complete ✓');
            renderAppPage();
            return;
          }
          pollJob(app.id, res.jobId, function (job) {
            if (job.status === 'done') { toast('Analysis complete ✓'); renderAppPage(); }
            else if (job.status === 'failed') { toast('Analysis failed: ' + (job.error || '')); renderAppPage(); }
          });
          toast('Analysis started…');
        } catch (e) { toast(e.message); analyzeBtn.disabled = false; }
      };
    }
    bindTabEvents(app);
  }

  function pollJob(appId, jobId, onDone) {
    var routeAtStart = state.route.appId + '/' + state.route.tab;
    var iv = setInterval(async function () {
      // Abort silently when the user navigated away mid-poll.
      if ((state.route.appId + '/' + state.route.tab) !== routeAtStart) {
        clearInterval(iv);
        jobTimers = jobTimers.filter(function (t) { return t !== iv; });
        return;
      }
      try {
        var res = await api('GET', '/apps/' + appId + '/jobs/' + jobId);
        var job = res.job;
        if (job.status === 'done' || job.status === 'failed') {
          clearInterval(iv);
          jobTimers = jobTimers.filter(function (t) { return t !== iv; });
          if (onDone) onDone(job);
        }
      } catch (e) {
        clearInterval(iv);
        jobTimers = jobTimers.filter(function (t) { return t !== iv; });
        toast('Lost track of the job (server restarted?) — refresh the page.');
      }
    }, 1500);
    jobTimers.push(iv);
  }

  // ---- tab: overview ----
  function tabOverview(app) {
    var p = state.profile;
    var k = state.appData.knowledge;
    var jobsHtml = (app.jobs || []).map(function (j) {
      return '<details class="job"><summary>' + statusBadge(j.status) + ' ' + esc(j.type) + ' — ' + esc(j.label || '') + ' <span class="muted">(' + esc(timeAgo(j.updatedAt)) + ')</span></summary>'
        + '<ul class="steps">' + (j.steps || []).map(function (s) { return '<li>' + esc(s.name) + (s.detail ? ' — ' + esc(s.detail) : '') + '</li>'; }).join('') + '</ul>'
        + (j.error ? '<div class="badge red" style="margin-top:8px">' + esc(j.error) + '</div>' : '')
        + '</details>';
    }).join('');

    return ''
      + '<div class="grid cols-3">'
      + '  <div class="stat"><div class="v">' + k.chunks + '</div><div class="l">knowledge chunks</div></div>'
      + '  <div class="stat"><div class="v">' + k.sources.total + '</div><div class="l">sources (' + (k.sources.ready || 0) + ' ready)</div></div>'
      + '  <div class="stat"><div class="v">' + app.stats.messages + '</div><div class="l">messages answered</div></div>'
      + '</div>'
      + (p
        ? '<h2>App understanding <span class="badge ' + (p.engine === 'llm' ? 'ready' : 'amber') + '">' + esc(p.engine || p.confidence || 'heuristic') + ' engine</span></h2>'
          + '<div class="card"><p>' + esc(p.summary || p.purpose || 'No summary generated yet.') + '</p>'
          + (p.features && p.features.length ? '<h3>Features</h3><div class="pill-row">' + p.features.map(function (f) { return '<span class="pill">' + esc(f) + '</span>'; }).join('') + '</div>' : '')
          + (p.audience ? '<p class="muted" style="margin-top:12px">Audience: ' + esc(p.audience) + '</p>' : '')
          + (p.limitations && p.limitations.length ? '<h3>Limitations</h3><ul>' + p.limitations.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' : '')
          + (p.reaInsights ? '<h3>REA insights</h3><div class="pill-row">'
            + Object.keys(p.reaInsights).filter(function (key) { return Array.isArray(p.reaInsights[key]) && p.reaInsights[key].length; })
              .map(function (key) { return '<span class="pill">' + esc(key) + ': ' + p.reaInsights[key].length + '</span>'; }).join('')
            + '</div>' : '')
          + '</div>'
        : '<h2>App understanding</h2><div class="card empty">Not analyzed yet.<br/><br/>Add knowledge sources first, then click <b>Run analyzer</b> above.</div>')
      + '<h2>Recent jobs</h2>'
      + (jobsHtml || '<div class="card muted">No jobs yet.</div>');
  }

  // ---- tab: mascot ----
  var EMOJIS = ['🤖', '🧪', '👋', '🐱', '🦊', '🐼', '🐧', '🦉', '🐙', '🤓', '😎', '🚀', '🔮', '🧠', '💡', '⭐', '🌈', '🛸', '👾', '🦾'];

  function tabMascotly(app) {
    var m = app.mascot;
    return ''
      + '<div class="card">'
      + '  <h3>Identity</h3>'
      + '  <div class="grid cols-3">'
      + '    <label class="field"><span>Name</span><input type="text" id="m-name" value="' + esc(m.name) + '" /></label>'
      + '    <label class="field"><span>Tagline</span><input type="text" id="m-tagline" value="' + esc(m.tagline) + '" /></label>'
      + '    <label class="field"><span>Accent color</span><input type="color" id="m-color" value="' + esc(m.color) + '" /></label>'
      + '  </div>'
      + '  <label class="field"><span>Emoji</span><div class="emoji-row" id="m-emoji-row">'
      + EMOJIS.map(function (e) { return '<button type="button" data-emoji="' + e + '" class="' + (e === m.emoji ? 'active' : '') + '">' + e + '</button>'; }).join('')
      + '  </div></label>'
      + '  <label class="field"><span>Greeting (first message in chat)</span><textarea id="m-greeting">' + esc(m.greeting) + '</textarea></label>'
      + '  <label class="field"><span>Personality (prompt)</span><textarea id="m-personality">' + esc(m.personality) + '</textarea></label>'
      + '  <label class="field"><span>Starter suggestions (one per line, max 4)</span><textarea id="m-suggestions">' + esc((m.suggestions || []).join('\n')) + '</textarea></label>'
      + '  <label class="check"><input type="checkbox" id="m-welcome" ' + (m.welcome ? 'checked' : '') + '/> show proactive teaser bubble</label>'
      + '  <label class="field"><span>Bubble position</span><select id="m-position">'
      + '    <option value="bottom-right" ' + (m.position !== 'bottom-left' ? 'selected' : '') + '>bottom right</option>'
      + '    <option value="bottom-left" ' + (m.position === 'bottom-left' ? 'selected' : '') + '>bottom left</option>'
      + '  </select></label>'
      + '  <button id="m-save">Save identity</button>'
      + '</div>'
      + '<div class="card">'
      + '  <h3>Host actions <span class="muted" style="font-weight:400">(things the mascot can do inside your app)</span></h3>'
      + '  <p class="muted">Register handlers in your app: <span class="mono">Mascotly.registerAction(name, fn)</span>. The mascot triggers them via a JSON action protocol. A built-in <span class="mono">escalate</span> action always exists.</p>'
      + '  <div id="m-actions">' + (m.actions || []).map(function (a, i) {
        return '<div class="grid cols-2" style="margin-bottom:8px">'
          + '<input type="text" class="act-name" data-i="' + i + '" value="' + esc(a.name) + '" placeholder="action name"/>'
          + '<input type="text" class="act-desc" data-i="' + i + '" value="' + esc(a.description) + '" placeholder="when to use it"/>'
          + '</div>';
      }).join('') + '</div>'
      + '  <button class="secondary small" id="m-add-action">+ add action</button> '
      + '  <button id="m-save-actions">Save actions</button>'
      + '</div>'
      + '<div class="card">'
      + '  <h3>Embed snippet</h3>'
      + '  <div class="snippet" id="embed-snippet">&lt;script src="' + esc(location.origin) + '/widget/mascot-widget.js"&gt;&lt;/script&gt;\n&lt;script&gt;\n  window.Mascotly.init({\n    server: \'' + esc(location.origin) + '\',\n    appId: \'' + esc(app.id) + '\',\n    publicKey: \'' + esc(app.publicKey) + '\'\n  });\n\n  // optional: let the mascot drive your app\n  window.Mascotly.registerAction(\'navigate\', function (args) {\n    location.href = args.url;\n  });\n&lt;/script&gt;<button class="copy secondary small" data-target="embed-snippet">copy</button></div>'
      + '</div>';
  }

  function bindTabEvents(app) {
    var r = state.route;
    var saveMascotly = document.getElementById('m-save');
    if (saveMascotly) {
      document.getElementById('m-emoji-row').addEventListener('click', function (e) {
        var btn = e.target.closest('button');
        if (!btn) return;
        this.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
      });
      saveMascotly.onclick = async function () {
        var suggestions = document.getElementById('m-suggestions').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 4);
        var activeEmoji = document.querySelector('#m-emoji-row button.active');
        try {
          await api('PATCH', '/apps/' + app.id, {
            mascot: {
              name: document.getElementById('m-name').value.trim(),
              tagline: document.getElementById('m-tagline').value.trim(),
              color: document.getElementById('m-color').value,
              emoji: activeEmoji ? activeEmoji.dataset.emoji : '🤖',
              greeting: document.getElementById('m-greeting').value.trim(),
              personality: document.getElementById('m-personality').value.trim(),
              suggestions: suggestions,
              welcome: document.getElementById('m-welcome').checked,
              position: document.getElementById('m-position').value,
            },
          });
          toast('Identity saved ✓');
          renderAppPage();
        } catch (e) { toast(e.message); }
      };
      document.getElementById('m-add-action').onclick = function () {
        var row = document.createElement('div');
        row.className = 'grid cols-2';
        row.style.marginBottom = '8px';
        var idx = document.querySelectorAll('#m-actions .act-name').length;
        row.innerHTML = '<input type="text" class="act-name" data-i="' + idx + '" placeholder="action name"/><input type="text" class="act-desc" data-i="' + idx + '" placeholder="when to use it"/>';
        document.getElementById('m-actions').appendChild(row);
      };
      document.getElementById('m-save-actions').onclick = async function () {
        var names = Array.prototype.map.call(document.querySelectorAll('#m-actions .act-name'), function (el2) { return el2.value.trim(); });
        var descs = Array.prototype.map.call(document.querySelectorAll('#m-actions .act-desc'), function (el2) { return el2.value.trim(); });
        var actions = [];
        names.forEach(function (n, i) {
          if (n) actions.push({ name: n, description: descs[i] || '' });
        });
        try {
          await api('PATCH', '/apps/' + app.id, { mascot: { actions: actions } });
          toast('Actions saved ✓');
        } catch (e) { toast(e.message); }
      };
    }

    var embedSnippet = document.querySelector('.copy');
    if (embedSnippet) {
      embedSnippet.onclick = function () {
        var target = document.getElementById(this.dataset.target);
        copyText(target.textContent.replace(/copy$/, ''));
      };
    }

    if (r.tab === 'knowledge') bindKnowledgeEvents(app);
    if (r.tab === 'capabilities') bindCapabilitiesEvents(app);
    if (r.tab === 'rea') bindReaEvents(app);
    if (r.tab === 'chat') bindChatEvents(app);
    if (r.tab === 'sessions') bindSessionsEvents(app);
    if (r.tab === 'settings') bindSettingsEvents(app);
  }

  // ---- tab: knowledge ----
  var ADD_TYPES = [
    { id: 'url', label: 'URL', fields: ['url', 'label'] },
    { id: 'crawl', label: 'Crawl', fields: ['url', 'maxPages'] },
    { id: 'sitemap', label: 'Sitemap', fields: ['url'] },
    { id: 'github', label: 'GitHub', fields: ['repo'] },
    { id: 'text', label: 'Text', fields: ['label', 'text'] },
    { id: 'file', label: 'File', fields: ['file'] },
    { id: 'reviews', label: 'Reviews', fields: ['label', 'text'] },
  ];

  function tabKnowledge(app) {
    var k = state.appData.knowledge;
    var rows = state.sources.map(function (s) {
      return '<tr>'
        + '<td>' + statusBadge(s.status) + '</td>'
        + '<td><b>' + esc(s.label) + '</b><div class="muted mono" style="font-size:11.5px">' + esc(s.type) + (s.error ? ' · ' + esc(s.error) : '') + '</div></td>'
        + '<td class="mono">' + s.chunkCount + ' chunks<br/><span class="muted">' + Math.round((s.charCount || 0) / 100) / 10 + 'k chars</span></td>'
        + '<td class="muted">' + esc(timeAgo(s.fetchedAt || s.createdAt)) + '</td>'
        + '<td style="text-align:right;white-space:nowrap">'
        + '  <button class="ghost small reingest" data-id="' + esc(s.id) + '">re-ingest</button> '
        + '  <button class="ghost small del-source" data-id="' + esc(s.id) + '">delete</button>'
        + '</td></tr>';
    }).join('');

    var addTabs = ADD_TYPES.map(function (t, i) {
      return '<button data-add="' + t.id + '" class="' + (i === 0 ? 'active' : '') + '">' + t.label + '</button>';
    }).join('');

    return ''
      + '<div class="grid cols-3">'
      + '  <div class="stat"><div class="v">' + k.chunks + '</div><div class="l">chunks</div></div>'
      + '  <div class="stat"><div class="v">' + Math.round(k.chars / 100) / 10 + 'k</div><div class="l">characters indexed</div></div>'
      + '  <div class="stat"><div class="v">' + (k.embedded ? 'vector ✓' : 'BM25 + TF-IDF') + '</div><div class="l">retrieval mode</div></div>'
      + '</div>'
      + '<h2>Sources</h2>'
      + (rows ? '<div class="card"><table><thead><tr><th>status</th><th>source</th><th>size</th><th>updated</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="card empty">No knowledge sources yet — add one below.</div>')
      + '<h2>Add knowledge</h2>'
      + '<div class="card">'
      + '  <div class="add-tabs" id="add-tabs">' + addTabs + '</div>'
      + '  <div id="add-form"></div>'
      + '</div>'
      + '<h2>Retrieval tester</h2>'
      + '<div class="card">'
      + '  <div style="display:flex;gap:8px">'
      + '    <input type="text" id="rt-query" placeholder="test a query against the knowledge base…" style="flex:1"/>'
      + '    <button id="rt-go">Search</button>'
      + '  </div>'
      + '  <div id="rt-results" style="margin-top:12px"></div>'
      + '</div>';
  }

  function renderAddForm(type) {
    var form = document.getElementById('add-form');
    if (type === 'url') {
      form.innerHTML = '<label class="field"><span>Page URL</span><input type="url" id="af-url" placeholder="https://app.com/docs/getting-started"/></label>'
        + '<label class="field"><span>Label (optional)</span><input type="text" id="af-label" placeholder="Getting started docs"/></label>'
        + '<button id="af-go">Fetch &amp; index</button>';
    } else if (type === 'crawl') {
      form.innerHTML = '<label class="field"><span>Start URL (crawls same-site links up to depth 2)</span><input type="url" id="af-url" placeholder="https://app.com/docs"/></label>'
        + '<label class="field"><span>Max pages</span><input type="number" id="af-max" value="10" min="1" max="50"/></label>'
        + '<button id="af-go">Start crawl</button>';
    } else if (type === 'sitemap') {
      form.innerHTML = '<label class="field"><span>Sitemap URL</span><input type="url" id="af-url" placeholder="https://app.com/sitemap.xml"/></label>'
        + '<button id="af-go">Fetch sitemap &amp; index</button>';
    } else if (type === 'github') {
      form.innerHTML = '<label class="field"><span>Repository (owner/name — public)</span><input type="text" id="af-repo" placeholder="morluto/mascotly"/></label>'
        + '<label class="field"><span>Branch (optional)</span><input type="text" id="af-branch" placeholder="main"/></label>'
        + '<button id="af-go">Ingest repo docs</button>';
    } else if (type === 'text' || type === 'reviews') {
      form.innerHTML = '<label class="field"><span>Label</span><input type="text" id="af-label" placeholder="' + (type === 'reviews' ? 'App store reviews 2026-01' : 'Internal FAQ') + '"/></label>'
        + '<label class="field"><span>' + (type === 'reviews' ? 'Reviews (one per line or blank-line separated)' : 'Text (markdown/plain)') + '</span><textarea id="af-text" style="min-height:160px"></textarea></label>'
        + '<button id="af-go">Index ' + (type === 'reviews' ? 'reviews' : 'text') + '</button>';
    } else if (type === 'file') {
      form.innerHTML = '<label class="field"><span>Upload a text file (.md, .txt, .html, .csv, .json)</span><input type="file" id="af-file"/></label>'
        + '<button id="af-go">Index file</button>';
    }
    document.getElementById('af-go').onclick = function () { submitAddForm(type); };
  }

  async function submitAddForm(type) {
    var app = state.appData.app;
    var goBtn = document.getElementById('af-go');
    if (goBtn && goBtn.disabled) return; // double-submit guard
    if (goBtn) goBtn.disabled = true;
    var body = { type: type };
    try {
      if (type === 'url') {
        body.url = document.getElementById('af-url').value.trim();
        body.label = document.getElementById('af-label').value.trim();
        if (!body.url) return toast('URL required');
      } else if (type === 'crawl') {
        body.url = document.getElementById('af-url').value.trim();
        body.maxPages = parseInt(document.getElementById('af-max').value, 10) || 10;
        if (!body.url) return toast('URL required');
      } else if (type === 'sitemap') {
        body.url = document.getElementById('af-url').value.trim();
        if (!body.url) return toast('URL required');
      } else if (type === 'github') {
        body.repo = document.getElementById('af-repo').value.trim();
        body.branch = document.getElementById('af-branch').value.trim() || undefined;
        if (!body.repo) return toast('Repo required');
      } else if (type === 'text' || type === 'reviews') {
        body.label = document.getElementById('af-label').value.trim() || (type === 'reviews' ? 'Reviews' : 'Pasted text');
        body.text = document.getElementById('af-text').value;
        if (!body.text.trim()) return toast('Text required');
      } else if (type === 'file') {
        var f = document.getElementById('af-file').files[0];
        if (!f) return toast('Choose a file');
        var isText = /\.(md|markdown|txt|html?|csv|json|ya?ml|log)$/i.test(f.name);
        var content;
        if (isText) {
          content = await f.text();
          body.encoding = 'text';
        } else {
          content = await new Promise(function (resolve, reject) {
            var r = new FileReader();
            r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
            r.onerror = reject;
            r.readAsDataURL(f);
          });
          body.encoding = 'base64';
        }
        body.label = f.name;
        body.content = content;
        body.mime = f.type || '';
      }

      var res = await api('POST', '/apps/' + app.id + '/sources', body);
      if (res.jobId) {
        toast('Source queued…');
        pollJob(app.id, res.jobId, function (job) {
          if (job.status === 'done') { toast('Source indexed ✓'); renderAppPage(); }
          else if (job.status === 'failed') { toast('Ingest failed: ' + (job.error || '')); renderAppPage(); }
        });
        renderAppPage();
      } else {
        toast('Indexed ✓ (' + (res.chunkCount || 0) + ' chunks)');
        renderAppPage();
      }
    } catch (e) {
      toast(e.message);
    } finally {
      if (goBtn) goBtn.disabled = false;
    }
  }

  function bindKnowledgeEvents(app) {
    document.getElementById('add-tabs').addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      this.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      renderAddForm(btn.dataset.add);
    });
    renderAddForm('url');

    document.querySelectorAll('.del-source').forEach(function (btn) {
      btn.onclick = async function () {
        if (!confirm('Delete this source and its chunks?')) return;
        try {
          await api('DELETE', '/apps/' + app.id + '/sources/' + btn.dataset.id);
          toast('Source deleted');
          renderAppPage();
        } catch (e) { toast(e.message); }
      };
    });
    document.querySelectorAll('.reingest').forEach(function (btn) {
      btn.onclick = async function () {
        try {
          var res = await api('POST', '/apps/' + app.id + '/sources/' + btn.dataset.id + '/reingest');
          if (res.jobId) {
            toast('Re-ingest queued…');
            pollJob(app.id, res.jobId, function (job) {
              toast(job.status === 'done' ? 'Re-ingested ✓' : 'Re-ingest failed: ' + (job.error || ''));
              renderAppPage();
            });
          } else {
            toast('Re-ingested ✓');
            renderAppPage();
          }
        } catch (e) { toast(e.message); }
      };
    });

    document.getElementById('rt-go').onclick = async function () {
      var q = document.getElementById('rt-query').value.trim();
      var out = document.getElementById('rt-results');
      if (!q) return;
      out.innerHTML = '<span class="spinner"></span>';
      try {
        var res = await api('POST', '/apps/' + app.id + '/search', { query: q, k: 6 });
        out.innerHTML = res.results.length
          ? res.results.map(function (r2) {
            return '<div class="card tight" style="margin-bottom:8px"><div class="muted mono" style="font-size:11.5px">score ' + r2.score + ' · ' + esc(r2.label) + (r2.heading ? ' · ' + esc(r2.heading) : '') + '</div>' + esc(r2.text) + '</div>';
          }).join('')
          : '<div class="muted">No results.</div>';
      } catch (e) {
        out.innerHTML = '<div class="badge red">' + esc(e.message) + '</div>';
      }
    };
  }

  // ---- tab: capabilities (skills / tools / hooks) ----
  async function loadCapabilities(appId) {
    var out = { skills: [], tools: [], hooks: [] };
    try { out.skills = (await api('GET', '/apps/' + appId + '/skills')).skills; } catch (e) { /* noop */ }
    try { out.tools = (await api('GET', '/apps/' + appId + '/tools')).tools; } catch (e) { /* noop */ }
    try { out.hooks = (await api('GET', '/apps/' + appId + '/hooks')).hooks; } catch (e) { /* noop */ }
    state.capabilities = out;
    return out;
  }

  function tabCapabilities(app) {
    var cap = state.capabilities || { skills: [], tools: [], hooks: [] };
    return ''
      + '<div class="card"><p class="muted" style="margin:0">Era capabilities: <b>Skills</b> are SKILL.md-compatible instruction packs the mascot applies when relevant · <b>Tool plugins</b> are HTTP endpoints the mascot can call mid-chat · <b>Hooks</b> are HMAC-signed webhooks fired on lifecycle events.</p></div>'
      // skills
      + '<h2>Skills <span class="muted" style="font-size:12px;font-weight:400">(SKILL.md packs, max 12)</span></h2>'
      + (cap.skills.length
        ? '<div class="card">' + cap.skills.map(function (s) {
          return '<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">'
            + '<span class="badge ' + (s.enabled !== false ? 'ready' : 'neutral') + '">' + (s.enabled !== false ? 'on' : 'off') + '</span>'
            + '<div style="flex:1"><b>' + esc(s.name) + '</b>' + (s.description ? '<div class="muted" style="font-size:12px">' + esc(s.description) + '</div>' : '') + '</div>'
            + '<button class="ghost small toggle-skill" data-id="' + esc(s.id) + '" data-next="' + (s.enabled !== false ? '0' : '1') + '">' + (s.enabled !== false ? 'disable' : 'enable') + '</button>'
            + '<button class="ghost small del-skill" data-id="' + esc(s.id) + '">delete</button></div>';
        }).join('') + '</div>'
        : '<div class="card empty">No skills installed yet.</div>')
      + '<div class="card"><label class="field"><span>Paste a SKILL.md (frontmatter optional)</span><textarea id="skill-md" style="min-height:120px" placeholder="---&#10;name: my-skill&#10;description: when to use it&#10;---&#10;instructions…"></textarea></label>'
      + '<button id="add-skill">Install skill</button></div>'
      // tools
      + '<h2>Tool plugins <span class="muted" style="font-size:12px;font-weight:400">(HTTP endpoints the mascot can call mid-chat, max 8)</span></h2>'
      + (cap.tools.length
        ? '<div class="card">' + cap.tools.map(function (t) {
          return '<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">'
            + '<span class="badge neutral">' + esc(t.method || 'POST') + '</span>'
            + '<div style="flex:1"><b class="mono">' + esc(t.name) + '</b> <span class="muted" style="font-size:12px">' + esc(t.description) + '</span><div class="muted mono" style="font-size:11px">' + esc(t.url) + '</div></div>'
            + '<button class="ghost small del-tool" data-id="' + esc(t.id) + '">delete</button></div>';
        }).join('') + '</div>'
        : '<div class="card empty">No tool plugins yet.</div>')
      + '<div class="card"><div class="grid cols-2">'
      + '<label class="field"><span>Name (snake_case)</span><input type="text" id="tool-name" placeholder="get_order_status"/></label>'
      + '<label class="field"><span>Endpoint URL</span><input type="url" id="tool-url" placeholder="https://your-api.com/tools/status"/></label>'
      + '<label class="field"><span>Method</span><select id="tool-method"><option>POST</option><option>GET</option></select></label>'
      + '<label class="field"><span>When should the mascot use it?</span><input type="text" id="tool-desc" placeholder="When a user asks about their order status"/></label>'
      + '</div><button id="add-tool">Register tool</button></div>'
      // hooks
      + '<h2>Hooks <span class="muted" style="font-size:12px;font-weight:400">(HMAC-signed webhooks, max 8)</span></h2>'
      + (cap.hooks.length
        ? '<div class="card">' + cap.hooks.map(function (h) {
          var last = h.lastDelivery
            ? ('<div class="muted mono" style="font-size:11px">last: ' + esc(h.lastDelivery.at) + ' → ' + (h.lastDelivery.ok ? '✓ ' + h.lastDelivery.status : '✗ ' + (h.lastDelivery.error || h.lastDelivery.status)) + '</div>')
            : '';
          return '<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">'
            + '<span class="badge neutral">' + esc(h.event) + '</span>'
            + '<div style="flex:1"><span class="mono" style="font-size:12px">' + esc(h.url) + '</span>' + last + '</div>'
            + '<button class="ghost small test-hook" data-id="' + esc(h.id) + '">test</button> '
            + '<button class="ghost small del-hook" data-id="' + esc(h.id) + '">delete</button></div>';
        }).join('') + '</div>'
        : '<div class="card empty">No hooks yet.</div>')
      + '<div class="card"><div class="grid cols-3">'
      + '<label class="field"><span>Event</span><select id="hook-event"><option>message</option><option>escalation</option><option>feedback</option></select></label>'
      + '<label class="field"><span>URL</span><input type="url" id="hook-url" placeholder="https://yourserver.com/hooks/mascotly"/></label>'
      + '<label class="field"><span>Secret (optional)</span><input type="text" id="hook-secret" placeholder="auto-generated if empty"/></label>'
      + '</div><button id="add-hook">Register hook</button>'
      + '<p class="muted" style="margin-top:10px;font-size:12px">Deliveries are signed with <span class="mono">x-mascot-signature: sha256=HMAC(secret, body)</span>.</p></div>';
  }

  function bindCapabilitiesEvents(app) {
    function refresh() { renderAppPage(); }
    var addSkill = document.getElementById('add-skill');
    if (addSkill) addSkill.onclick = async function () {
      var content = document.getElementById('skill-md').value;
      if (!content.trim()) return toast('SKILL.md content required');
      try { await api('POST', '/apps/' + app.id + '/skills', { content: content }); toast('Skill installed ✓'); refresh(); }
      catch (e) { toast(e.message); }
    };
    document.querySelectorAll('.toggle-skill').forEach(function (btn) {
      btn.onclick = async function () {
        try { await api('PATCH', '/apps/' + app.id + '/skills/' + btn.dataset.id, { enabled: btn.dataset.next === '1' }); renderAppPage(); }
        catch (e) { toast(e.message); }
      };
    });
    document.querySelectorAll('.del-skill').forEach(function (btn) {
      btn.onclick = async function () {
        try { await api('DELETE', '/apps/' + app.id + '/skills/' + btn.dataset.id); toast('Skill removed'); refresh(); }
        catch (e) { toast(e.message); }
      };
    });

    var addTool = document.getElementById('add-tool');
    if (addTool) addTool.onclick = async function () {
      try {
        await api('POST', '/apps/' + app.id + '/tools', {
          name: document.getElementById('tool-name').value.trim(),
          url: document.getElementById('tool-url').value.trim(),
          method: document.getElementById('tool-method').value,
          description: document.getElementById('tool-desc').value.trim(),
        });
        toast('Tool registered ✓'); refresh();
      } catch (e) { toast(e.message); }
    };
    document.querySelectorAll('.del-tool').forEach(function (btn) {
      btn.onclick = async function () {
        try { await api('DELETE', '/apps/' + app.id + '/tools/' + btn.dataset.id); toast('Tool removed'); refresh(); }
        catch (e) { toast(e.message); }
      };
    });

    var addHook = document.getElementById('add-hook');
    if (addHook) addHook.onclick = async function () {
      try {
        await api('POST', '/apps/' + app.id + '/hooks', {
          event: document.getElementById('hook-event').value,
          url: document.getElementById('hook-url').value.trim(),
          secret: document.getElementById('hook-secret').value.trim() || undefined,
        });
        toast('Hook registered ✓'); refresh();
      } catch (e) { toast(e.message); }
    };
    document.querySelectorAll('.del-hook').forEach(function (btn) {
      btn.onclick = async function () {
        try { await api('DELETE', '/apps/' + app.id + '/hooks/' + btn.dataset.id); toast('Hook removed'); refresh(); }
        catch (e) { toast(e.message); }
      };
    });
    document.querySelectorAll('.test-hook').forEach(function (btn) {
      btn.onclick = async function () {
        try {
          await api('POST', '/apps/' + app.id + '/hooks/' + btn.dataset.id + '/test');
          toast('Test fired — check the last-delivery line in a moment');
          setTimeout(refresh, 1200);
        } catch (e) { toast(e.message); }
      };
    });
  }

  // ---- tab: REA ----
  function tabRea(app) {
    var s = state.reaStatus || {};
    var insights = (state.profile && state.profile.reaInsights) || null;
    return ''
      + '<div class="card">'
      + '  <h3>REA — Reverse Engineer Anything <a class="muted" style="font-size:12px" href="https://github.com/morluto/rea" target="_blank" rel="noopener">github.com/morluto/rea ↗</a></h3>'
      + '  <p class="muted">Analyze shipped artifacts of your app — Electron bundles, ASAR archives, JavaScript trees — locally, and fold the findings into this mascot\'s knowledge. Uses the <span class="mono">rea-agents</span> CLI: install globally with <span class="mono">npm i -g rea-agents</span>, or leave it to npx on demand.</p>'
      + '  <p>CLI status: <span class="badge ' + (s.mode === 'rea' ? 'ready' : s.mode === 'npx' ? 'amber' : 'neutral') + '">' + esc(s.mode || 'unknown') + '</span>'
      + (s.version ? ' <span class="muted mono">' + esc(s.version) + '</span>' : '')
      + (s.note ? ' <span class="muted">' + esc(s.note) + '</span>' : '') + '</p>'
      + '  <label class="field"><span>Target (absolute path on the Mascotly server)</span><input type="text" id="rea-target" placeholder="C:\\apps\\myapp\\resources\\app.asar  or  /opt/myapp/dist"/></label>'
      + '  <label class="field"><span>Kind</span><select id="rea-kind">'
      + '    <option value="javascript">javascript (JS tree / Electron app dir)</option>'
      + '    <option value="asar">asar (ASAR archive)</option>'
      + '  </select></label>'
      + '  <button id="rea-go">🔬 Run REA analysis</button>'
      + '  <div id="rea-job" style="margin-top:14px"></div>'
      + '</div>'
      + (insights
        ? '<h2>Latest insights</h2><div class="card">'
          + '<p class="muted mono">target: ' + esc(insights.target || '') + ' · mode: ' + esc(insights.mode || '') + ' · ' + esc(insights.analyzedAt || '') + '</p>'
          + Object.keys(insights).filter(function (key) { return Array.isArray(insights[key]) && insights[key].length; }).map(function (key) {
            return '<h3>' + esc(key) + ' (' + insights[key].length + ')</h3><ul style="columns:2">' + insights[key].slice(0, 40).map(function (item) { return '<li class="mono" style="font-size:12px">' + esc(item) + '</li>'; }).join('') + '</ul>';
          }).join('')
          + '</div>'
        : '<h2>Latest insights</h2><div class="card empty">No REA analysis has been run for this app yet.</div>');
  }

  function bindReaEvents(app) {
    document.getElementById('rea-go').onclick = async function () {
      var target = document.getElementById('rea-target').value.trim();
      if (!target) return toast('Target path required');
      try {
        var res = await api('POST', '/apps/' + app.id + '/rea', { target: target, kind: document.getElementById('rea-kind').value });
        var jobBox = document.getElementById('rea-job');
        jobBox.innerHTML = '<div class="progress"><div style="width:2%"></div></div><div class="muted" style="margin-top:6px">REA is analyzing… this can take a while.</div>';
        pollJob(app.id, res.jobId, function (job) {
          if (job.status === 'done') {
            jobBox.innerHTML = '<span class="badge ready">done</span> <span class="muted">' + esc(JSON.stringify(job.result.insights || {})) + '</span>';
            toast('REA analysis complete ✓');
            setTimeout(renderAppPage, 800);
          } else {
            jobBox.innerHTML = '<span class="badge failed">failed</span> <div class="muted">' + esc(job.error || '') + '</div>';
          }
        });
      } catch (e) { toast(e.message); }
    };
  }

  // ---- tab: chat ----
  function tabChat(app) {
    return ''
      + '<div class="card tight"><p class="muted" style="margin:0">Live test chat — talks to the real pipeline (retrieval + brain + actions). Host action events are printed below.</p></div>'
      + '<div class="chat-box">'
      + '  <div class="chat-msgs" id="chat-msgs"></div>'
      + '  <div class="chat-input-row">'
      + '    <textarea id="chat-input" placeholder="Type a message… (Enter to send)"></textarea>'
      + '    <button id="chat-send">Send</button>'
      + '  </div>'
      + '</div>'
      + '<div class="card" style="margin-top:14px"><b>Events</b><div id="chat-events" class="mono muted" style="margin-top:8px;max-height:150px;overflow-y:auto">—</div></div>';
  }

  function bindChatEvents(app) {
    var msgs = document.getElementById('chat-msgs');
    var input = document.getElementById('chat-input');
    var sendBtn = document.getElementById('chat-send');
    var eventsBox = document.getElementById('chat-events');
    var sessionId = null;

    function addMsg(cls, text) {
      var d = document.createElement('div');
      d.className = 'chat-msg ' + cls;
      d.textContent = text;
      msgs.appendChild(d);
      msgs.scrollTop = msgs.scrollHeight;
      return d;
    }

    function logEvent(line) {
      eventsBox.textContent = (eventsBox.textContent === '—' ? '' : eventsBox.textContent) + line + '\n';
      eventsBox.scrollTop = eventsBox.scrollHeight;
    }

    async function sendChat() {
      var text = input.value.trim();
      if (!text || state.chat.busy) return;
      var myChat = state.chat; // capture: navigation may replace state.chat mid-stream
      myChat.busy = true;
      sendBtn.disabled = true;
      input.value = '';
      addMsg('user', text);
      var botMsg = addMsg('bot', '…');
      try {
        var res = await fetch('/api/v1/stream/' + encodeURIComponent(app.id) + '/' + encodeURIComponent(app.publicKey), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: text, sessionId: sessionId, page: { url: 'dashboard-test', title: 'Dashboard test chat' } }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';
        var acc = '';
        for (;;) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            var rawEvent = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            var event = null;
            var dataLines = [];
            rawEvent.split('\n').forEach(function (line) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
            });
            if (!event || !dataLines.length) continue;
            var data;
            try { data = JSON.parse(dataLines.join('\n')); } catch (e) { continue; }
            if (event === 'delta') {
              acc += data.text || '';
              botMsg.textContent = acc;
              msgs.scrollTop = msgs.scrollHeight;
            } else if (event === 'status') {
              logEvent('status: ' + (data.detail || ''));
            } else if (event === 'action') {
              logEvent('action: ' + JSON.stringify(data));
              botMsg.textContent = acc + '\n\n⚡ action: ' + (data.name || '');
            } else if (event === 'done') {
              sessionId = data.sessionId || sessionId;
              botMsg.textContent = data.answer || acc;
              if (data.citations && data.citations.length) {
                logEvent('citations: ' + data.citations.map(function (c) { return '[' + c.n + '] ' + c.label; }).join(', '));
              }
              logEvent('usage: ' + JSON.stringify(data.usage || {}));
            } else if (event === 'error') {
              botMsg.className = 'chat-msg err';
              botMsg.textContent = data.message || 'error';
            }
          }
        }
        if (!acc) { botMsg.textContent = botMsg.textContent === '…' ? '(no response)' : botMsg.textContent; }
      } catch (e) {
        botMsg.className = 'chat-msg err';
        botMsg.textContent = 'Failed: ' + e.message;
      } finally {
        myChat.busy = false;
        sendBtn.disabled = false;
        input.focus();
      }
    }

    sendBtn.onclick = sendChat;
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
  }

  // ---- tab: sessions ----
  function tabSessions(app) {
    var rows = state.sessions.map(function (s) {
      return '<tr>'
        + '<td class="mono" style="font-size:12px">' + esc(s.id.slice(0, 18)) + '…</td>'
        + '<td>' + (s.escalated ? '<span class="badge escalated">escalated</span> ' : '') + esc((s.preview || '').slice(0, 80)) + '</td>'
        + '<td class="mono">' + s.messageCount + '</td>'
        + '<td class="muted">' + esc(timeAgo(s.updatedAt)) + '</td>'
        + '<td style="text-align:right;white-space:nowrap">'
        + '<button class="ghost small view-session" data-id="' + esc(s.id) + '">view</button> '
        + '<button class="ghost small del-session" data-id="' + esc(s.id) + '">delete</button>'
        + '</td></tr>';
    }).join('');
    return ''
      + (rows
        ? '<div class="card"><table><thead><tr><th>session</th><th>preview</th><th>msgs</th><th>updated</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="card empty">No conversations yet. Try the chat tab.</div>')
      + '<div id="session-detail"></div>';
  }

  function bindSessionsEvents(app) {
    document.querySelectorAll('.del-session').forEach(function (btn) {
      btn.onclick = async function () {
        try {
          await api('DELETE', '/apps/' + app.id + '/sessions/' + btn.dataset.id);
          toast('Session deleted');
          renderAppPage();
        } catch (e) { toast(e.message); }
      };
    });
    document.querySelectorAll('.view-session').forEach(function (btn) {
      btn.onclick = async function () {
        try {
          var res = await api('GET', '/apps/' + app.id + '/sessions/' + btn.dataset.id);
          var s = res.session;
          var detail = document.getElementById('session-detail');
          detail.innerHTML = '<h2>Transcript</h2><div class="card">'
            + '<div class="muted mono" style="font-size:11.5px">' + esc(s.id) + ' · started ' + esc(s.createdAt) + (s.feedback ? ' · feedback: ' + esc(s.feedback.rating || '') + (s.feedback.comment ? ' "' + esc(s.feedback.comment) + '"' : '') : '') + '</div>'
            + s.messages.map(function (m) {
              var citeLine = m.citations && m.citations.length ? '<div class="muted mono" style="font-size:11px;margin-top:4px">cites: ' + m.citations.map(function (c) { return '[' + c.n + '] ' + esc(c.label); }).join(', ') + '</div>' : '';
              return '<div style="margin:10px 0;padding:8px 12px;background:var(--bg-3);border-radius:9px"><b>' + (m.role === 'user' ? '👤 user' : m.role === 'assistant' ? esc(app.mascot.emoji) + ' mascot' : esc(m.role)) + '</b> <span class="muted" style="font-size:11px">' + esc(m.at || '') + '</span><div style="white-space:pre-wrap;margin-top:4px">' + esc(m.content) + '</div>' + citeLine + '</div>';
            }).join('')
            + '</div>';
          detail.scrollIntoView({ behavior: 'smooth' });
        } catch (e) { toast(e.message); }
      };
    });
  }

  // ---- tab: settings ----
  function tabSettings(app) {
    var s = app.settings || {};
    var model = s.model || {};
    var emb = s.embeddings || {};
    return ''
      + '<div class="card">'
      + '  <h3>App</h3>'
      + '  <label class="field"><span>Name</span><input type="text" id="s-name" value="' + esc(app.name) + '"/></label>'
      + '  <label class="field"><span>Description (shown to the mascot as "what the host app is")</span><textarea id="s-desc">' + esc(app.description) + '</textarea></label>'
      + '  <button id="s-save-app">Save</button>'
      + '</div>'
      + '<div class="card">'
      + '  <h3>Behavior</h3>'
      + '  <div class="grid cols-2">'
      + '    <label class="field"><span>Rate limit (msgs/min per user)</span><input type="number" id="s-rate" value="' + esc(s.rateLimitPerMin) + '" min="1" max="240"/></label>'
      + '    <label class="field"><span>Allowed origins (one per line; empty = anywhere)</span><textarea id="s-origins">' + esc((s.allowedOrigins || []).join('\n')) + '</textarea></label>'
      + '    <label class="field"><span>Escalation keywords (comma-separated)</span><input type="text" id="s-esc" value="' + esc((s.escalationKeywords || []).join(', ')) + '"/></label>'
      + '    <label class="check" style="margin-top:26px"><input type="checkbox" id="s-auto" ' + (s.autoAnalyze ? 'checked' : '') + '/> auto-run analyzer after first source</label>'
      + '  </div>'
      + '  <label class="field"><span>Extra system prompt (highest-priority instructions for the mascot)</span><textarea id="s-extra">' + esc(s.systemPromptExtra || '') + '</textarea></label>'
      + '  <button id="s-save-behavior">Save behavior</button>'
      + '</div>'
      + '<div class="card">'
      + '  <h3>Model override (per app)</h3>'
      + '  <p class="muted">Overrides the server default for this app only.</p>'
      + '  <div class="grid cols-2">'
      + '    <label class="field"><span>Provider</span><select id="s-provider">'
      + ['auto', 'none', 'openai-compatible', 'anthropic', 'ollama', 'mock'].map(function (p) {
        return '<option value="' + p + '" ' + ((model.provider || 'auto') === p ? 'selected' : '') + '>' + p + '</option>';
      }).join('')
      + '    </select></label>'
      + '    <label class="field"><span>Model</span><input type="text" id="s-model" value="' + esc(model.model || '') + '" placeholder="gpt-4o-mini"/></label>'
      + '    <label class="field"><span>Base URL (OpenAI-compatible)</span><input type="text" id="s-baseurl" value="' + esc(model.baseUrl || '') + '" placeholder="https://api.openai.com/v1"/></label>'
      + '    <label class="field"><span>API key</span><input type="password" id="s-apikey" value="' + esc(model.apiKey || '') + '" placeholder="sk-…"/></label>'
      + '  </div>'
      + '  <button id="s-save-model">Save model override</button>'
      + '</div>'
      + '<div class="card">'
      + '  <h3>Embeddings override (per app)</h3>'
      + '  <div class="grid cols-3">'
      + '    <label class="field"><span>Provider</span><select id="e-provider">'
      + ['none', 'openai-compatible', 'ollama'].map(function (p) {
        return '<option value="' + p + '" ' + ((emb.provider || 'none') === p ? 'selected' : '') + '>' + p + '</option>';
      }).join('')
      + '    </select></label>'
      + '    <label class="field"><span>Model</span><input type="text" id="e-model" value="' + esc(emb.model || '') + '"/></label>'
      + '    <label class="field"><span>API key</span><input type="password" id="e-apikey" value="' + esc(emb.apiKey || '') + '"/></label>'
      + '  </div>'
      + '  <p class="muted">Changing embeddings requires re-ingesting sources to add vectors.</p>'
      + '  <button id="s-save-emb">Save embeddings</button>'
      + '</div>'
      + '<div class="card">'
      + '  <h3>Keys</h3>'
      + '  <p class="mono">publicKey: ' + esc(app.publicKey) + ' <button class="ghost small" id="copy-pk">copy</button></p>'
      + '  <p class="mono">secretKey: ' + esc(app.secretKey) + ' <button class="ghost small" id="copy-sk">copy</button></p>'
      + '  <button class="secondary" id="rotate-keys">🔄 Rotate keys</button>'
      + '</div>'
      + '<div class="card" style="border-color:#5b2333">'
      + '  <h3 style="color:#f1948a">Danger zone</h3>'
      + '  <button class="danger" id="delete-app">Delete this app permanently</button>'
      + '</div>';
  }

  function bindSettingsEvents(app) {
    document.getElementById('s-save-app').onclick = async function () {
      try {
        await api('PATCH', '/apps/' + app.id, {
          name: document.getElementById('s-name').value.trim(),
          description: document.getElementById('s-desc').value,
        });
        toast('Saved ✓');
        renderAppPage();
      } catch (e) { toast(e.message); }
    };
    document.getElementById('s-save-behavior').onclick = async function () {
      try {
        await api('PATCH', '/apps/' + app.id, {
          settings: {
            rateLimitPerMin: parseInt(document.getElementById('s-rate').value, 10) || 20,
            allowedOrigins: document.getElementById('s-origins').value.split('\n').map(function (s2) { return s2.trim(); }).filter(Boolean),
            escalationKeywords: document.getElementById('s-esc').value.split(',').map(function (s2) { return s2.trim(); }).filter(Boolean),
            autoAnalyze: document.getElementById('s-auto').checked,
            systemPromptExtra: document.getElementById('s-extra').value,
          },
        });
        toast('Behavior saved ✓');
      } catch (e) { toast(e.message); }
    };
    document.getElementById('s-save-model').onclick = async function () {
      try {
        await api('PATCH', '/apps/' + app.id, {
          settings: {
            model: {
              provider: document.getElementById('s-provider').value,
              model: document.getElementById('s-model').value.trim(),
              baseUrl: document.getElementById('s-baseurl').value.trim(),
              apiKey: document.getElementById('s-apikey').value.trim(),
            },
          },
        });
        toast('Model override saved ✓');
      } catch (e) { toast(e.message); }
    };
    document.getElementById('s-save-emb').onclick = async function () {
      try {
        await api('PATCH', '/apps/' + app.id, {
          settings: {
            embeddings: {
              provider: document.getElementById('e-provider').value,
              model: document.getElementById('e-model').value.trim(),
              apiKey: document.getElementById('e-apikey').value.trim(),
            },
          },
        });
        toast('Embeddings saved ✓');
      } catch (e) { toast(e.message); }
    };
    document.getElementById('copy-pk').onclick = function () { copyText(app.publicKey); };
    document.getElementById('copy-sk').onclick = function () { copyText(app.secretKey); };
    document.getElementById('rotate-keys').onclick = async function () {
      if (!confirm('Rotate keys? Existing embeds stop working until you update the snippet.')) return;
      try {
        await api('POST', '/apps/' + app.id + '/keys/rotate');
        toast('Keys rotated ✓');
        renderAppPage();
      } catch (e) { toast(e.message); }
    };
    document.getElementById('delete-app').onclick = async function () {
      if (!confirm('Delete app "' + app.name + '" and ALL its knowledge, sessions and settings? This cannot be undone.')) return;
      try {
        await api('DELETE', '/apps/' + app.id);
        toast('App deleted');
        nav('#/apps');
      } catch (e) { toast(e.message); }
    };
  }

  // ------------------------------------------------------------ boot

  async function render() {
    if (!state.key) return renderLogin();
    var r = state.route;
    if (r.page === 'forge') return renderForge();
    if (r.page === 'create') return renderCreate();
    if (r.page === 'app' && r.appId) return renderAppPage();
    return renderApps();
  }

  state.route = parseHash();
  render();
})();

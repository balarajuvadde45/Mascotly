/*!
 * Mascotly Widget — the embeddable AI mascot for any application.
 * Zero dependencies. Web Component + Shadow DOM. Works in React/Vue/Angular/Svelte/plain HTML.
 *
 * Usage:
 *   <script src="https://your-mascot-host/widget/mascot-widget.js"></script>
 *   <script>
 *     window.Mascotly.init({
 *       server: 'https://your-mascot-host',
 *       appId: 'app_xxx',
 *       publicKey: 'pk_xxx',
 *     });
 *   </script>
 *
 * Host actions:
 *   window.Mascotly.registerAction('navigate', (args) => { location.href = args.url; });
 * Events:
 *   window.Mascotly.on('open'|'close'|'message'|'action'|'error', (payload) => {})
 */
(function () {
  'use strict';

  if (window.Mascotly) return; // single instance guard

  // ---------------------------------------------------------------- utilities

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function sanitizeUrl(url) {
    const u = String(url || '').trim();
    if (/^(https?:|mailto:)/i.test(u)) return u;
    if (u.startsWith('/') || u.startsWith('#') || u.startsWith('./')) return u;
    return null;
  }

  /** Tiny safe markdown renderer: escape first, then transform. */
  function renderMarkdown(src) {
    var escaped = escapeHtml(src);
    var fenced = [];
    // Per-call sentinels: model/host text can never collide with them.
    var fenceSentinel = '\u0000CB' + Math.random().toString(36).slice(2, 8) + '-';
    var codeSentinel = '\u0000IC' + Math.random().toString(36).slice(2, 8) + '-';

    // Fenced code blocks first.
    var text = escaped.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, function (_, lang, code) {
      fenced.push({ lang: lang, code: code.replace(/\n$/, '') });
      return '\u0000' + fenceSentinel.slice(1) + (fenced.length - 1) + '\u0000';
    });

    // Inline code spans next (stashed so bold/em/link transforms skip them).
    var inline = [];
    text = text.replace(/`([^`\n]+)`/g, function (_, code) {
      inline.push(code);
      return '\u0000' + codeSentinel.slice(1) + (inline.length - 1) + '\u0000';
    });

    // Inline constructs.
    text = text
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?$]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?$]|$)/g, '$1<em>$2</em>');

    // Links [text](url)
    text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (_, label, url) {
      const safe = sanitizeUrl(url.replace(/&amp;/g, '&'));
      if (!safe) return label;
      const ext = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener noreferrer"' : '';
      return '<a href="' + escapeHtml(safe) + '"' + ext + '>' + label + '</a>';
    });

    // Auto-link bare URLs.
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (_, pre, url) {
      return pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    });

    // Restore inline code before block processing.
    text = text.replace(new RegExp('\u0000' + codeSentinel.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)\u0000', 'g'), function (_, i) {
      return '<code>' + inline[parseInt(i, 10)] + '</code>';
    });

    // Block-level: headings, lists, blockquotes, paragraphs.
    var fenceTokenRe = /^\u0000CB[a-z0-9]+-(\d+)\u0000$/;
    var lines = text.split('\n');
    const out = [];
    let list = null; // 'ul' | 'ol'

    function closeList() {
      if (list) { out.push('</' + list + '>'); list = null; }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const cb = line.match(fenceTokenRe);
      if (cb && fenced[parseInt(cb[1], 10)] !== undefined) {
        closeList();
        const block = fenced[parseInt(cb[1], 10)];
        out.push('<pre><code>' + block.code + '</code></pre>');
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        closeList();
        const level = Math.min(h[1].length + 2, 6);
        out.push('<h' + level + '>' + h[2] + '</h' + level + '>');
        continue;
      }
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
      if (ul) {
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + ul[1] + '</li>');
        continue;
      }
      if (ol) {
        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + ol[2] + '</li>');
        continue;
      }
      const bq = line.match(/^&gt;\s?(.*)$/);
      if (bq) {
        closeList();
        out.push('<blockquote>' + bq[1] + '</blockquote>');
        continue;
      }
      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
      if (line.trim() === '') { closeList(); continue; }
      closeList();
      out.push('<p>' + line + '</p>');
    }
    closeList();
    return out.join('');
  }

  function uuid() {
    try { return crypto.randomUUID(); } catch (e) {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
  }

  // ---------------------------------------------------------------- config

  var scriptEl = document.currentScript
    || (function () { var s = document.querySelectorAll('script[src*="mascot-widget"]'); return s[s.length - 1]; })();

  function dataAttr(name, fallback) {
    if (scriptEl && scriptEl.getAttribute('data-' + name)) return scriptEl.getAttribute('data-' + name);
    return fallback;
  }

  var config = {
    server: dataAttr('server', '') || (function () {
      if (scriptEl && scriptEl.src) {
        try { return new URL(scriptEl.src).origin; } catch (e) { /* noop */ }
      }
      return window.location.origin;
    })(),
    appId: dataAttr('app-id', ''),
    publicKey: dataAttr('public-key', ''),
    position: dataAttr('position', ''),
    color: dataAttr('color', ''),
    greeting: dataAttr('greeting', ''),
    welcome: dataAttr('welcome', 'true') !== 'false',
    teaserDelay: parseInt(dataAttr('teaser-delay', '12000'), 10),
    zIndex: parseInt(dataAttr('z-index', '2147483000'), 10),
    open: dataAttr('open', '') === 'true',
  };

  var listeners = { open: [], close: [], message: [], action: [], error: [] };
  var actionHandlers = {};
  var remoteConfig = null;
  var sessionId = null;
  var initialized = false;
  var busy = false;

  function emit(event, payload) {
    (listeners[event] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('[mascot] listener error:', e); }
    });
  }

  // ---------------------------------------------------------------- styles

  var CSS = ''
    + ':host{all:initial;}'
    + '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}'
    + ':host{position:fixed;z-index:var(--mz-z);' + 'bottom:20px;right:20px;}'
    + '.mz-root{position:relative;display:block;}'
    // bubble
    + '.mz-bubble{width:60px;height:60px;border-radius:50%;display:flex;align-items:center;justify-content:center;'
    + 'font-size:28px;cursor:pointer;border:none;box-shadow:0 4px 18px rgba(0,0,0,.22);transition:transform .15s ease,box-shadow .15s ease;'
    + 'background:var(--mz-accent);color:#fff;user-select:none;}'
    + '.mz-bubble:hover{transform:scale(1.06);box-shadow:0 6px 24px rgba(0,0,0,.3);}'
    + '.mz-bubble img{width:40px;height:40px;border-radius:50%;object-fit:cover;}'
    + '.mz-bubble .mz-close{display:none;font-size:22px;font-family:monospace;}'
    // teaser
    + '.mz-teaser{position:absolute;bottom:70px;right:0;max-width:230px;background:#fff;color:#1a1a2e;border-radius:14px;'
    + 'padding:10px 14px;font-size:13px;line-height:1.45;box-shadow:0 4px 20px rgba(0,0,0,.18);cursor:pointer;opacity:0;'
    + 'transform:translateY(6px);transition:opacity .25s,transform .25s;pointer-events:none;border:1px solid #ececf4;}'
    + '.mz-teaser.mz-show{opacity:1;transform:none;pointer-events:auto;}'
    + '.mz-teaser:after{content:"";position:absolute;bottom:-7px;right:22px;width:12px;height:12px;background:#fff;'
    + 'border-right:1px solid #ececf4;border-bottom:1px solid #ececf4;transform:rotate(45deg);}'
    // panel
    + '.mz-panel{position:absolute;bottom:84px;right:0;width:376px;max-width:calc(100vw - 32px);height:560px;'
    + 'max-height:calc(100vh - 120px);background:#fff;border-radius:18px;box-shadow:0 12px 48px rgba(10,10,40,.25);'
    + 'display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(14px) scale(.98);'
    + 'pointer-events:none;visibility:hidden;transition:opacity .18s ease,transform .18s ease,visibility 0s linear .18s;}'
    + '.mz-panel.mz-open{opacity:1;transform:none;pointer-events:auto;visibility:visible;transition-delay:0s;}'
    + '.mz-head{display:flex;align-items:center;gap:10px;padding:14px 16px;background:var(--mz-accent);color:#fff;flex:0 0 auto;}'
    + '.mz-head img{width:36px;height:36px;border-radius:50%;object-fit:cover;}'
    + '.mz-head-avatar{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.25);display:flex;align-items:center;justify-content:center;font-size:20px;}'
    + '.mz-head-info{flex:1;min-width:0;}'
    + '.mz-head-name{font-weight:700;font-size:15px;line-height:1.2;}'
    + '.mz-head-tag{font-size:12px;opacity:.85;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.mz-head button{background:rgba(255,255,255,.18);border:none;color:#fff;width:30px;height:30px;border-radius:8px;'
    + 'cursor:pointer;font-size:16px;line-height:1;display:flex;align-items:center;justify-content:center;}'
    + '.mz-head button:hover{background:rgba(255,255,255,.3);}'
    // messages
    + '.mz-msgs{flex:1;overflow-y:auto;padding:14px;background:#f6f6fb;display:flex;flex-direction:column;gap:10px;}'
    + '.mz-msgs::-webkit-scrollbar{width:6px;}'
    + '.mz-msgs::-webkit-scrollbar-thumb{background:#d4d4e0;border-radius:3px;}'
    + '.mz-msg{max-width:86%;padding:9px 13px;border-radius:14px;font-size:14px;line-height:1.5;word-wrap:break-word;overflow-wrap:break-word;}'
    + '.mz-msg.bot{background:#fff;color:#1a1a2e;border:1px solid #e8e8f2;border-bottom-left-radius:4px;align-self:flex-start;}'
    + '.mz-msg.user{background:var(--mz-accent);color:#fff;border-bottom-right-radius:4px;align-self:flex-end;}'
    + '.mz-msg.bot p{margin:0 0 8px;} .mz-msg.bot p:last-child{margin-bottom:0;}'
    + '.mz-msg.bot ul,.mz-msg.bot ol{margin:6px 0;padding-left:20px;}'
    + '.mz-msg.bot li{margin:2px 0;}'
    + '.mz-msg.bot h3,.mz-msg.bot h4{margin:8px 0 4px;font-size:14px;}'
    + '.mz-msg.bot blockquote{margin:6px 0;padding:2px 10px;border-left:3px solid var(--mz-accent);color:#555;}'
    + '.mz-msg.bot pre{background:#14141f;color:#e6e6f0;padding:10px;border-radius:8px;overflow-x:auto;font-size:12.5px;margin:6px 0;}'
    + '.mz-msg.bot code{background:rgba(108,92,231,.12);padding:1px 5px;border-radius:4px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}'
    + '.mz-msg.bot pre code{background:none;padding:0;color:inherit;}'
    + '.mz-msg.bot a{color:var(--mz-accent);font-weight:600;}'
    + '.mz-msg hr{border:none;border-top:1px solid #e4e4ee;margin:8px 0;}'
    + '.mz-citations{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;}'
    + '.mz-citation{font-size:11px;background:#f0eefc;color:#4a3f8f;border:1px solid #ddd8f5;border-radius:999px;'
    + 'padding:2px 9px;text-decoration:none;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.mz-citation:hover{background:#e6e2fa;}'
    // typing
    + '.mz-typing{display:flex;gap:5px;padding:12px 14px;background:#fff;border:1px solid #e8e8f2;border-radius:14px;'
    + 'border-bottom-left-radius:4px;align-self:flex-start;}'
    + '.mz-typing span{width:7px;height:7px;border-radius:50%;background:#b9b3d6;animation:mzBlink 1.2s infinite;}'
    + '.mz-typing span:nth-child(2){animation-delay:.2s;}'
    + '.mz-typing span:nth-child(3){animation-delay:.4s;}'
    + '@keyframes mzBlink{0%,80%,100%{opacity:.25;transform:scale(.9);}40%{opacity:1;transform:scale(1.05);}}'
    // status pill
    + '.mz-status{font-size:11px;color:#8a85a3;align-self:center;padding:2px 10px;background:#ececf4;border-radius:999px;}'
    // suggestions
    + '.mz-suggestions{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px;background:#f6f6fb;}'
    + '.mz-suggestion{font-size:12px;border:1px solid #ddd8f0;background:#fff;color:#4a3f8f;border-radius:999px;'
    + 'padding:5px 11px;cursor:pointer;transition:background .12s;}'
    + '.mz-suggestion:hover{background:#efeafc;}'
    // input
    + '.mz-input-row{display:flex;gap:8px;padding:12px;border-top:1px solid #e8e8f2;background:#fff;flex:0 0 auto;}'
    + '.mz-input{flex:1;border:1px solid #ddd;border-radius:12px;padding:10px 13px;font-size:14px;resize:none;'
    + 'outline:none;max-height:110px;min-height:42px;background:#f8f8fc;color:#1a1a2e;}'
    + '.mz-input:focus{border-color:var(--mz-accent);background:#fff;}'
    + '.mz-send{border:none;background:var(--mz-accent);color:#fff;width:42px;border-radius:12px;cursor:pointer;'
    + 'font-size:17px;display:flex;align-items:center;justify-content:center;flex:0 0 auto;transition:opacity .15s;}'
    + '.mz-send:disabled{opacity:.45;cursor:default;}'
    // footer
    + '.mz-foot{font-size:10.5px;color:#a0a0b8;text-align:center;padding:6px;background:#fff;flex:0 0 auto;}'
    + '.mz-foot a{color:#8a85c0;text-decoration:none;}'
    // error chip
    + '.mz-msg.err{background:#fff2f2;color:#a33;border:1px solid #f3d3d3;}'
    // mobile
    + '@media (max-width:480px){'
    + '.mz-panel{position:fixed;top:0;left:0;right:0;bottom:0;width:100%;max-width:none;height:100%;max-height:none;border-radius:0;}'
    + '.mz-panel.mz-open{transform:none;}'
    + '}';

  // ---------------------------------------------------------------- element

  var el = {}; // refs into shadow DOM

  class MascotlyElement extends HTMLElement {
    constructor() {
      super();
      var host = this;
      var shadow = host.attachShadow({ mode: 'open' });
      var style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);

      var wrap = document.createElement('div');
      wrap.className = 'mz-root';
      wrap.innerHTML = ''
        + '<button class="mz-bubble" aria-label="Open chat" aria-expanded="false"><span class="mz-emoji">🤖</span><span class="mz-close">✕</span></button>'
        + '<div class="mz-teaser" role="button" tabindex="0"></div>'
        + '<div class="mz-panel" role="dialog" aria-label="Chat with the app mascot" aria-hidden="true">'
        + '  <div class="mz-head">'
        + '    <div class="mz-head-avatar">🤖</div>'
        + '    <div class="mz-head-info"><div class="mz-head-name">Assistant</div><div class="mz-head-tag">AI assistant</div></div>'
        + '    <button class="mz-min" aria-label="Minimize chat">✕</button>'
        + '  </div>'
        + '  <div class="mz-msgs"></div>'
        + '  <div class="mz-suggestions"></div>'
        + '  <div class="mz-input-row">'
        + '    <textarea class="mz-input" rows="1" placeholder="Ask anything…"></textarea>'
        + '    <button class="mz-send" aria-label="Send message">➤</button>'
        + '  </div>'
        + '  <div class="mz-foot">powered by <a href="https://github.com/morluto/mascotly" target="_blank" rel="noopener noreferrer">Mascotly</a></div>'
        + '</div>';
      shadow.appendChild(wrap);

      el = {
        host: host, wrap: wrap,
        bubble: shadow.querySelector('.mz-bubble'),
        bubbleEmoji: shadow.querySelector('.mz-emoji'),
        bubbleClose: shadow.querySelector('.mz-close'),
        teaser: shadow.querySelector('.mz-teaser'),
        panel: shadow.querySelector('.mz-panel'),
        headAvatar: shadow.querySelector('.mz-head-avatar'),
        headName: shadow.querySelector('.mz-head-name'),
        headTag: shadow.querySelector('.mz-head-tag'),
        msgs: shadow.querySelector('.mz-msgs'),
        suggestions: shadow.querySelector('.mz-suggestions'),
        input: shadow.querySelector('.mz-input'),
        send: shadow.querySelector('.mz-send'),
      };
      bindEvents();
    }
  }

  if (!customElements.get('mascot-widget')) {
    customElements.define('mascot-widget', MascotlyElement);
  }
  var hostEl = document.createElement('mascot-widget');

  // ---------------------------------------------------------------- rendering

  function appendMsg(role, html, opts) {
    opts = opts || {};
    var div = document.createElement('div');
    div.className = 'mz-msg ' + (role === 'user' ? 'user' : role === 'err' ? 'err' : 'bot');
    if (role === 'user') { div.textContent = String(html).slice(0, 4000); }
    else { div.innerHTML = html || ''; }
    if (role !== 'user' && Array.isArray(opts.citations) && opts.citations.length) {
      var cites = document.createElement('div');
      cites.className = 'mz-citations';
      opts.citations.forEach(function (c) {
        if (!c.label) return;
        var a = document.createElement('a');
        a.className = 'mz-citation';
        a.textContent = '[' + (c.n || '•') + '] ' + c.label;
        if (c.url && sanitizeUrl(c.url)) { a.href = sanitizeUrl(c.url); a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        a.title = c.heading ? c.label + ' — ' + c.heading : (c.label || '');
        cites.appendChild(a);
      });
      div.appendChild(cites);
    }
    el.msgs.appendChild(div);
    scrollBottom();
    return div;
  }

  function scrollBottom() {
    el.msgs.scrollTop = el.msgs.scrollHeight;
  }

  function showTyping() {
    var t = document.createElement('div');
    t.className = 'mz-typing';
    t.innerHTML = '<span></span><span></span><span></span>';
    el.msgs.appendChild(t);
    scrollBottom();
    return t;
  }

  function showStatus(detail) {
    var s = document.createElement('div');
    s.className = 'mz-status';
    s.textContent = detail === 'searching_knowledge' ? '🔎 checking the docs…' : '✨ thinking…';
    el.msgs.appendChild(s);
    scrollBottom();
    return s;
  }

  function setSuggestions(list) {
    el.suggestions.innerHTML = '';
    (list || []).forEach(function (text) {
      var b = document.createElement('button');
      b.className = 'mz-suggestion';
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', function () { sendMessage(text); });
      el.suggestions.appendChild(b);
    });
    el.suggestions.style.display = (list && list.length) ? 'flex' : 'none';
  }

  // ---------------------------------------------------------------- chat core

  function historyForApi() {
    var msgs = [];
    el.msgs.querySelectorAll('.mz-msg.bot, .mz-msg.user').forEach(function (m) {
      if (m.classList.contains('err')) return;
      msgs.push({
        role: m.classList.contains('user') ? 'user' : 'assistant',
        content: (m.dataset.raw || m.textContent).slice(0, 1500),
      });
    });
    return msgs.slice(-10);
  }

  function pageContext() {
    try {
      return { url: window.location.href.slice(0, 500), title: (document.title || '').slice(0, 200) };
    } catch (e) { return null; }
  }

  async function sendMessage(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    if (!config.appId || !config.publicKey) {
      appendMsg('err', 'Mascotly is not configured: missing appId / publicKey.');
      return;
    }
    busy = true;
    el.send.disabled = true;
    // Snapshot the history BEFORE appending the user's message — the server adds
    // the current message itself, so including it here would duplicate the turn.
    var history = historyForApi();
    appendMsg('user', text);
    el.input.value = '';
    el.input.style.height = 'auto';
    setSuggestions([]);
    var typing = showTyping();
    var statusEl = null;
    var botDiv = null;
    var acc = '';

    try {
      var res = await fetch(config.server + '/api/v1/stream/' + encodeURIComponent(config.appId) + '/' + encodeURIComponent(config.publicKey), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: text,
          sessionId: sessionId,
          history: history,
          page: pageContext(),
        }),
      });
      if (!res.ok || !res.body) {
        var detail = '';
        try { var j = await res.json(); detail = j.message || ''; } catch (e) { detail = 'HTTP ' + res.status; }
        throw new Error(detail || ('HTTP ' + res.status));
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      var donePayload = null;

      var handleEvent = function (event, data) {
        if (event === 'status') {
          typing.remove();
          if (statusEl) statusEl.remove();
          statusEl = showStatus(data.detail || 'thinking');
        } else if (event === 'delta') {
          if (!botDiv) {
            if (statusEl) { statusEl.remove(); statusEl = null; }
            typing.remove();
            botDiv = appendMsg('bot', '');
          }
          acc += data.text || '';
          botDiv.innerHTML = renderMarkdown(acc);
          scrollBottom();
        } else if (event === 'action') {
          dispatchAction(data);
        } else if (event === 'done') {
          donePayload = data;
        } else if (event === 'error') {
          throw new Error(data.message || 'Chat failed');
        }
      };

      // SSE parsing loop.
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
          if (event && dataLines.length) {
            var data;
            try { data = JSON.parse(dataLines.join('\n')); } catch (e) { continue; }
            handleEvent(event, data);
          }
        }
      }

      typing.remove();
      if (statusEl) statusEl.remove();

      if (donePayload) {
        if (!botDiv) {
          if (statusEl) statusEl.remove();
          botDiv = appendMsg('bot', '');
        }
        botDiv.innerHTML = renderMarkdown(donePayload.answer || acc);
        if (Array.isArray(donePayload.citations) && donePayload.citations.length) {
          var cites = document.createElement('div');
          cites.className = 'mz-citations';
          donePayload.citations.forEach(function (c) {
            if (!c.label) return;
            var a = document.createElement('a');
            a.className = 'mz-citation';
            a.textContent = '[' + c.n + '] ' + c.label;
            if (c.url && sanitizeUrl(c.url)) { a.href = sanitizeUrl(c.url); a.target = '_blank'; a.rel = 'noopener noreferrer'; }
            cites.appendChild(a);
          });
          botDiv.appendChild(cites);
        }
        if (donePayload.sessionId) sessionId = donePayload.sessionId;
        if (botDiv) botDiv.dataset.raw = donePayload.answer || acc;
        if (Array.isArray(donePayload.citations) && donePayload.citations.length) {
          emit('message', { role: 'assistant', text: donePayload.answer, citations: donePayload.citations });
        } else {
          emit('message', { role: 'assistant', text: donePayload.answer });
        }
        try { sessionStorage.setItem('mascot_sid_' + config.appId, sessionId || ''); } catch (e) { /* noop */ }
      } else if (!botDiv) {
        appendMsg('err', 'No response received. Is the Mascotly server reachable?');
        emit('error', { message: 'no response' });
      }
    } catch (err) {
      if (reader) { try { reader.cancel(); } catch (e) { /* already closed */ } }
      typing.remove();
      if (statusEl) statusEl.remove();
      if (botDiv && acc) {
        botDiv.innerHTML = renderMarkdown(acc) + '<p><em>(connection interrupted)</em></p>';
      } else {
        appendMsg('err', 'Sorry — I could not reach the Mascotly server. ' + escapeHtml(err.message || ''));
      }
      emit('error', { message: String(err && err.message || err) });
    } finally {
      busy = false;
      el.send.disabled = false;
      el.input.focus();
    }
  }

  function dispatchAction(action) {
    if (!action || !action.name) return;
    emit('action', action);
    var handler = actionHandlers[action.name];
    if (handler) {
      try { handler(action.args || {}); } catch (e) { console.error('[mascot] action handler failed:', e); }
    } else if (action.name === 'escalate') {
      appendMsg('bot', '👋 I\'ve flagged this conversation for the team — a human will follow up.');
    } else {
      console.info('[mascot] No handler registered for action "' + action.name + '". Register one with Mascotly.registerAction().');
    }
  }

  // ---------------------------------------------------------------- ui state

  function applyTheme() {
    var rc = remoteConfig || {};
    var mc = rc.mascot || {};
    var accent = config.color || mc.color || '#6c5ce7';
    hostEl.style.setProperty('--mz-accent', accent);
    hostEl.style.setProperty('--mz-z', String(config.zIndex || 2147483000));
    var emoji = mc.emoji || '🤖';
    var name = mc.name || 'Assistant';
    var tagline = mc.tagline || 'AI assistant';
    var avatarUrl = sanitizeUrl(mc.avatarUrl || '');
    if (avatarUrl) {
      el.headAvatar.innerHTML = '<img src="' + escapeHtml(avatarUrl) + '" alt="" />';
      el.bubbleEmoji.innerHTML = '<img src="' + escapeHtml(avatarUrl) + '" alt="" />';
    } else {
      el.headAvatar.textContent = emoji;
      el.bubbleEmoji.textContent = emoji;
    }
    el.headName.textContent = name;
    el.headTag.textContent = tagline;
    if ((config.position || mc.position) === 'bottom-left') {
      hostEl.style.right = 'auto';
      hostEl.style.left = '20px';
    }
    var greeting = config.greeting || mc.greeting || "Hi! I'm the app mascot — ask me anything.";
    if (!el.msgs.childElementCount) {
      el.greetingMsg = appendMsg('bot', renderMarkdown(greeting));
      var suggestions = mc.suggestions && mc.suggestions.length ? mc.suggestions : null;
      setSuggestions(suggestions);
    } else if (el.greetingMsg && el.msgs.childElementCount === 1 && mc.greeting) {
      // Remote config arrived after first paint — refresh the greeting in place.
      el.greetingMsg.innerHTML = renderMarkdown(greeting);
      var suggestions2 = mc.suggestions && mc.suggestions.length ? mc.suggestions : null;
      setSuggestions(suggestions2);
    }
  }

  function open() {
    el.panel.classList.add('mz-open');
    el.panel.setAttribute('aria-hidden', 'false');
    el.bubble.setAttribute('aria-expanded', 'true');
    el.bubbleEmoji.style.display = 'none';
    el.bubbleClose.style.display = 'block';
    el.teaser.classList.remove('mz-show');
    el.input.focus();
    emit('open', {});
  }

  function close() {
    el.panel.classList.remove('mz-open');
    el.panel.setAttribute('aria-hidden', 'true');
    el.bubble.setAttribute('aria-expanded', 'false');
    el.bubbleEmoji.style.display = 'block';
    el.bubbleClose.style.display = 'none';
    emit('close', {});
  }

  function toggle() {
    if (el.panel.classList.contains('mz-open')) close();
    else open();
  }

  function bindEvents() {
    el.bubble.addEventListener('click', toggle);
    el.panel.querySelector('.mz-min').addEventListener('click', close);
    el.teaser.addEventListener('click', open);
    el.teaser.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    el.send.addEventListener('click', function () { sendMessage(el.input.value); });
    el.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(el.input.value);
      }
    });
    el.input.addEventListener('input', function () {
      el.input.style.height = 'auto';
      el.input.style.height = Math.min(el.input.scrollHeight, 110) + 'px';
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && el.panel.classList.contains('mz-open')) close();
    });
  }

  function loadSession() {
    try { sessionId = sessionStorage.getItem('mascot_sid_' + config.appId) || null; } catch (e) { sessionId = null; }
    if (!sessionId) sessionId = uuid();
  }

  async function fetchRemoteConfig() {
    if (!config.appId || !config.publicKey) return;
    try {
      var res = await fetch(config.server + '/api/v1/widget-config/' + encodeURIComponent(config.appId) + '/' + encodeURIComponent(config.publicKey));
      if (res.ok) remoteConfig = await res.json();
    } catch (e) {
      console.warn('[mascot] Could not load widget config; using local config.', e);
    }
  }

  // ---------------------------------------------------------------- public API

  window.Mascotly = {
    init: function (opts) {
      opts = opts || {};
      ['server', 'appId', 'publicKey', 'position', 'color', 'greeting'].forEach(function (k) {
        if (opts[k] !== undefined && opts[k] !== null && opts[k] !== '') config[k] = opts[k];
      });
      if (opts.welcome !== undefined) config.welcome = !!opts.welcome;
      if (opts.teaserDelay !== undefined) config.teaserDelay = parseInt(opts.teaserDelay, 10);
      if (opts.zIndex !== undefined) config.zIndex = parseInt(opts.zIndex, 10);
      if (opts.open === true) config.open = true;
        var startInit = function () {
          if (initialized) return;
          initialized = true;
          document.body.appendChild(hostEl);
          loadSession();
          applyTheme();
          fetchRemoteConfig().then(function () {
            applyTheme();
            if (config.open) open();
          });
          if (config.teaserDelay > 0) {
            setTimeout(function () {
              if (!el.panel.classList.contains('mz-open')) {
                // Remote config wins over the local default for the teaser.
                var showTeaser = remoteConfig
                  ? (remoteConfig.mascot && remoteConfig.mascot.welcome !== false)
                  : config.welcome;
                if (!showTeaser) return;
                var rc = remoteConfig || {};
                el.teaser.textContent = (rc.mascot && rc.mascot.greeting ? rc.mascot.greeting.slice(0, 110) : '👋 Need help? Ask me anything!');
                el.teaser.classList.add('mz-show');
                setTimeout(function () { el.teaser.classList.remove('mz-show'); }, 9000);
              }
            }, config.teaserDelay);
          }
        };
        if (document.body) startInit();
        else document.addEventListener('DOMContentLoaded', startInit);
      return window.Mascotly;
    },
    registerAction: function (name, handler) {
      if (typeof name === 'string' && typeof handler === 'function') actionHandlers[name] = handler;
      return window.Mascotly;
    },
    unregisterAction: function (name) { delete actionHandlers[name]; return window.Mascotly; },
    on: function (event, fn) {
      if (listeners[event] && typeof fn === 'function') listeners[event].push(fn);
      return window.Mascotly;
    },
    off: function (event, fn) {
      if (listeners[event]) listeners[event] = listeners[event].filter(function (f) { return f !== fn; });
      return window.Mascotly;
    },
    open: function () { if (initialized) open(); return window.Mascotly; },
    close: function () { if (initialized) close(); return window.Mascotly; },
    toggle: function () { if (initialized) toggle(); return window.Mascotly; },
    send: function (text) { if (initialized) sendMessage(text); return window.Mascotly; },
    setSession: function (sid) { sessionId = sid; return window.Mascotly; },
    version: '0.1.0',
  };
  window.Mascot = window.Mascotly; // legacy alias — window.Mascotly is canonical
})();

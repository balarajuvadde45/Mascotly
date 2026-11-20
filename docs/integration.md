# Integration guide

Mascotly's widget is a **dependency-free Web Component** — it works identically in plain HTML,
React, Vue, Angular, Svelte, Electron and any framework that renders DOM.

## 1. Get your credentials

Dashboard → your app → the appId + publicKey are shown in the header and in **Settings → Keys**.

## 2. Basic embed (any page)

```html
<script src="https://your-mascot-host/widget/mascot-widget.js"></script>
<script>
  window.Mascotly.init({
    server: 'https://your-mascot-host',
    appId: 'app_xxxxxxxxxxxx',
    publicKey: 'pk_xxxxxxxxxxxxxxxx',
  });
</script>
```

### Data-attribute mode (no init call)

```html
<script src="https://your-mascot-host/widget/mascot-widget.js"
        data-server="https://your-mascot-host"
        data-app-id="app_xxx"
        data-public-key="pk_xxx"
        data-position="bottom-left"
        data-teaser-delay="8000"></script>
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `server` | script origin | Mascotly server base URL |
| `appId` / `publicKey` | — | required |
| `position` | server config | `bottom-right` / `bottom-left` |
| `color` | server config | accent color override |
| `greeting` | server config | first-message override |
| `welcome` | `true` | show the proactive teaser bubble |
| `teaserDelay` | `12000` | ms before the teaser appears |
| `zIndex` | `2147483000` | stacking context |
| `open` | `false` | start with the panel open |

Server-side mascot identity (name, emoji, color, greeting, suggestions, position) wins unless
overridden locally — change it in the dashboard without touching the embed.

## 3. Framework recipes

### React

```jsx
import { useEffect } from 'react';

export function Mascotly() {
  useEffect(() => {
    const s = document.createElement('script');
    s.src = 'https://your-mascot-host/widget/mascot-widget.js';
    s.onload = () => window.Mascotly.init({
      server: 'https://your-mascot-host',
      appId: 'app_xxx',
      publicKey: 'pk_xxx',
    });
    document.body.appendChild(s);
    return () => { /* widget is a single instance; leave it mounted */ };
  }, []);
  return null;
}
```

Next.js: load the script in `app/layout.tsx` via `next/script` with `strategy="afterInteractive"`,
then `init` in a client component.

### Vue

```html
<script src="https://your-mascot-host/widget/mascot-widget.js"></script>
<script>
  window.Mascotly.init({ server: '…', appId: '…', publicKey: '…' });
</script>
```

### Electron

Load the widget in your renderer as usual and point `server` at your hosted Mascotly server
(or a local one during development).

## 4. Host actions (let the mascot drive your app)

Register handlers; the mascot triggers them mid-conversation via a JSON action protocol:

```js
window.Mascotly.registerAction('navigate', (args) => {
  window.location.href = args.url;
});
window.Mascotly.registerAction('openSearch', (args) => {
  document.querySelector('#search').focus();
});
```

Declare the actions in the dashboard (**Mascotly tab → Host actions**) with a name and a
"when to use it" description — the brain reads those descriptions and decides when to trigger
them. A built-in `escalate` action always exists.

## 5. Events

```js
window.Mascotly.on('open', () => console.log('opened'));
window.Mascotly.on('close', () => {});
window.Mascotly.on('message', (m) => { /* { role, text, citations? } */ });
window.Mascotly.on('action', (a) => { /* { name, args } */ });
window.Mascotly.on('error', (e) => { /* { message } */ });
window.Mascotly.off('message', fn);
```

## 6. Programmatic control

```js
window.Mascotly.open();
window.Mascotly.close();
window.Mascotly.toggle();
window.Mascotly.send('How do I get started?');   // programmatically ask
window.Mascotly.setSession('ses_xxx');           // attach an existing session
```

## 7. Identity-aware chats (optional)

Pass the user's identity via the public chat API yourself if you want to pre-seed history or
attach server-side context:

```js
const res = await fetch(`${server}/api/v1/chat/${appId}/${publicKey}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    message: 'How do I export my notes?',
    sessionId: localStorage.mascotSid,      // keep the thread
    history: [{ role: 'user', content: '…' }],
    page: { url: location.href, title: document.title },
  }),
});
const data = await res.json();
// { answer, citations[], action?, escalated, sessionId, usage }
```

The `page` field tells the mascot where the user is — the brain uses it as context.

## 8. Lock it down (recommended)

Dashboard → **Settings**:

- **Allowed origins** — only listed origins may use the public key (`*` wildcards like `*.example.com` allowed).
- **Rate limit** — messages per minute per visitor.
- **Escalation keywords** — words that flag a session for a human.
- **Key rotation** — rotate immediately if a key leaks.

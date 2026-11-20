# Security

## Keys

| Key | Scope | Storage |
| --- | --- | --- |
| Admin key | full management API | `data/admin.json` or `MASCOT_ADMIN_KEY` |
| App secret key | one app's management API | `apps/<id>/app.json` |
| App public key | widget-config, chat, feedback | embeddable — safe to ship in client code |

- Admin and secret keys are compared with **timing-safe comparison**.
- Rotate keys from the dashboard (Settings → Keys) or
  `POST /api/apps/:id/keys/rotate`. The public key is embeddable by design; treat it like an
  analytics site id, not a secret.

## Public chat hardening

- **Origin allowlist** per app — when set, chat requests must come from listed origins
  (`*.example.com` wildcards supported). Empty = open.
- **Rate limiting** — sliding window per app + visitor IP (default 20 msgs/min), `429` +
  `retry-after` on breach.
- **Input caps** — message ≤ 4000 chars; history trimmed; request body capped.
- **Prompt-injection containment** — untrusted page content (URL/title) and knowledge are placed in
  clearly-scoped prompt sections; the mascot is instructed never to reveal instructions or internal
  labels. Treat it as an assistant boundary, not a security boundary: do not give the mascot secrets
  in knowledge sources, and do not add host actions that can mutate data without server-side checks.

## XSS

- The widget renders model output through an **escape-first markdown-lite renderer**: HTML is
  escaped before transformations; links are protocol-filtered (`http(s)`/`mailto` only) with
  `rel="noopener noreferrer"`; inline code and fenced blocks are escaped.
- The dashboard escapes every interpolated value (`esc()`) and stores the admin key in
  `localStorage` of the dashboard origin only.
- Server responses are JSON; no server-side HTML templating of user data.

## Subprocess safety (REA)

- REA runs via `spawn` with an **array of arguments** — never a shell string on POSIX.
- On Windows (where `.cmd` shims need a shell) arguments are validated against a strict
  metacharacter blacklist before spawning.
- Only admins / app-secret holders can trigger REA; targets must be existing local paths; output is
  size-capped; runtime is bounded by a kill-timer.

## Transport & storage

- Serve behind TLS in production (see self-hosting.md).
- Data at rest is plain JSON in `MASCOT_DATA_DIR` — protect the directory like any database
  (file permissions, disk encryption). Chat transcripts contain user content.
- CORS is `*` for the API surface (key-gated); widget endpoints are public by design. Restrict via
  origin allowlists if desired.

## Reporting

Open a GitHub security advisory for vulnerabilities; please do not open public issues for
exploitable findings.

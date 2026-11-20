# REA integration (Reverse Engineer Anything)

[REA](https://github.com/morluto/rea) — the `rea-agents` npm package — inspects shipped artifacts
(Electron apps, ASAR archives, JavaScript bundles, native binaries, and much more) **without source
code**, returning an Evidence record of what it found. Mascotly uses its CLI to reverse-engineer *your*
application and folds the findings into the mascot's knowledge and profile.

## How Mascotly uses REA

1. **Detection** — Mascotly looks for a global `rea` CLI; if absent it falls back to
   `npx -y rea-agents@latest` (downloaded on first use). Check the detected mode in the dashboard
   (**app → REA**) or `GET /api/system/rea`.
2. **Execution** — the target is analyzed with

   ```
   rea analyze-javascript-application /absolute/path/to/app --json
   ```

   (ASAR archives use the same command). Arguments are passed as an array to `spawn` — never a
   shell string on POSIX — with a 5-minute timeout and a 4 MB output cap by default.
3. **Parsing** — the output is parsed tolerantly: JSON Evidence records are walked for
   modules / features / entry points / stack / strings / evidence; human-readable output is split
   into heading-based sections.
4. **Ingestion** — sections become knowledge chunks (source type `rea`), structured insights are
   stored on the app profile, and detected features are merged into the profile's feature list.
   The next analyzer run keeps them.

## Setup

```bash
# recommended: install globally (REA needs Node ≥ 22)
npm install --global rea-agents

# verify
rea --version
```

No install needed if you accept the npx download on first run.

## Run an analysis

Dashboard: **your app → REA tab → target (absolute path on the Mascotly server machine) → kind → Run**.
Examples of targets:

| Kind | Target example |
| --- | --- |
| `javascript` | `/opt/myapp/resources/app` (extracted Electron tree), `./dist-bundle` |
| `asar` | `C:\apps\myapp\resources\app.asar` |
| `custom` (API) | any `rea` sub-command with extra args |

REST:

```bash
curl -X POST http://localhost:4242/api/apps/$APP_ID/rea \
  -H "x-mascot-key: $ADMIN_OR_SECRET" -H "content-type: application/json" \
  -d '{ "target": "/opt/myapp/resources/app.asar", "kind": "asar" }'
# → { "jobId": "job_…" }  — poll GET /api/apps/$APP_ID/jobs/$jobId
```

Results land in:

- the app's **sources** (label `REA: <target>`, type `rea`) → searchable knowledge;
- the app profile's **`reaInsights`** → shown in the dashboard (modules, stack, entry points, features…).

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `MASCOT_REA_COMMAND` | `auto` | `auto` / path to a specific rea binary |
| `MASCOT_REA_TIMEOUT` | `300000` | max analysis runtime (ms) |
| `MASCOT_REA_MAX_OUTPUT` | `4000000` | output byte cap |

## Safety notes

- REA runs **locally**; nothing is uploaded by Mascotly or by REA.
- Only admin-key or app-secret-key holders can trigger REA — it executes a CLI against a local path,
  so treat both keys accordingly.
- Arguments are strictly validated (no shell metacharacters where a shell is required on Windows);
  custom runs accept only a known sub-command shape.
- Static JS/ASAR analysis needs **no native engines**; native deep analysis would require your own
  Ghidra/IDA/Hopper setup and is outside Mascotly's default flow.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `REA exited with code …` | read the job's error + stderr in the dashboard job list |
| `command not found` / npx slow | install globally: `npm i -g rea-agents` |
| Empty findings | the target may be packed/minified — try the extracted app directory instead of the installer |
| Timeout on huge bundles | raise `MASCOT_REA_TIMEOUT`, or point at a sub-directory |

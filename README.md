# Jejak Empati

**Jejak Empati** is a 3.5-minute HTML5 Canvas empathy and active-listening simulation (*Misi lapangan Satgas P3MD*) paired with a pre-game reflection check-in, shared real-time leaderboard, live online peer presence, and a facilitator dashboard.

- **Live Game:** https://jejak-empati.pages.dev
- **Facilitator Dashboard:** https://jejak-empati.pages.dev/admin

## Architecture

The project runs on Cloudflare's free tier (`$0/month`):

- **Frontend (`public/`):**
  - `public/index.html` — self-contained HTML5 Canvas game, Web Audio SFX, pre-game check-in, and shared scoreboard client (gracefully falls back to `localStorage` when opened offline).
  - `public/admin.html` — `ADMIN_TOKEN`-protected facilitator view at `/admin` with reflection breakdowns and CSV exports (`checkins.csv`, `runs.csv`).
- **Pages Edge Proxy (`pages/`):**
  - `pages/wrangler.jsonc` & `pages/functions/api/[[path]].ts` — serves `./public` on `jejak-empati.pages.dev` and forwards `/api/*` (including `/api/room` WebSockets) via a Cloudflare Service Binding (`BACKEND`) to the `jejak-empati-game` Worker. `workers_dev` is disabled on the backend Worker.
- **Worker Backend (`src/`) & D1 (`migrations/`):**
  - `src/index.ts` — API router for `/api/health`, `/api/board`, `/api/runs/start`, `/api/runs/:id`, `/api/checkins`, `/api/room`, and Bearer-authenticated `/api/admin/*` endpoints.
  - `src/presence-room.ts` — `PresenceRoom` Durable Object using the WebSocket Hibernation API for live `"Online sekarang"` peer presence and leaderboard refresh broadcasts.
  - `src/validation.ts` — payload validation, SHA-256 token hashing, constant-time hex comparison, and formula-injection-safe CSV formatting.
  - `migrations/0001_init.sql` — D1 SQLite schema for `runs` and `checkins`.

## Local Development

The repository pins `wrangler@4.47.0` locally (compatible with Node `v20.16.0+`). Use the local binary (`.\node_modules\.bin\wrangler.cmd`) or `npm.cmd run ...` scripts so `npx` does not pull a newer Wrangler version that requires Node 22.

```powershell
npm.cmd install
npm.cmd run db:migrate:local
npm.cmd run dev
```

To test `/admin` locally, pass a temporary `ADMIN_TOKEN`:

```powershell
.\node_modules\.bin\wrangler.cmd dev --var ADMIN_TOKEN:local-dev-token
```

## Verification

```powershell
npm.cmd run typecheck
npm.cmd test
```

- `tests/validation.test.mjs` covers name sanitization, run/check-in validation, honeypot rejection, SHA-256 constant-time verification, and CSV escaping.
- `tests/integration.test.mjs` runs end-to-end against `wrangler dev --local` with D1 migrations, Durable Object WebSocket presence across two clients, token-protected run updates, and `/admin` CSV exports.

## Deployment

```powershell
.\node_modules\.bin\wrangler.cmd login
npm.cmd run db:migrate:remote
npm.cmd run deploy
npm.cmd run deploy:pages
```

Set or rotate the facilitator `/admin` passphrase:

```powershell
.\node_modules\.bin\wrangler.cmd secret put ADMIN_TOKEN
```

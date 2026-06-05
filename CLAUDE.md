# CLAUDE.md

Guidance for Claude Code working in this repo. High-signal notes only — see
[README.md](README.md) and [docs/](docs/) for the full prose.

## What this is

Production Gmail-monitoring recruiting platform for Archive. It watches
connected recruiter mailboxes via Gmail Pub/Sub push, classifies inbound
candidate replies with Anthropic Claude, drafts replies for human review in a
dashboard, and — once a recruiter approves — sends through the recruiter's own
Gmail with `sofia@archive.com` silently CC'd. Production:
https://recruiting-email-automation-api.vercel.app

**Stack:** Node + Express + Prisma backend · React + Vite + Tailwind + shadcn/ui
frontend · Supabase Postgres (Supavisor pooler) · Anthropic Claude · Vercel
single-project hosting · npm workspaces (`backend` / `frontend` / `e2e`).

## Architecture map

```
api/index.ts            # Vercel serverless entry — just re-exports backend/src/app.ts
backend/src/
  app.ts                # Express app: Helmet/CORS/rate-limit, route mounts, OAuth callback
  index.ts              # Local dev entry (app.listen on PORT)
  config.ts             # Env loader + fail-fast validation (see Gotchas)
  routes/               # one router per URL prefix (thin — delegate to services)
  services/             # domain logic — gmail, claude, auth, email, monitoring
  lib/                  # crypto (AES-256-GCM), oauthState
  middleware/           # requireAuth, requireAdmin, error
  prisma/schema.prisma  # 8 models
frontend/src/           # pages/, components/ (+ components/ui = shadcn), lib/api.ts
e2e/                    # Playwright smoke tests (run against a deployed URL)
```

**Request/data flow:** Recruiter Gmail → Pub/Sub push → `POST /api/webhooks/gmail`
(public, acks 200 immediately, processes async) → `gmail.service.fetchAndStoreMessage`
→ `EmailMessage` → `claude.service` classify + draft → `EmailDraft` (PENDING) →
recruiter approves in dashboard → Gmail draft created with CC → sent →
`EmailDraft.status = SENT`.

Heaviest module is `backend/src/services/gmail.service.ts` (OAuth, watch,
webhook decode, history sync, draft/send, watch renewal, reconcile).
`backend/src/services/claude.service.ts` has the two Claude entry points:
`classifyReply` and `generateDraftReply`.

## Dev commands

```bash
npm install                       # root — installs all workspaces; postinstall runs prisma generate
npm run dev:backend               # tsx watch → :3001
npm run dev:frontend              # Vite → :5173 (proxies /api to :3001)
npm run build                     # backend build + frontend build (what Vercel runs)

cd backend && npm test            # Vitest
cd backend && npx prisma migrate dev    # create a migration after editing schema.prisma
cd backend && npx prisma migrate deploy # apply migrations to a fresh DB
cd backend && npm run seed        # sample mailbox + candidate
cd backend && npx prisma studio   # DB browser

cd e2e && npm install && npx playwright install chromium && npm test   # E2E (hits a deployed URL)
```

## Conventions & gotchas

- **Single-tenant by design — NO per-user data filtering.** Every authenticated
  `@archive.com` user sees and can act on every candidate, draft, and mailbox.
  When adding any list/get endpoint, do NOT assume per-user scoping exists; if a
  task needs it, that's a deliberate multi-tenant change (see
  [docs/OPERATIONS.md](docs/OPERATIONS.md)). Easy to get wrong.
- **Fail-fast env validation** in `backend/src/config.ts:49`. On Vercel
  (`process.env.VERCEL` set), missing/placeholder values **throw at cold-start**
  (5xx until fixed) for these 8: `POSTGRES_PRISMA_URL`, `POSTGRES_URL_NON_POOLING`,
  `ANTHROPIC_API_KEY`, `JWT_SECRET`, `ENCRYPTION_KEY` (must decode to ≥32 bytes),
  `CRON_SECRET`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`. Locally these only warn.
  - **`PUBSUB_AUDIENCE` is fail-OPEN**, not fail-closed: when unset on Vercel the
    webhook accepts unsigned POSTs and config only logs a warning (it does NOT
    refuse to boot — the README/OPERATIONS text saying "the server refuses to
    start" is stale, pre-#51). Setting the env var flips the webhook to JWT
    verification with no redeploy.
- **Two Postgres URLs:** `POSTGRES_PRISMA_URL` (pooled, runtime) vs
  `POSTGRES_URL_NON_POOLING` (direct, used by `prisma migrate`). Don't swap them.
- **Entry indirection:** `api/index.ts` only re-exports `backend/src/app.ts`.
  Real app config lives in `app.ts`; `backend/src/index.ts` is local-dev only.
- **Migrations apply on every deploy:** `vercel-build` runs
  `prisma generate && prisma migrate deploy`. A malformed migration fails the
  build and the previous deploy stays live — never hand-edit applied migrations.
- **Auth boundaries — three distinct mechanisms:**
  - JWT (`requireAuth`) for dashboard `/api/*` routes; `requireAdmin` additionally
    gates destructive ops (resync, delete-mailbox, bulk regenerate, etc.).
  - `CRON_SECRET` bearer header for `/api/internal/cron/*` (NOT JWT).
  - `/api/webhooks/gmail` is intentionally public (Pub/Sub reaches it); guarded by
    `PUBSUB_AUDIENCE` OIDC verification when set.
- **Secrets at rest:** `Mailbox.credentials` (OAuth refresh tokens) are AES-256-GCM
  encrypted via `backend/src/lib/crypto.ts` keyed by `ENCRYPTION_KEY`. Never store
  plaintext tokens.

## Data model (`backend/prisma/schema.prisma` — 8 models)

`User` (recruiter|admin) · `Mailbox` (encrypted creds, `lastHistoryId`,
`watchExpiry`) · `Candidate` (AI status) · `EmailThread` (unit of classification)
· `EmailMessage` · `EmailDraft` (PENDING→APPROVED→SENT / DISCARDED) · `SystemLog`
(audit) · `OAuthState` (persistent CSRF nonce store for the Gmail handshake —
replaced the old in-memory Map, so cold starts no longer drop OAuth state).

## Deployment

Single Vercel project (frontend at `/`, API at `/api/*`). **Production branch:
`claude/email-automation-system-OEgcU`** — Vercel auto-deploys on push to it.
`vercel.json` defines build/bundling, SPA rewrites, and two crons:
`/api/internal/cron/renew-watches` (every 6h — Gmail watches expire after 7 days)
and `/api/internal/cron/reconcile` (hourly — catches messages the webhook missed).

## Testing & CI

`.github/workflows/test.yml` runs 3 jobs: **backend** (spins an ephemeral Postgres
shadow DB, validates schema, runs `prisma migrate diff` to catch schema/migration
drift, type-checks, Vitest), **frontend** (type-check + build + Vitest), and **e2e**
(Playwright against a deployed env, after the first two pass). If you change
`schema.prisma`, you must commit the matching migration or the schema-drift check
fails CI.

## Security notes

Helmet CSP locks scripts/connections to self-origin + Google Sign-In. CORS origins
come from `ALLOWED_ORIGINS` (defaults to the prod origin — fails closed). Rate
limits: 500/15min on `/api/*`, 20/min on `/api/auth/*`. App login is Google
Sign-In restricted to `@archive.com`, issuing 7-day JWTs.

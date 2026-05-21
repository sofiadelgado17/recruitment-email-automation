# Production checklist

A walk-through for operators preparing to launch a new deployment, validating
each deploy, and responding to incidents. Pair this with the runbook in
[`OPERATIONS.md`](./OPERATIONS.md) and the deeper architectural context in
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

If you only have time for one thing post-deploy, run `npm --prefix backend run
smoke` (or `./scripts/smoke-test.sh <base-url>`) and confirm 7/7 PASS.

---

## Pre-launch (one-time setup)

- [ ] **Supabase Postgres project provisioned** and the database password
      stored in 1Password (or your team's secret manager).
- [ ] **All Vercel env vars set** for the production environment:
  - [ ] `POSTGRES_PRISMA_URL` — pooled connection string Prisma uses at
        runtime (includes `?pgbouncer=true&connection_limit=1`).
  - [ ] `POSTGRES_URL_NON_POOLING` — direct connection string used by
        `prisma migrate deploy` during `vercel-build`.
  - [ ] `ANTHROPIC_API_KEY` — Claude API key (must start with `sk-ant-`;
        validated at `/api/health`).
  - [ ] `JWT_SECRET` — 32+ char random string used to sign session JWTs.
  - [ ] `ENCRYPTION_KEY` — 32-byte key (base64 or hex) used to encrypt Gmail
        refresh tokens at rest.
  - [ ] `CRON_SECRET` — shared secret Vercel Cron uses to call internal
        endpoints (`Authorization: Bearer $CRON_SECRET`).
  - [ ] `GMAIL_CLIENT_ID` — Google OAuth client ID (also acts as the audience
        for the Google sign-in flow).
  - [ ] `GMAIL_CLIENT_SECRET` — Google OAuth client secret.
  - [ ] `GMAIL_REDIRECT_URI` — must exactly match an authorised redirect URI
        on the OAuth client.
  - [ ] `GMAIL_PUBSUB_TOPIC` — full topic name
        (e.g. `projects/<gcp-project>/topics/gmail-watch`).
  - [ ] `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` — JSON for the workspace service
        account used for domain-wide delegation. Leave blank if not using
        workspace OAuth.
  - [ ] `FRONTEND_URL` — canonical frontend origin (used in OAuth state and
        email links).
  - [ ] `ALLOWED_ORIGINS` — comma-separated list of origins permitted by
        CORS (include any preview domains you actively use).
  - [ ] `PUBSUB_AUDIENCE` *(optional)* — expected `aud` claim on Pub/Sub push
        JWTs; defaults to the webhook URL.
- [ ] **Google Cloud OAuth client configured** with:
  - [ ] Redirect URI matching `GMAIL_REDIRECT_URI`.
  - [ ] Authorized JavaScript origin matching `FRONTEND_URL`.
  - [ ] Pub/Sub topic created and granted publish permission to
        `gmail-api-push@system.gserviceaccount.com`.
  - [ ] Push subscription on the topic pointing at
        `https://<api-host>/api/webhooks/gmail` with audience set to
        `PUBSUB_AUDIENCE`.
- [ ] **Vercel project linked to the upstream repo** with auto-deploy enabled
      on `main` (or the protected branch you ship from).
- [ ] **First deploy succeeds** — confirm in Vercel inspector that the build
      and runtime both started, then verify `/api/health` returns
      `data.status === 'healthy'`.

## Pre-launch (every deploy)

- [ ] All tests passing in CI:
  - [ ] `cd backend && npm test`
  - [ ] `cd frontend && npm test`
  - [ ] `cd frontend && npm run build`
- [ ] No P0/P1 audit items left unaddressed (check the most recent audit
      issue/PR thread).
- [ ] Vercel runtime logs from the last 24h show no unhandled errors (filter
      by `level: error`).

## Post-launch (rolling checks)

- [ ] `scripts/smoke-test.sh` (or `npm --prefix backend run smoke`) reports
      `PASSED: 7/7`.
- [ ] `GET /api/internal/sync-health` (with an admin JWT) shows, for every
      mailbox:
  - [ ] `watchExpiresInHours > 0` (active Gmail watch).
  - [ ] `lastReconciliationFoundMissing === 0` across the past 24h (no
        webhook drops slipping past).
  - [ ] `messagesLast24h > 0` for mailboxes that are actively receiving
        candidate traffic.
- [ ] Vercel Cron history shows:
  - [ ] `renew-watches` running every 6h.
  - [ ] `reconcile` running every hour.
- [ ] No silent errors in Vercel runtime logs over the last hour
      (filter by `level: error`).

## Incident response

- **Webhook silently failing.** Filter Vercel runtime logs for
  `WEBHOOK_HANDLER_ERROR`. The hourly reconciliation cron catches drift
  within ~1h, so check `/api/internal/sync-health` for a non-zero
  `lastReconciliationFoundMissing` to confirm whether the gap is closing.
- **Watch expired.** Manually invoke
  `POST /api/internal/cron/renew-watches` with `Authorization: Bearer
  $CRON_SECRET`. Confirm `watchExpiresInHours` jumps back above zero.
- **Stale draft persona.** Have an admin call
  `POST /api/drafts/regenerate-pending` to refresh outstanding drafts with
  the current persona/mailbox settings.
- **User locked out.** Check the `User` table — a JWT may simply have
  expired (7d default). Have the user sign in again. If the row is missing
  or `disabled`, re-provision via the admin flow.

## See also

- [`OPERATIONS.md`](./OPERATIONS.md) — day-to-day runbook.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system overview and data flow.
- [`TESTING.md`](./TESTING.md) — local + CI test setup.

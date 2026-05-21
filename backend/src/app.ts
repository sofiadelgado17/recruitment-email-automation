import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { errorHandler } from './middleware/error';
import { requireAuth } from './middleware/requireAuth';
import mailboxesRouter from './routes/mailboxes';
import candidatesRouter from './routes/candidates';
import emailsRouter from './routes/emails';
import draftsRouter from './routes/drafts';
import webhooksRouter from './routes/webhooks';
import healthRouter from './routes/health';
import authRouter from './routes/auth';
import internalCronRouter from './routes/internal-cron';
import internalStatusRouter from './routes/internal-status';
import { handleCallback, watchMailbox, syncMessages } from './services/gmail.service';
import { consumeOAuthState } from './lib/oauthState';
import { createError } from './middleware/error';
import { logEvent } from './services/monitoring.service';

const app = express();

// Vercel terminates TLS at its edge proxy and forwards the client IP via
// X-Forwarded-For. Without this, express-rate-limit throws a ValidationError
// on every /api/* request and `req.ip` reports the proxy IP instead of the
// real client IP.
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

app.use(
  cors({
    origin: config.frontendUrl,
    credentials: true,
  })
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Public routes ─────────────────────────────────────────────────────────
app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
// Webhooks must remain unauthenticated for Google Pub/Sub push.
app.use('/api/webhooks', webhooksRouter);
// Internal cron endpoint — authenticated via CRON_SECRET header, not JWT.
app.use('/api/internal/cron', internalCronRouter);

// Gmail OAuth callback: Google redirects the user's browser here with `code`
// and `state` query params. There is no JWT on that redirect, so this single
// handler must remain public. The rest of /api/mailboxes is auth-gated below.
function qs(val: unknown): string | undefined {
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0] as string;
  return undefined;
}
app.get(
  '/api/mailboxes/gmail/callback',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = qs(req.query.code);
      const state = qs(req.query.state);
      if (!code) {
        return next(createError('Missing authorization code', 400));
      }
      if (!state) {
        return next(createError('Missing OAuth state parameter', 400));
      }
      if (!consumeOAuthState(state)) {
        return next(createError('Invalid or expired OAuth state', 400));
      }
      const mailbox = await handleCallback(code, state);
      try {
        await watchMailbox(mailbox.id);
      } catch (watchErr) {
        console.warn('[Mailbox] Gmail watch setup failed:', watchErr);
      }
      try {
        const result = await syncMessages(mailbox.id, { maxResults: 250, daysBack: 7 });
        await logEvent(
          'MAILBOX_BACKFILLED_ON_CONNECT',
          { mailboxId: mailbox.id, ...result },
          'INFO'
        );
      } catch (backfillErr) {
        console.warn('[Mailbox] Initial backfill failed:', backfillErr);
        await logEvent(
          'MAILBOX_BACKFILL_FAILED',
          {
            mailboxId: mailbox.id,
            error: backfillErr instanceof Error ? backfillErr.message : String(backfillErr),
          },
          'WARN'
        );
      }
      const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173';
      res.redirect(`${frontendUrl}?mailbox=connected`);
    } catch (err) {
      next(err);
    }
  }
);

// ── Authenticated API routes ─────────────────────────────────────────────
app.use('/api/mailboxes', requireAuth, mailboxesRouter);
app.use('/api/candidates', requireAuth, candidatesRouter);
app.use('/api/emails', requireAuth, emailsRouter);
app.use('/api/drafts', requireAuth, draftsRouter);
// Sync-health is JWT-auth-gated (dashboard/debug), not CRON_SECRET. Mounted
// under /api/internal/ alongside the cron router but using requireAuth.
app.use('/api/internal/sync-health', requireAuth, internalStatusRouter);

// Error handler (must be last)
app.use(errorHandler);

export default app;

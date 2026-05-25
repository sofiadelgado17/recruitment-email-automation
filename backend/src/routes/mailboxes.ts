import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../db/client';
import {
  getAuthUrl,
  createServiceAccountClient,
  resolveMailboxDisplayName,
  serializeCredentials,
  syncMessages,
  fetchMailboxSignature,
  reclassifyOrphanedThreads,
} from '../services/gmail.service';
import { storeOAuthState } from '../lib/oauthState';
import { createError } from '../middleware/error';
import { requireAdmin } from '../middleware/requireAdmin';
import { logEvent } from '../services/monitoring.service';

const router = Router();

// GET /api/mailboxes
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const mailboxes = await prisma.mailbox.findMany({
      select: {
        id: true,
        provider: true,
        emailAddress: true,
        displayName: true,
        isActive: true,
        watchExpiry: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { threads: true, messages: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ success: true, data: mailboxes });
  } catch (err) {
    next(err);
  }
});

// POST /api/mailboxes/gmail/auth
router.post('/gmail/auth', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const state = crypto.randomBytes(32).toString('hex');
    await storeOAuthState(state);
    const authUrl = getAuthUrl(state);
    res.json({ success: true, data: { authUrl } });
  } catch (err) {
    next(err);
  }
});

// NOTE: GET /api/mailboxes/gmail/callback is registered directly on the
// Express app (see app.ts) because Google's OAuth redirect cannot carry a JWT.
// Keeping it out of this router avoids accidentally putting it behind
// requireAuth. The state-validation logic lives there as well.

// POST /api/mailboxes/:id/resync
router.post('/:id/resync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const mailbox = await prisma.mailbox.findUnique({ where: { id } });
    if (!mailbox) {
      return next(createError('Mailbox not found', 404));
    }
    const result = await syncMessages(id, { maxResults: 250, daysBack: 30 });
    await logEvent('MAILBOX_RESYNCED', { mailboxId: id, ...result }, 'INFO');
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/mailboxes/:id/reclassify
// Re-classify threads that have stored messages but no linked candidate.
// Works from DB data only — does not call Gmail API.
router.post('/:id/reclassify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const mailbox = await prisma.mailbox.findUnique({ where: { id } });
    if (!mailbox) return next(createError('Mailbox not found', 404));
    const result = await reclassifyOrphanedThreads(id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/mailboxes/workspace/connect
// Admin-only: this endpoint accepts an arbitrary list of @archive.com mailbox
// addresses and uses the service-account DWD client to impersonate each one.
// Without requireAdmin, any logged-in recruiter could attach the CEO's mailbox
// (or any other workspace user's) and start ingesting their email. Siblings
// resync / refresh-all-profiles / DELETE :id are all admin-gated for the same
// reason — closing this gap matches them.
router.post('/workspace/connect', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { emailAddresses } = req.body as { emailAddresses?: string[] };
    if (!Array.isArray(emailAddresses) || emailAddresses.length === 0) {
      return next(createError('emailAddresses must be a non-empty array', 400));
    }

    const results: Array<{ email: string; success: boolean; error?: string }> = [];

    for (const email of emailAddresses) {
      try {
        // Validate by trying to list 1 message via service account
        const gmail = await createServiceAccountClient(email);
        await gmail.users.messages.list({ userId: email, maxResults: 1 });

        const encryptedCreds = serializeCredentials({
          type: 'service_account',
          impersonating: email,
        });
        const mailbox = await prisma.mailbox.upsert({
          where: { emailAddress: email },
          update: {
            provider: 'GMAIL',
            credentials: encryptedCreds,
            isActive: true,
            updatedAt: new Date(),
          },
          create: {
            provider: 'GMAIL',
            emailAddress: email,
            displayName: email,
            credentials: encryptedCreds,
            isActive: true,
          },
        });

        await logEvent('MAILBOX_WORKSPACE_CONNECTED', { mailboxId: mailbox.id, email }, 'INFO');

        try {
          const result = await syncMessages(mailbox.id, { maxResults: 250, daysBack: 7 });
          await logEvent(
            'MAILBOX_BACKFILLED_ON_CONNECT',
            { mailboxId: mailbox.id, ...result },
            'INFO'
          );
        } catch (backfillErr) {
          console.warn('[Mailbox] Workspace backfill failed:', backfillErr);
          await logEvent(
            'MAILBOX_BACKFILL_FAILED',
            {
              mailboxId: mailbox.id,
              error: backfillErr instanceof Error ? backfillErr.message : String(backfillErr),
            },
            'WARN'
          );
        }

        results.push({ email, success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ email, success: false, error: message });
      }
    }

    res.json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
});

// POST /api/mailboxes/refresh-all-profiles
// Bulk version of refresh-profile. Loops over active mailboxes and refreshes
// each one's displayName using the same userinfo → sent-messages fallback.
// Capped at 25 mailboxes per request to fit within Vercel's serverless
// timeout (we hit Google userinfo for each).
router.post(
  '/refresh-all-profiles',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const mailboxes = await prisma.mailbox.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
        take: 25,
      });

      let updated = 0;
      let unchanged = 0;
      let failed = 0;
      const details: Array<{
        id: string;
        emailAddress: string;
        result: 'updated' | 'unchanged' | 'failed';
        displayName?: string;
        source?: 'userinfo' | 'sent_messages';
        error?: string;
      }> = [];

      for (const mailbox of mailboxes) {
        try {
          const resolved = await resolveMailboxDisplayName(mailbox);
          if (!resolved) {
            failed += 1;
            details.push({
              id: mailbox.id,
              emailAddress: mailbox.emailAddress,
              result: 'failed',
              error:
                'Could not infer display name; user should re-OAuth to grant the profile scope',
            });
            continue;
          }

          if (resolved.displayName === mailbox.displayName) {
            unchanged += 1;
            details.push({
              id: mailbox.id,
              emailAddress: mailbox.emailAddress,
              result: 'unchanged',
              displayName: resolved.displayName,
              source: resolved.source,
            });
            continue;
          }

          await prisma.mailbox.update({
            where: { id: mailbox.id },
            data: { displayName: resolved.displayName },
          });
          await logEvent(
            'MAILBOX_DISPLAYNAME_REFRESHED',
            {
              mailboxId: mailbox.id,
              displayName: resolved.displayName,
              source: resolved.source,
            },
            'INFO'
          );
          updated += 1;
          details.push({
            id: mailbox.id,
            emailAddress: mailbox.emailAddress,
            result: 'updated',
            displayName: resolved.displayName,
            source: resolved.source,
          });
        } catch (err) {
          failed += 1;
          details.push({
            id: mailbox.id,
            emailAddress: mailbox.emailAddress,
            result: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      res.json({
        success: true,
        data: { updated, unchanged, failed, total: mailboxes.length, details },
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/mailboxes/:id/refresh-profile
// Refresh the displayName for a single mailbox. Tries userinfo first (using
// the stored OAuth credentials). If that fails (e.g. the user connected
// before Phase L added the userinfo.profile scope), falls back to inferring
// the name from the most recent outbound EmailMessage.fromName. Returns 400
// if neither source produces a usable name.
router.post(
  '/:id/refresh-profile',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const mailbox = await prisma.mailbox.findUnique({ where: { id } });
      if (!mailbox) {
        return next(createError('Mailbox not found', 404));
      }

      const resolved = await resolveMailboxDisplayName(mailbox);
      if (!resolved) {
        return next(
          createError(
            'Could not infer display name; user should re-OAuth to grant the profile scope',
            400
          )
        );
      }

      const updated = await prisma.mailbox.update({
        where: { id },
        data: { displayName: resolved.displayName },
        select: {
          id: true,
          provider: true,
          emailAddress: true,
          displayName: true,
          isActive: true,
          watchExpiry: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await logEvent(
        'MAILBOX_DISPLAYNAME_REFRESHED',
        { mailboxId: id, displayName: resolved.displayName, source: resolved.source },
        'INFO'
      );

      res.json({ success: true, data: { mailbox: updated, source: resolved.source } });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/mailboxes/:id/signature
// Returns the raw HTML signature (and diagnostics) for a mailbox.
// Useful for verifying the signature before it goes into a draft.
router.get('/:id/signature', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const mailbox = await prisma.mailbox.findUnique({ where: { id } });
    if (!mailbox) return next(createError('Mailbox not found', 404));
    const signatureHtml = await fetchMailboxSignature(id);
    res.json({
      success: true,
      data: {
        mailboxEmail: mailbox.emailAddress,
        signatureHtml,
        found: signatureHtml !== null,
        previewUrl: signatureHtml
          ? `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html><html><body style="font-family:sans-serif">${signatureHtml}</body></html>`)}`
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/mailboxes/:id
router.delete('/:id', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const mailbox = await prisma.mailbox.findUnique({ where: { id } });
    if (!mailbox) {
      return next(createError('Mailbox not found', 404));
    }

    await prisma.mailbox.update({
      where: { id },
      data: { isActive: false },
    });

    await logEvent('MAILBOX_DISCONNECTED', { mailboxId: id }, 'INFO');
    res.json({ success: true, message: 'Mailbox disconnected' });
  } catch (err) {
    next(err);
  }
});

export default router;

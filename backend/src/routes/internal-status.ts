import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../db/client';

const router = Router();

interface MailboxSyncHealth {
  mailboxId: string;
  emailAddress: string;
  displayName: string | null;
  isActive: boolean;
  watchExpiry: string | null;
  watchExpiresInHours: number | null;
  lastSyncedMessageAt: string | null;
  lastReconciliationAt: string | null;
  lastReconciliationFoundMissing: number;
  messagesLast24h: number;
  pendingDrafts: number;
  candidatesNeedsReview: number;
  webhookErrorsLast24h: number;
}

/**
 * Best-effort parse of a SystemLog.details JSON blob into a record.
 * Returns an empty object on any error so callers can do `details.missingBefore`
 * without exploding on malformed rows.
 */
function parseDetails(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// GET /api/internal/sync-health
// Auth-gated by the user JWT (mounted with requireAuth in app.ts). Returns
// per-mailbox sync health for the dashboard / debug tooling: watch-expiry
// countdown, last sync time, last reconciliation result, message + draft +
// review + webhook-error counts. Read-only — does not trigger any sync work.
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);

    // Pull all WEBHOOK_HANDLER_ERROR events in the last 24h once, then count
    // per mailbox below by matching emailAddress in `details`. SystemLog
    // doesn't have a mailboxId column for these so JS-side bucketing is the
    // simplest correct option.
    const [mailboxes, recentWebhookErrors] = await Promise.all([
      prisma.mailbox.findMany({ orderBy: { createdAt: 'asc' } }),
      prisma.systemLog.findMany({
        where: {
          event: 'WEBHOOK_HANDLER_ERROR',
          createdAt: { gte: dayAgo },
        },
        select: { details: true },
        take: 500,
      }),
    ]);

    const errorsByEmail = new Map<string, number>();
    for (const log of recentWebhookErrors) {
      const details = parseDetails(log.details);
      const email = typeof details.emailAddress === 'string' ? details.emailAddress : null;
      if (!email) continue;
      errorsByEmail.set(email, (errorsByEmail.get(email) ?? 0) + 1);
    }

    const health: MailboxSyncHealth[] = await Promise.all(
      mailboxes.map(async (mb) => {
        const [
          lastMessage,
          messagesLast24h,
          pendingDrafts,
          candidatesNeedsReview,
          recentReconciliations,
        ] = await Promise.all([
          prisma.emailMessage.findFirst({
            where: { mailboxId: mb.id },
            orderBy: { receivedAt: 'desc' },
            select: { receivedAt: true },
          }),
          prisma.emailMessage.count({
            where: { mailboxId: mb.id, receivedAt: { gte: dayAgo } },
          }),
          prisma.emailDraft.count({
            where: { status: 'PENDING', thread: { mailboxId: mb.id } },
          }),
          prisma.candidate.count({
            where: { mailboxId: mb.id, status: 'NEEDS_REVIEW' },
          }),
          // Pull the most recent RECONCILIATION_RUN for this mailbox. SystemLog
          // doesn't have a mailboxId column — the id is embedded in `details`
          // JSON — so we filter in JS. Cap at 50 rows: more than enough to
          // find the latest per-mailbox entry across a few hourly runs.
          prisma.systemLog.findMany({
            where: { event: 'RECONCILIATION_RUN' },
            orderBy: { createdAt: 'desc' },
            take: 50,
          }),
        ]);

        const lastReconForMailbox = recentReconciliations.find((log) => {
          const details = parseDetails(log.details);
          return details.mailboxId === mb.id;
        });
        const lastReconDetails = lastReconForMailbox
          ? parseDetails(lastReconForMailbox.details)
          : {};
        const missingFromLast =
          typeof lastReconDetails.missingBefore === 'number'
            ? lastReconDetails.missingBefore
            : 0;

        const watchExpiresInHours = mb.watchExpiry
          ? Math.round(((mb.watchExpiry.getTime() - now) / (60 * 60 * 1000)) * 10) / 10
          : null;

        return {
          mailboxId: mb.id,
          emailAddress: mb.emailAddress,
          displayName: mb.displayName,
          isActive: mb.isActive,
          watchExpiry: mb.watchExpiry ? mb.watchExpiry.toISOString() : null,
          watchExpiresInHours,
          lastSyncedMessageAt: lastMessage ? lastMessage.receivedAt.toISOString() : null,
          lastReconciliationAt: lastReconForMailbox
            ? lastReconForMailbox.createdAt.toISOString()
            : null,
          lastReconciliationFoundMissing: missingFromLast,
          messagesLast24h,
          pendingDrafts,
          candidatesNeedsReview,
          webhookErrorsLast24h: errorsByEmail.get(mb.emailAddress) ?? 0,
        };
      })
    );

    res.status(200).json({ success: true, data: health });
  } catch (err) {
    next(err);
  }
});

export default router;

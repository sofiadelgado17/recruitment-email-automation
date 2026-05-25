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
  totalMessages: number;
  totalCandidates: number;
  pendingDrafts: number;
  candidatesNeedsReview: number;
  webhookErrorsLast24h: number;
  lastWebhookError: string | null;
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
router.get('/sync-health', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);

    // Fetch all shared data in one round-trip before the per-mailbox fan-out.
    const [mailboxes, recentWebhookErrors, recentReconciliations] = await Promise.all([
      prisma.mailbox.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.systemLog.findMany({
        where: { event: 'WEBHOOK_HANDLER_ERROR', createdAt: { gte: dayAgo } },
        select: { details: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      // Fetched once here and shared across all mailboxes below — no need to
      // re-query inside each mailbox's Promise.all.
      prisma.systemLog.findMany({
        where: { event: 'RECONCILIATION_RUN' },
        orderBy: { createdAt: 'desc' },
        select: { details: true, createdAt: true },
        take: 200,
      }),
    ]);

    const errorsByEmail = new Map<string, number>();
    const lastErrorByEmail = new Map<string, string>();
    for (const log of recentWebhookErrors) {
      const details = parseDetails(log.details);
      const email = typeof details.emailAddress === 'string' ? details.emailAddress : null;
      if (!email) continue;
      errorsByEmail.set(email, (errorsByEmail.get(email) ?? 0) + 1);
      // recentWebhookErrors is ordered desc, so first occurrence = most recent
      if (!lastErrorByEmail.has(email) && typeof details.error === 'string') {
        lastErrorByEmail.set(email, details.error);
      }
    }

    const health: MailboxSyncHealth[] = await Promise.all(
      mailboxes.map(async (mb) => {
        try {
          const [lastMessage, messagesLast24h, totalMessages, totalCandidates, pendingDrafts, candidatesNeedsReview] =
            await Promise.all([
              prisma.emailMessage.findFirst({
                where: { mailboxId: mb.id },
                orderBy: { receivedAt: 'desc' },
                select: { receivedAt: true },
              }),
              prisma.emailMessage.count({
                where: { mailboxId: mb.id, receivedAt: { gte: dayAgo } },
              }),
              prisma.emailMessage.count({ where: { mailboxId: mb.id } }),
              prisma.candidate.count({ where: { mailboxId: mb.id } }),
              prisma.emailDraft.count({
                where: {
                  status: 'PENDING',
                  thread: { mailboxId: mb.id },
                },
              }),
              prisma.candidate.count({
                where: { mailboxId: mb.id, status: 'NEEDS_REVIEW' },
              }),
            ]);

          const lastReconForMailbox = recentReconciliations.find((log) => {
            const d = parseDetails(log.details);
            return d.mailboxId === mb.id;
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
            totalMessages,
            totalCandidates,
            pendingDrafts,
            candidatesNeedsReview,
            webhookErrorsLast24h: errorsByEmail.get(mb.emailAddress) ?? 0,
            lastWebhookError: lastErrorByEmail.get(mb.emailAddress) ?? null,
          };
        } catch (mbErr) {
          // Return a degraded row rather than failing the whole response.
          console.error(`[sync-health] Failed to compute health for mailbox ${mb.emailAddress}:`, mbErr);
          return {
            mailboxId: mb.id,
            emailAddress: mb.emailAddress,
            displayName: mb.displayName,
            isActive: mb.isActive,
            watchExpiry: mb.watchExpiry ? mb.watchExpiry.toISOString() : null,
            watchExpiresInHours: null,
            lastSyncedMessageAt: null,
            lastReconciliationAt: null,
            lastReconciliationFoundMissing: 0,
            messagesLast24h: 0,
            totalMessages: 0,
            totalCandidates: 0,
            pendingDrafts: 0,
            candidatesNeedsReview: 0,
            webhookErrorsLast24h: 0,
            lastWebhookError: null,
          };
        }
      })
    );

    res.status(200).json({ success: true, data: health });
  } catch (err) {
    next(err);
  }
});

// GET /api/internal/debug/mailbox?email=aaronrampersad@archive.com
// Admin-only debug: shows what messages + candidates the DB has for a mailbox.
router.get('/debug/mailbox', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email = typeof req.query.email === 'string' ? req.query.email.trim() : null;
    if (!email) return res.status(400).json({ success: false, message: 'email query param required' });

    const mailbox = await prisma.mailbox.findUnique({ where: { emailAddress: email } });
    if (!mailbox) return res.status(404).json({ success: false, message: 'Mailbox not found' });

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [totalMessages, recentMessages, recentLogs, webhookErrorLogs, candidates] = await Promise.all([
      prisma.emailMessage.count({ where: { mailboxId: mailbox.id } }),
      prisma.emailMessage.findMany({
        where: { mailboxId: mailbox.id },
        orderBy: { receivedAt: 'desc' },
        take: 20,
        select: {
          externalMessageId: true,
          fromAddress: true,
          fromName: true,
          subject: true,
          receivedAt: true,
          thread: { select: { candidateId: true } },
        },
      }),
      prisma.systemLog.findMany({
        where: {
          details: { contains: mailbox.id },
          createdAt: { gte: weekAgo },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { event: true, level: true, createdAt: true, details: true },
      }),
      // Webhook errors log emailAddress not mailboxId, so search separately
      prisma.systemLog.findMany({
        where: {
          event: 'WEBHOOK_HANDLER_ERROR',
          details: { contains: mailbox.emailAddress },
          createdAt: { gte: weekAgo },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { event: true, level: true, createdAt: true, details: true },
      }),
      prisma.candidate.findMany({
        where: { mailboxId: mailbox.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, name: true, email: true, status: true, createdAt: true },
      }),
    ]);

    res.json({
      success: true,
      data: {
        mailbox: { id: mailbox.id, emailAddress: mailbox.emailAddress, isActive: mailbox.isActive, lastHistoryId: mailbox.lastHistoryId, watchExpiry: mailbox.watchExpiry },
        totalMessages,
        recentMessages,
        candidates,
        recentLogs,
        webhookErrorLogs,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/internal/debug/candidate?email=sofiadelgadosandoval@gmail.com
router.get('/debug/candidate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const email = typeof req.query.email === 'string' ? req.query.email.trim() : null;
    if (!email) return res.status(400).json({ success: false, message: 'email query param required' });

    const candidate = await prisma.candidate.findUnique({
      where: { email },
      include: {
        threads: {
          include: {
            messages: { orderBy: { receivedAt: 'asc' }, take: 5 },
            drafts: { orderBy: { createdAt: 'desc' }, take: 3 },
          },
        },
      },
    });

    // Also look for any messages from this email even without a linked candidate
    const [messagesFromEmail, skipLogs] = await Promise.all([
      prisma.emailMessage.findMany({
        where: { fromAddress: email },
        orderBy: { receivedAt: 'desc' },
        take: 10,
        select: {
          externalMessageId: true,
          subject: true,
          receivedAt: true,
          mailboxId: true,
          thread: { select: { id: true, candidateId: true, subject: true } },
        },
      }),
      // Check if any messages from this sender were skipped by the classifier
      prisma.systemLog.findMany({
        where: {
          event: { in: ['MESSAGE_SKIPPED_NOT_RECRUITING', 'CANDIDATE_CLASSIFIED', 'DRAFT_SKIPPED_NEEDS_REVIEW', 'DRAFT_SKIPPED_LOW_CONFIDENCE'] },
          details: { contains: email },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { event: true, level: true, createdAt: true, details: true },
      }),
    ]);

    res.json({ success: true, data: { candidate, messagesFromEmail, skipLogs } });
  } catch (err) {
    next(err);
  }
});

// POST /api/internal/fix-replied-at
// One-time fix: clears repliedAt on candidates where the only outbound messages
// in their thread are the original outreach (no prior inbound from candidate).
router.post('/fix-replied-at', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const candidates = await prisma.candidate.findMany({
      where: { repliedAt: { not: null } },
      include: {
        threads: {
          include: {
            messages: { orderBy: { receivedAt: 'asc' } },
          },
        },
      },
    });

    let cleared = 0;
    for (const candidate of candidates) {
      for (const thread of candidate.threads) {
        const mailbox = await prisma.mailbox.findUnique({ where: { id: thread.mailboxId } });
        if (!mailbox) continue;
        const mailboxEmail = mailbox.emailAddress.toLowerCase();

        // Find earliest outbound message in the thread
        const outboundMsgs = thread.messages.filter(
          (m) => m.fromAddress.toLowerCase() === mailboxEmail
        );
        if (outboundMsgs.length === 0) continue;
        const earliestOutbound = outboundMsgs[0];

        // Check if any inbound message exists before the earliest outbound
        const hasInboundBefore = thread.messages.some(
          (m) =>
            m.fromAddress.toLowerCase() !== mailboxEmail &&
            m.receivedAt < earliestOutbound.receivedAt
        );

        if (!hasInboundBefore) {
          // All outbound messages are original outreach — clear repliedAt
          await prisma.candidate.update({
            where: { id: candidate.id },
            data: { repliedAt: null },
          });
          cleared++;
          break; // only need to process each candidate once
        }
      }
    }

    res.json({ success: true, data: { checked: candidates.length, cleared } });
  } catch (err) {
    next(err);
  }
});

export default router;

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../db/client';
import { createError } from '../middleware/error';
import { logEvent } from '../services/monitoring.service';
import { scheduleLeverRefresh } from '../services/leverRealtime.service';
import { serializeEmailMessages } from '../lib/emailMessageSerializer';
import { classifyReply } from '../services/claude.service';
import { requireAdmin } from '../middleware/requireAdmin';
import { deriveReplyStatus, normalizeEmail } from '../lib/candidateState';
import { DRAFT_EXPIRY_DAYS } from './drafts';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { CANCELABLE_DRAFT_STATUSES } from '../lib/draftStatus';

const router = Router();

const CANDIDATE_STATUSES = [
  'PENDING',
  'INTERESTED',
  'NOT_INTERESTED',
  'NEUTRAL',
  'REPLIED',
  'NEEDS_REVIEW',
  'IGNORED',
] as const;

const updateCandidateSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  status: z.enum(CANDIDATE_STATUSES).optional(),
  notes: z.string().optional(),
  repliedAt: z.null().optional(),
  ownerUserId: z.string().min(1).nullable().optional(),
});

// Pagination bounds — clamp `page` and `limit` so an attacker (or a buggy
// caller) can't force the server to skip past unbounded offsets or pull
// massive result sets per request.
const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

// Validate filter query params before they hit Prisma. Without this the
// `status` / `mailboxId` strings flow straight into the where clause; the
// runtime still rejects malformed inputs at the DB layer, but the response
// is opaque and the SQL it generates is wasted work.
const REPLY_STATUSES = ['NEW', 'AWAITING_REPLY', 'REPLIED'] as const;

// Server-side sort columns (L16, R3). Default (no sort) keeps latest-activity
// order. `mailbox`, `lever` and `lastActivity` are the R3 table's columns.
const SORT_COLUMNS = [
  'name',
  'email',
  'company',
  'role',
  'status',
  'createdAt',
  'updatedAt',
  'lastInboundAt',
  'mailbox',
  'lever',
  'lastActivity',
] as const;
const NULLABLE_SORT_COLUMNS = new Set<string>(['company', 'role', 'lastInboundAt']);

const candidateListFilterSchema = z.object({
  status: z.enum(CANDIDATE_STATUSES).optional(),
  replyStatus: z.enum(REPLY_STATUSES).optional(),
  // F2: IN = any Lever opportunity (active, archived or hired); NOT_IN = checked, none found.
  lever: z.enum(['IN', 'NOT_IN']).optional(),
  sort: z.enum(SORT_COLUMNS).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  // Cuid shape — 20–30 lowercase alphanumerics. Prisma's default id() uses
  // `c` + 24 chars in practice; the wider range absorbs other cuid variants
  // without opening up to arbitrary input.
  mailboxId: z
    .string()
    .regex(/^[a-z0-9]{20,30}$/, 'mailboxId must be a cuid')
    .optional(),
});

function qs(val: unknown): string | undefined {
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0] as string;
  return undefined;
}

/**
 * Prisma filter equal to deriveReplyStatus (lib/candidateState), so list
 * filters and counts agree with the badge (H6, M19). Rows without
 * lastInboundAt (not yet backfilled) use the legacy repliedAt rule.
 */
function replyStatusWhere(status: (typeof REPLY_STATUSES)[number]): Prisma.CandidateWhereInput {
  const outbound = prisma.candidate.fields.lastOutboundAt;
  switch (status) {
    case 'AWAITING_REPLY':
      return {
        OR: [
          { lastInboundAt: { not: null }, lastOutboundAt: null },
          { lastInboundAt: { gt: outbound } },
          { lastInboundAt: null, repliedAt: null, threads: { some: {} } },
        ],
      };
    case 'REPLIED':
      return {
        OR: [
          { lastInboundAt: { not: null, lte: outbound } },
          { lastInboundAt: null, repliedAt: { not: null } },
        ],
      };
    case 'NEW':
      return { lastInboundAt: null, repliedAt: null, threads: { none: {} } };
  }
}

const cuidSchema = z.string().regex(/^[a-z0-9]{20,30}$/, 'mailboxId must be a cuid');

/**
 * Pipeline counts for the dashboard, computed in SQL over every candidate
 * rather than from a 500-row client sample (M18). `awaitingReply` follows
 * the same rule as replyStatus AWAITING_REPLY and, like the dashboard pill
 * always has, leaves out IGNORED and role-less candidates. `pendingDrafts`
 * matches the Pending tab: PENDING, younger than the expiry window, and not
 * already answered outside the app.
 */
router.get('/counts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsedMailbox = cuidSchema.optional().safeParse(qs(req.query.mailboxId));
    if (!parsedMailbox.success) {
      return next(createError(parsedMailbox.error.errors[0]?.message ?? 'Invalid mailboxId', 400));
    }
    const mailboxId = parsedMailbox.data ?? null;
    const expiryCutoff = new Date(Date.now() - DRAFT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const candidateRows = await prisma.$queryRaw<
      Array<{ mailboxId: string | null; candidates: number; needsReview: number; awaitingReply: number }>
    >`
      SELECT c."mailboxId" AS "mailboxId",
        COUNT(*) FILTER (WHERE c.status <> 'IGNORED')::int AS candidates,
        COUNT(*) FILTER (WHERE c.status = 'NEEDS_REVIEW')::int AS "needsReview",
        COUNT(*) FILTER (
          WHERE c.status <> 'IGNORED' AND c.role IS NOT NULL AND (
            (c."lastInboundAt" IS NOT NULL AND (c."lastOutboundAt" IS NULL OR c."lastInboundAt" > c."lastOutboundAt"))
            OR (c."lastInboundAt" IS NULL AND c."repliedAt" IS NULL
                AND EXISTS (SELECT 1 FROM "EmailThread" t WHERE t."candidateId" = c.id))
          )
        )::int AS "awaitingReply"
      FROM "Candidate" c
      WHERE (${mailboxId}::text IS NULL OR c."mailboxId" = ${mailboxId})
      GROUP BY c."mailboxId"`;

    const draftRows = await prisma.$queryRaw<Array<{ mailboxId: string; pendingDrafts: number }>>`
      SELECT t."mailboxId" AS "mailboxId", COUNT(*)::int AS "pendingDrafts"
      FROM "EmailDraft" d
      JOIN "EmailThread" t ON t.id = d."threadId"
      LEFT JOIN "Candidate" c ON c.id = t."candidateId"
      WHERE d.status = 'PENDING'
        AND d."createdAt" >= ${expiryCutoff}
        AND NOT (c."repliedAt" IS NOT NULL AND c."repliedAt" > d."createdAt")
        AND (${mailboxId}::text IS NULL OR t."mailboxId" = ${mailboxId})
      GROUP BY t."mailboxId"`;

    const pendingByMailbox = new Map((draftRows ?? []).map((r) => [r.mailboxId, Number(r.pendingDrafts)]));
    const byMailbox = (candidateRows ?? []).map((r) => ({
      mailboxId: r.mailboxId,
      candidates: Number(r.candidates),
      needsReview: Number(r.needsReview),
      awaitingReply: Number(r.awaitingReply),
      pendingDrafts: pendingByMailbox.get(r.mailboxId ?? '') ?? 0,
    }));
    // Mailboxes with drafts but no candidate rows still count.
    for (const [mbId, n] of pendingByMailbox) {
      if (!byMailbox.some((r) => r.mailboxId === mbId)) {
        byMailbox.push({ mailboxId: mbId, candidates: 0, needsReview: 0, awaitingReply: 0, pendingDrafts: n });
      }
    }
    const sum = (k: 'candidates' | 'needsReview' | 'awaitingReply' | 'pendingDrafts') =>
      byMailbox.reduce((acc, r) => acc + r[k], 0);

    res.json({
      success: true,
      data: {
        candidates: sum('candidates'),
        awaitingReply: sum('awaitingReply'),
        needsReview: sum('needsReview'),
        pendingDrafts: sum('pendingDrafts'),
        byMailbox,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/candidates
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filterParsed = candidateListFilterSchema.safeParse({
      status: qs(req.query.status),
      replyStatus: qs(req.query.replyStatus),
      lever: qs(req.query.lever),
      sort: qs(req.query.sort),
      dir: qs(req.query.dir),
      mailboxId: qs(req.query.mailboxId),
    });
    if (!filterParsed.success) {
      return next(createError(filterParsed.error.errors[0]?.message ?? 'Invalid filter', 400));
    }
    const { status, replyStatus, lever, sort, dir, mailboxId } = filterParsed.data;
    const paged = paginationSchema.safeParse({
      page: qs(req.query.page),
      limit: qs(req.query.limit),
    });
    if (!paged.success) {
      return next(createError(paged.error.message, 400));
    }
    const { page, limit } = paged.data;
    const skip = (page - 1) * limit;

    const includeIgnored = qs(req.query.includeIgnored) === 'true';
    const search = qs(req.query.search)?.trim() ?? '';

    const where: Prisma.CandidateWhereInput = {};
    // Search narrows the current filters instead of replacing them (R3): the
    // UI shows every active filter as a chip, so dropping them was invisible.
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (status) {
      where.status = status;
    } else if (!includeIgnored) {
      // Default view hides ignored candidates so dismissed people don't clutter
      // the dashboard. Caller can pass ?status=IGNORED or ?includeIgnored=true
      // to see them.
      where.status = { not: 'IGNORED' };
    }
    if (mailboxId) where.mailboxId = mailboxId;
    if (lever) where.leverState = lever === 'IN' ? { in: ['ACTIVE', 'ARCHIVED', 'HIRED'] } : 'NOT_FOUND';
    if (replyStatus) {
      where.AND = [replyStatusWhere(replyStatus)];
      // Matches the dashboard's "awaiting reply" pill: active, role detected.
      if (replyStatus === 'AWAITING_REPLY') {
        if (!status) where.status = { not: 'IGNORED' };
        where.role = { not: null };
      }
    }

    // The UI's "Last activity" column shows time-since the most recent
    // thread message, falling back to candidate.createdAt when no threads
    // exist (never updatedAt: Lever/Gem syncs bump it). Prisma can't orderBy a relation aggregate without
    // `_relationLoad`, so we over-fetch (3x the limit, capped at the
    // pagination max of 500), apply the JS sort by lastMessageAt, and
    // slice to limit. Initial orderBy stays on updatedAt so the over-fetch
    // window is a stable, candidate-recent slice rather than random.
    //
    // Trade-off: at very high candidate counts (>500) and page>1 the
    // window may not contain the globally-newest thread activity, so
    // ordering near a page boundary can drift. Acceptable until we move
    // to keyset pagination — the practical workload is well under 500.
    const overFetchTake = sort ? limit : Math.min(limit * 3, 500);
    const sortDir = dir ?? 'asc';
    const include = {
      mailbox: {
        select: { id: true, emailAddress: true, provider: true },
      },
      threads: {
        orderBy: { lastMessageAt: 'desc' as const },
        take: 1,
        select: { id: true, subject: true, lastMessageAt: true },
      },
    };

    if (sort === 'lastActivity') {
      // Latest message either way (the table's "Last activity"). Prisma can't
      // order by GREATEST(), so sort every match's timestamps here and load
      // only the page — a true global order (the candidate table is small).
      const [stamps, total] = await Promise.all([
        prisma.candidate.findMany({
          where,
          select: {
            id: true,
            lastInboundAt: true,
            lastOutboundAt: true,
            createdAt: true,
            threads: { orderBy: { lastMessageAt: 'desc' }, take: 1, select: { lastMessageAt: true } },
          },
        }),
        prisma.candidate.count({ where }),
      ]);
      // Never updatedAt: Lever/Gem syncs bump it without any message.
      const at = (c: {
        lastInboundAt: Date | null;
        lastOutboundAt: Date | null;
        createdAt: Date;
        threads: Array<{ lastMessageAt: Date }>;
      }) =>
        Math.max(c.lastInboundAt?.getTime() ?? 0, c.lastOutboundAt?.getTime() ?? 0) ||
        (c.threads[0]?.lastMessageAt ?? c.createdAt).getTime();
      const sign = sortDir === 'asc' ? 1 : -1;
      const pageIds = stamps
        .sort((a, b) => sign * (at(a) - at(b)) || a.id.localeCompare(b.id))
        .slice(skip, skip + limit)
        .map((c) => c.id);
      const rows = await prisma.candidate.findMany({ where: { id: { in: pageIds } }, include });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const data = pageIds
        .map((id) => byId.get(id))
        .filter((r): r is (typeof rows)[number] => !!r)
        .map((c) => ({ ...c, replyStatus: deriveReplyStatus(c) }));
      return res.json({ success: true, data, meta: { total, page, limit } });
    }

    // `nulls` is only accepted on nullable columns.
    const sortKey = sort && NULLABLE_SORT_COLUMNS.has(sort) ? { sort: sortDir, nulls: 'last' as const } : sortDir;
    const orderBy: Prisma.CandidateOrderByWithRelationInput[] =
      sort === 'mailbox'
        ? [{ mailbox: { emailAddress: sortDir } }, { id: 'asc' }]
        : sort === 'lever'
          ? [
              { leverPostingTitle: { sort: sortDir, nulls: 'last' } },
              { leverState: { sort: sortDir, nulls: 'last' } },
              { id: 'asc' },
            ]
          : sort
            ? [{ [sort]: sortKey } as Prisma.CandidateOrderByWithRelationInput, { id: 'asc' }]
            : [{ updatedAt: 'desc' }];

    const [candidates, total] = await Promise.all([
      prisma.candidate.findMany({
        where,
        include,
        orderBy,
        skip,
        take: overFetchTake,
      }),
      prisma.candidate.count({ where }),
    ]);

    const withStatus = candidates.map((c) => ({
      ...c,
      replyStatus: deriveReplyStatus(c),
    }));
    // An explicit sort is the DB order; otherwise sort the window by latest
    // thread activity (see over-fetch note above).
    const enriched = sort
      ? withStatus
      : withStatus
      .sort((a, b) => {
        const aTs =
          a.threads[0]?.lastMessageAt?.getTime() ??
          a.createdAt.getTime();
        const bTs =
          b.threads[0]?.lastMessageAt?.getTime() ??
          b.createdAt.getTime();
        return bTs - aTs;
      })
      .slice(0, limit);

    res.json({ success: true, data: enriched, meta: { total, page, limit } });
  } catch (err) {
    next(err);
  }
});

// POST /api/candidates/bulk  { ids, status }
// R3 bulk actions. IGNORED discards live drafts in the same transaction, as
// the single ignore does (M20).
const bulkSchema = z.object({
  ids: z.array(cuidSchema).min(1, 'ids is required').max(200, 'at most 200 candidates at once'),
  status: z.enum(CANDIDATE_STATUSES),
});

router.post('/bulk', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = bulkSchema.safeParse(req.body ?? {});
    if (!parsed.success) return next(createError(parsed.error.errors[0]?.message ?? 'Invalid body', 400));
    const ids = [...new Set(parsed.data.ids)];
    const { status } = parsed.data;

    if (status !== 'IGNORED') {
      const result = await prisma.candidate.updateMany({ where: { id: { in: ids } }, data: { status } });
      await logEvent('CANDIDATES_BULK_STATUS', { actorUserId: req.userId, count: result.count, status }, 'INFO');
      return res.json({ success: true, data: { updated: result.count, draftsDiscarded: 0 } });
    }

    const threads = await prisma.emailThread.findMany({ where: { candidateId: { in: ids } }, select: { id: true } });
    const [updated, discarded] = await prisma.$transaction([
      prisma.candidate.updateMany({ where: { id: { in: ids } }, data: { status: 'IGNORED' } }),
      prisma.emailDraft.updateMany({
        where: { threadId: { in: threads.map((t) => t.id) }, status: { in: CANCELABLE_DRAFT_STATUSES } },
        data: { status: 'DISCARDED' },
      }),
    ]);
    await logEvent(
      'CANDIDATE_IGNORED',
      { actorUserId: req.userId, count: updated.count, draftsDiscarded: discarded.count, via: 'bulk' },
      'INFO'
    );
    res.json({ success: true, data: { updated: updated.count, draftsDiscarded: discarded.count } });
  } catch (err) {
    next(err);
  }
});

// GET /api/candidates/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const candidate = await prisma.candidate.findUnique({
      where: { id },
      include: {
        mailbox: {
          select: { id: true, emailAddress: true, provider: true },
        },
        threads: {
          orderBy: { lastMessageAt: 'desc' },
          include: {
            messages: { orderBy: { receivedAt: 'asc' } },
            drafts: { orderBy: { createdAt: 'desc' } },
          },
        },
      },
    });

    if (!candidate) {
      return next(createError('Candidate not found', 404));
    }

    const data = {
      ...candidate,
      threads: candidate.threads.map((t) => ({
        ...t,
        messages: serializeEmailMessages(t.messages),
      })),
    };
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/candidates/:id
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = updateCandidateSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(createError(parsed.error.message, 400));
    }

    const id = String(req.params.id);
    const candidate = await prisma.candidate.findUnique({
      where: { id },
      include: { threads: { select: { id: true } } },
    });
    if (!candidate) {
      return next(createError('Candidate not found', 404));
    }

    const { threads, ...current } = candidate;
    const data: Prisma.CandidateUncheckedUpdateInput = { ...parsed.data };

    // Guard against email collisions explicitly so the caller gets a 409 with
    // a clear message instead of Prisma's opaque P2002 surfacing as a 500.
    // Stored lowercased and compared case-insensitively (M12).
    // The Lever match is by email, so a changed email re-checks Lever (H2).
    let emailChanged = false;
    if (parsed.data.email) {
      const email = normalizeEmail(parsed.data.email);
      data.email = email;
      if (email !== current.email.toLowerCase()) {
        emailChanged = true;
        const existing = await prisma.candidate.findFirst({
          where: { email: { equals: email, mode: 'insensitive' } },
        });
        if (existing && existing.id !== id) {
          return next(
            createError('Another candidate already uses this email', 409)
          );
        }
      }
    }

    // "Clear replied" must also reset conversation state, or the candidate
    // would still read as answered (H6).
    if (parsed.data.repliedAt === null) data.lastOutboundAt = null;

    // Choosing IGNORED from the status dropdown is the same action as the
    // ignore button: live drafts are discarded with it (M20).
    if (parsed.data.status === 'IGNORED' && current.status !== 'IGNORED') {
      const [updated, discardResult] = await prisma.$transaction([
        prisma.candidate.update({ where: { id }, data }),
        prisma.emailDraft.updateMany({
          where: {
            threadId: { in: threads.map((t) => t.id) },
            status: { in: CANCELABLE_DRAFT_STATUSES },
          },
          data: { status: 'DISCARDED' },
        }),
      ]);
      await logEvent(
        'CANDIDATE_IGNORED',
        { candidateId: id, draftsDiscarded: discardResult.count, via: 'status_change' },
        'INFO'
      );
      if (emailChanged) scheduleLeverRefresh(id, 'email_changed');
      return res.json({ success: true, data: updated });
    }

    const updated = await prisma.candidate.update({
      where: { id },
      data,
    });
    if (emailChanged) scheduleLeverRefresh(id, 'email_changed');

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/candidates/:id/ignore
// Dismiss a candidate from the dashboard. Sets status=IGNORED and atomically
// discards every live (PENDING/APPROVED) draft on the candidate's threads so
// dismissed people stop showing up in the drafts queue.
router.post('/:id/ignore', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const candidate = await prisma.candidate.findUnique({
      where: { id },
      include: { threads: { select: { id: true } } },
    });
    if (!candidate) {
      return next(createError('Candidate not found', 404));
    }

    const threadIds = candidate.threads.map((t) => t.id);

    const [updated, discardResult] = await prisma.$transaction([
      prisma.candidate.update({
        where: { id },
        data: { status: 'IGNORED' },
      }),
      prisma.emailDraft.updateMany({
        where: {
          threadId: { in: threadIds },
          status: { in: CANCELABLE_DRAFT_STATUSES },
        },
        data: { status: 'DISCARDED' },
      }),
    ]);

    await logEvent(
      'CANDIDATE_IGNORED',
      {
        candidateId: id,
        draftsDiscarded: discardResult.count,
      },
      'INFO'
    );

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/candidates/:id/unignore
// Manual undo. We lose the original classification — acceptable since this is
// a deliberate recruiter action. Reverts to NEUTRAL; the next inbound message
// will re-classify if applicable. Does NOT regenerate drafts.
router.post('/:id/unignore', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    const candidate = await prisma.candidate.findUnique({ where: { id } });
    if (!candidate) {
      return next(createError('Candidate not found', 404));
    }

    const updated = await prisma.candidate.update({
      where: { id },
      data: { status: 'NEUTRAL' },
    });

    await logEvent(
      'CANDIDATE_UNIGNORED',
      { candidateId: id },
      'INFO'
    );

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/candidates/backfill-roles
// One-shot admin action: re-classify every candidate that has role=null
// and surface the role to the Candidate row. Useful right after the Phase
// AN deploy when existing NEUTRAL/NOT_INTERESTED candidates never got
// role extracted (regenerate-pending only covers PENDING drafts).
//
// Caps at 25 per request to fit inside Vercel's function timeout — call
// repeatedly until { remaining: 0 }.
router.post('/backfill-roles', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const targets = await prisma.candidate.findMany({
      where: { role: null },
      include: {
        threads: {
          include: {
            mailbox: { select: { emailAddress: true } },
            messages: {
              orderBy: { receivedAt: 'desc' },
              take: 8,
            },
          },
          orderBy: { lastMessageAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'asc' },
      take: 25,
    });

    let updated = 0;
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const c of targets) {
      const thread = c.threads[0];
      if (!thread) {
        skipped.push({ id: c.id, reason: 'no_thread' });
        continue;
      }
      const mailboxAddr = thread.mailbox?.emailAddress?.toLowerCase() ?? '';
      // Most recent inbound message (not sent from the recruiter mailbox).
      const inbound = thread.messages.find(
        (m) => m.fromAddress.toLowerCase() !== mailboxAddr
      );
      if (!inbound) {
        skipped.push({ id: c.id, reason: 'no_inbound_message' });
        continue;
      }
      const previousMessages = thread.messages
        .filter((m) => m.receivedAt.getTime() < inbound.receivedAt.getTime())
        .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
        .map((m) => ({
          fromAddress: m.fromAddress,
          fromName: m.fromName,
          bodyText: m.bodyText,
          receivedAt: m.receivedAt,
        }));

      try {
        const result = await classifyReply(
          inbound.bodyText || inbound.bodyHtml || inbound.subject,
          inbound.fromName ?? c.name,
          { subject: thread.subject, previousMessages }
        );
        if (result.role) {
          await prisma.candidate.update({
            where: { id: c.id },
            data: { role: result.role },
          });
          await logEvent(
            'CANDIDATE_ROLE_DETECTED',
            { candidateId: c.id, role: result.role, via: 'backfill' },
            'INFO'
          );
          updated += 1;
        } else {
          skipped.push({ id: c.id, reason: 'no_role_in_classifier_output' });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        skipped.push({ id: c.id, reason: `classify_failed: ${msg}` });
      }
    }

    const remaining = await prisma.candidate.count({ where: { role: null } });
    res.json({
      success: true,
      processed: targets.length,
      updated,
      skipped,
      remaining,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../db/client';
import { createError } from '../middleware/error';
import { logEvent } from '../services/monitoring.service';
import { z } from 'zod';

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
});

// Pagination bounds — clamp `page` and `limit` so an attacker (or a buggy
// caller) can't force the server to skip past unbounded offsets or pull
// massive result sets per request.
const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function qs(val: unknown): string | undefined {
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0] as string;
  return undefined;
}

type ReplyStatus = 'NEW' | 'AWAITING_REPLY' | 'REPLIED';

function deriveReplyStatus(c: {
  repliedAt: Date | null;
  threads: Array<{ lastMessageAt: Date }>;
}): ReplyStatus {
  if (c.repliedAt) return 'REPLIED';
  if (!c.threads.length) return 'NEW';
  return 'AWAITING_REPLY';
}

// GET /api/candidates
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = qs(req.query.status);
    const mailboxId = qs(req.query.mailboxId);
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

    const where: Record<string, unknown> = {};
    if (status) {
      where.status = status;
    } else if (!includeIgnored) {
      // Default view hides ignored candidates so dismissed people don't clutter
      // the dashboard. Caller can pass ?status=IGNORED or ?includeIgnored=true
      // to see them.
      where.status = { not: 'IGNORED' };
    }
    if (mailboxId) where.mailboxId = mailboxId;

    const [candidates, total] = await Promise.all([
      prisma.candidate.findMany({
        where,
        include: {
          mailbox: {
            select: { id: true, emailAddress: true, provider: true },
          },
          threads: {
            orderBy: { lastMessageAt: 'desc' },
            take: 1,
            select: { id: true, subject: true, lastMessageAt: true },
          },
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.candidate.count({ where }),
    ]);

    const enriched = candidates.map((c) => ({
      ...c,
      replyStatus: deriveReplyStatus(c),
    }));

    res.json({ success: true, data: enriched, meta: { total, page, limit } });
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

    res.json({ success: true, data: candidate });
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
    const candidate = await prisma.candidate.findUnique({ where: { id } });
    if (!candidate) {
      return next(createError('Candidate not found', 404));
    }

    const updated = await prisma.candidate.update({
      where: { id },
      data: parsed.data,
    });

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
          status: { in: ['PENDING', 'APPROVED'] },
        },
        data: { status: 'DISCARDED' },
      }),
    ]);

    await logEvent(
      'CANDIDATE_IGNORED',
      {
        candidateId: id,
        email: candidate.email,
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
      { candidateId: id, email: candidate.email },
      'INFO'
    );

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

export default router;

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../db/client';
import { createError } from '../middleware/error';
import { z } from 'zod';

const router = Router();

function qs(val: unknown): string | undefined {
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && typeof val[0] === 'string') return val[0] as string;
  return undefined;
}

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// GET /api/emails/threads
router.get('/threads', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const mailboxId = qs(req.query.mailboxId);
    const candidateId = qs(req.query.candidateId);
    const paged = paginationSchema.safeParse({
      page: qs(req.query.page),
      limit: qs(req.query.limit),
    });
    if (!paged.success) {
      return next(createError(paged.error.message, 400));
    }
    const { page, limit } = paged.data;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (mailboxId) where.mailboxId = mailboxId;
    if (candidateId) where.candidateId = candidateId;

    const [threads, total] = await Promise.all([
      prisma.emailThread.findMany({
        where,
        include: {
          candidate: {
            select: { id: true, name: true, email: true, status: true },
          },
          mailbox: {
            select: { id: true, emailAddress: true, provider: true },
          },
          _count: { select: { messages: true, drafts: true } },
        },
        orderBy: { lastMessageAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.emailThread.count({ where }),
    ]);

    res.json({ success: true, data: threads, meta: { total, page, limit } });
  } catch (err) {
    next(err);
  }
});

// GET /api/emails/threads/:id/messages
router.get(
  '/threads/:id/messages',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const thread = await prisma.emailThread.findUnique({
        where: { id },
        include: {
          messages: { orderBy: { receivedAt: 'asc' } },
          drafts: { orderBy: { createdAt: 'desc' } },
          candidate: {
            select: { id: true, name: true, email: true, status: true },
          },
          mailbox: {
            select: { id: true, emailAddress: true, provider: true },
          },
        },
      });

      if (!thread) {
        return next(createError('Thread not found', 404));
      }

      res.json({ success: true, data: thread });
    } catch (err) {
      next(err);
    }
  }
);

export default router;

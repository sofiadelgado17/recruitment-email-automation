import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

import { buildPrismaMock, resetPrismaMock, type MockPrisma } from '../_setup/mockPrisma';
import { loadApp, bearer } from '../_setup/testApp';

vi.mock('../../src/db/client', () => {
  const prisma = buildPrismaMock();
  // Field reference used by the reply-status filter.
  (prisma.candidate as unknown as { fields: unknown }).fields = {
    lastOutboundAt: { name: 'lastOutboundAt', modelName: 'Candidate' },
  };
  return { prisma, default: prisma };
});

import { prisma as injectedPrisma } from '../../src/db/client';
const mockPrisma = injectedPrisma as unknown as MockPrisma;

const AUTH = bearer('test-user-1');
const ID_A = 'ckaaaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'ckbbbbbbbbbbbbbbbbbbbbbbb';

type FindManyArgs = { where?: Record<string, unknown>; orderBy?: unknown; select?: unknown; take?: number; skip?: number };
const findManyArgs = (i = 0) => mockPrisma.candidate.findMany.mock.calls[i]![0] as FindManyArgs;

describe('/api/candidates — R3 (search + filters, sort columns, bulk)', () => {
  let app: Awaited<ReturnType<typeof loadApp>>;

  beforeEach(async () => {
    resetPrismaMock(mockPrisma);
    app = await loadApp();
  });

  describe('GET /api/candidates search', () => {
    beforeEach(() => {
      mockPrisma.candidate.findMany.mockResolvedValue([]);
      mockPrisma.candidate.count.mockResolvedValue(0);
    });

    it('keeps the status, lever and replyStatus filters while searching', async () => {
      await request(app)
        .get('/api/candidates?search=ada&status=INTERESTED&lever=NOT_IN&replyStatus=AWAITING_REPLY')
        .set('Authorization', AUTH)
        .expect(200);
      const where = findManyArgs().where!;
      expect(where.status).toBe('INTERESTED');
      expect(where.leverState).toBe('NOT_FOUND');
      expect(where.OR).toEqual([
        { name: { contains: 'ada', mode: 'insensitive' } },
        { email: { contains: 'ada', mode: 'insensitive' } },
      ]);
      expect(where.AND).toBeDefined();
    });

    it('hides IGNORED while searching unless includeIgnored=true', async () => {
      await request(app).get('/api/candidates?search=ada').set('Authorization', AUTH).expect(200);
      expect(findManyArgs(0).where!.status).toEqual({ not: 'IGNORED' });
      await request(app).get('/api/candidates?search=ada&includeIgnored=true').set('Authorization', AUTH).expect(200);
      expect(findManyArgs(1).where!.status).toBeUndefined();
    });
  });

  describe('GET /api/candidates sort columns', () => {
    beforeEach(() => {
      mockPrisma.candidate.findMany.mockResolvedValue([]);
      mockPrisma.candidate.count.mockResolvedValue(0);
    });

    it('sort=mailbox orders by the mailbox address', async () => {
      await request(app).get('/api/candidates?sort=mailbox&dir=desc').set('Authorization', AUTH).expect(200);
      expect(findManyArgs().orderBy).toEqual([{ mailbox: { emailAddress: 'desc' } }, { id: 'asc' }]);
    });

    it('sort=lever orders by job then Lever state, nulls last', async () => {
      await request(app).get('/api/candidates?sort=lever&dir=asc').set('Authorization', AUTH).expect(200);
      expect(findManyArgs().orderBy).toEqual([
        { leverPostingTitle: { sort: 'asc', nulls: 'last' } },
        { leverState: { sort: 'asc', nulls: 'last' } },
        { id: 'asc' },
      ]);
    });

    it('sort=lastActivity sorts every match by latest in/out message, then loads one page', async () => {
      const t = (h: number) => new Date(Date.UTC(2026, 9, 1, h));
      mockPrisma.candidate.findMany.mockReset();
      mockPrisma.candidate.findMany
        .mockResolvedValueOnce([
          { id: 'old', lastInboundAt: t(1), lastOutboundAt: null, threads: [], createdAt: t(0) },
          { id: 'new', lastInboundAt: t(2), lastOutboundAt: t(9), threads: [], createdAt: t(0) },
          // No in/out stamps: latest thread message, else createdAt — never
          // updatedAt, which Lever/Gem syncs bump.
          { id: 'none', lastInboundAt: null, lastOutboundAt: null, threads: [{ lastMessageAt: t(5) }], createdAt: t(0) },
          { id: 'fresh', lastInboundAt: null, lastOutboundAt: null, threads: [], createdAt: t(0), updatedAt: t(23) },
        ])
        .mockResolvedValueOnce([
          { id: 'none', threads: [], updatedAt: t(5) },
          { id: 'new', threads: [], updatedAt: t(1) },
        ]);
      mockPrisma.candidate.count.mockResolvedValueOnce(4);

      const res = await request(app)
        .get('/api/candidates?sort=lastActivity&dir=desc&limit=2')
        .set('Authorization', AUTH)
        .expect(200);

      expect(findManyArgs(0).select).toEqual({
        id: true,
        lastInboundAt: true,
        lastOutboundAt: true,
        createdAt: true,
        threads: { orderBy: { lastMessageAt: 'desc' }, take: 1, select: { lastMessageAt: true } },
      });
      expect(findManyArgs(1).where).toEqual({ id: { in: ['new', 'none'] } });
      expect(res.body.data.map((c: { id: string }) => c.id)).toEqual(['new', 'none']);
      expect(res.body.meta).toEqual({ total: 4, page: 1, limit: 2 });
    });
  });

  describe('POST /api/candidates/bulk', () => {
    it('sets a status on every id', async () => {
      mockPrisma.candidate.updateMany.mockResolvedValueOnce({ count: 2 });
      const res = await request(app)
        .post('/api/candidates/bulk')
        .set('Authorization', AUTH)
        .send({ ids: [ID_A, ID_B], status: 'INTERESTED' })
        .expect(200);
      expect(mockPrisma.candidate.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [ID_A, ID_B] } },
        data: { status: 'INTERESTED' },
      });
      expect(res.body.data).toEqual({ updated: 2, draftsDiscarded: 0 });
    });

    it('IGNORED discards live drafts in the same transaction', async () => {
      mockPrisma.emailThread.findMany.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]);
      mockPrisma.candidate.updateMany.mockReturnValueOnce('update-op' as never);
      mockPrisma.emailDraft.updateMany.mockReturnValueOnce('discard-op' as never);
      mockPrisma.$transaction.mockResolvedValueOnce([{ count: 2 }, { count: 3 }]);

      const res = await request(app)
        .post('/api/candidates/bulk')
        .set('Authorization', AUTH)
        .send({ ids: [ID_A, ID_B], status: 'IGNORED' })
        .expect(200);

      expect(mockPrisma.$transaction).toHaveBeenCalledWith(['update-op', 'discard-op']);
      const discard = mockPrisma.emailDraft.updateMany.mock.calls[0]![0] as { where: { threadId: unknown }; data: unknown };
      expect(discard.where.threadId).toEqual({ in: ['t1', 't2'] });
      expect(discard.data).toEqual({ status: 'DISCARDED' });
      expect(res.body.data).toEqual({ updated: 2, draftsDiscarded: 3 });
    });

    it('rejects an empty list, more than 200 ids, or an unknown status', async () => {
      const post = (body: unknown) => request(app).post('/api/candidates/bulk').set('Authorization', AUTH).send(body as object);
      expect((await post({ ids: [], status: 'INTERESTED' })).status).toBe(400);
      expect((await post({ ids: Array.from({ length: 201 }, () => ID_A), status: 'INTERESTED' })).status).toBe(400);
      expect((await post({ ids: [ID_A], status: 'MAYBE' })).status).toBe(400);
      expect(mockPrisma.candidate.updateMany).not.toHaveBeenCalled();
    });

    it('requires auth', async () => {
      const res = await request(app).post('/api/candidates/bulk').send({ ids: [ID_A], status: 'INTERESTED' });
      expect(res.status).toBe(401);
    });
  });
});

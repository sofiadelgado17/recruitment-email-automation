import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

import { buildPrismaMock, resetPrismaMock, type MockPrisma } from '../_setup/mockPrisma';
import { loadApp, bearer } from '../_setup/testApp';

vi.mock('../../src/db/client', () => {
  const prisma = buildPrismaMock();
  return { prisma, default: prisma };
});

import { prisma as injectedPrisma } from '../../src/db/client';
const mockPrisma = injectedPrisma as unknown as MockPrisma;

const AUTH = bearer('test-user-1');

describe('/api/candidates', () => {
  let app: Awaited<ReturnType<typeof loadApp>>;

  beforeEach(async () => {
    resetPrismaMock(mockPrisma);
    app = await loadApp();
  });

  describe('GET /api/candidates', () => {
    it('returns 401 without an Authorization header', async () => {
      const res = await request(app).get('/api/candidates');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      // Should not have touched prisma — auth middleware short-circuited.
      expect(mockPrisma.candidate.findMany).not.toHaveBeenCalled();
    });

    it('returns a paginated list when authenticated', async () => {
      const now = new Date('2026-05-01T00:00:00Z');
      const rows = [
        {
          id: 'cand-1',
          email: 'a@example.com',
          name: 'A',
          status: 'PENDING',
          mailboxId: 'mb-1',
          mailbox: { id: 'mb-1', emailAddress: 'inbox@archive.com', provider: 'GMAIL' },
          threads: [],
          repliedAt: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'cand-2',
          email: 'b@example.com',
          name: 'B',
          status: 'INTERESTED',
          mailboxId: 'mb-1',
          mailbox: { id: 'mb-1', emailAddress: 'inbox@archive.com', provider: 'GMAIL' },
          threads: [{ id: 't-1', subject: 'hi', lastMessageAt: now }],
          repliedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ];
      mockPrisma.candidate.findMany.mockResolvedValueOnce(rows);
      mockPrisma.candidate.count.mockResolvedValueOnce(2);

      const res = await request(app)
        .get('/api/candidates?page=1&limit=20')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta).toEqual({ total: 2, page: 1, limit: 20 });
      // replyStatus is derived in the route.
      expect(res.body.data[0].replyStatus).toBe('NEW');
      expect(res.body.data[1].replyStatus).toBe('AWAITING_REPLY');
      // Default view hides IGNORED candidates.
      expect(mockPrisma.candidate.findMany).toHaveBeenCalledTimes(1);
      const args = mockPrisma.candidate.findMany.mock.calls[0]?.[0] as {
        where?: { status?: unknown };
        skip?: number;
        take?: number;
      };
      expect(args?.where?.status).toEqual({ not: 'IGNORED' });
      expect(args?.skip).toBe(0);
      // Phase AR bug #5: route over-fetches 3x the limit so it can JS-sort
      // by latest-thread lastMessageAt without forcing a relation orderBy.
      expect(args?.take).toBe(60);
    });

    it('rejects page=0 with 400 (zod pagination bounds)', async () => {
      const res = await request(app)
        .get('/api/candidates?page=0')
        .set('Authorization', AUTH);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(mockPrisma.candidate.findMany).not.toHaveBeenCalled();
    });

    it('sorts by latest thread.lastMessageAt (Phase AR bug #5), not just updatedAt', async () => {
      // Candidate A has a stale updatedAt but a fresh thread message;
      // Candidate B has a fresh updatedAt but a stale thread message.
      // The "Last activity" column in the UI shows time since the most
      // recent thread message — so A should come first.
      const oldDate = new Date('2026-04-01T00:00:00Z');
      const newDate = new Date('2026-05-20T00:00:00Z');

      const candA = {
        id: 'cand-A',
        email: 'a@example.com',
        name: 'A',
        status: 'PENDING',
        mailboxId: 'mb-1',
        mailbox: { id: 'mb-1', emailAddress: 'inbox@archive.com', provider: 'GMAIL' },
        threads: [{ id: 't-A', subject: 'recent', lastMessageAt: newDate }],
        repliedAt: null,
        updatedAt: oldDate,
      };
      const candB = {
        id: 'cand-B',
        email: 'b@example.com',
        name: 'B',
        status: 'PENDING',
        mailboxId: 'mb-1',
        mailbox: { id: 'mb-1', emailAddress: 'inbox@archive.com', provider: 'GMAIL' },
        threads: [{ id: 't-B', subject: 'older', lastMessageAt: oldDate }],
        repliedAt: null,
        updatedAt: newDate,
      };

      // Prisma returns the over-fetched window in updatedAt-desc order, so B
      // is first off the wire. The route's JS sort should flip them so A
      // (fresher thread activity) appears first.
      mockPrisma.candidate.findMany.mockResolvedValueOnce([candB, candA]);
      mockPrisma.candidate.count.mockResolvedValueOnce(2);

      const res = await request(app)
        .get('/api/candidates?page=1&limit=20')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].id).toBe('cand-A');
      expect(res.body.data[1].id).toBe('cand-B');
    });

    it('falls back to createdAt (never updatedAt) for candidates with no threads', async () => {
      // A: no threads, created long ago but updatedAt fresh from a Lever/Gem
      // sync. B: a thread with a newer lastMessageAt than A's createdAt.
      // The sort uses createdAt for A, so B comes first.
      const oldDate = new Date('2026-04-01T00:00:00Z');
      const newDate = new Date('2026-05-20T00:00:00Z');
      const created = new Date('2026-03-01T00:00:00Z');

      const candA = {
        id: 'cand-A',
        email: 'a@example.com',
        name: 'A',
        status: 'PENDING',
        mailboxId: 'mb-1',
        mailbox: { id: 'mb-1', emailAddress: 'inbox@archive.com', provider: 'GMAIL' },
        threads: [],
        repliedAt: null,
        createdAt: created,
        updatedAt: newDate,
      };
      const candB = {
        id: 'cand-B',
        email: 'b@example.com',
        name: 'B',
        status: 'PENDING',
        mailboxId: 'mb-1',
        mailbox: { id: 'mb-1', emailAddress: 'inbox@archive.com', provider: 'GMAIL' },
        threads: [{ id: 't-B', subject: 'older', lastMessageAt: oldDate }],
        repliedAt: null,
        createdAt: created,
        updatedAt: oldDate,
      };

      mockPrisma.candidate.findMany.mockResolvedValueOnce([candA, candB]);
      mockPrisma.candidate.count.mockResolvedValueOnce(2);

      const res = await request(app)
        .get('/api/candidates?page=1&limit=20')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.data[0].id).toBe('cand-B');
      expect(res.body.data[1].id).toBe('cand-A');
    });

    it('includes role when present on the candidate row', async () => {
      const now = new Date('2026-05-01T00:00:00Z');
      const rows = [
        {
          id: 'cand-3',
          email: 'c@example.com',
          name: 'C',
          role: 'Senior Backend Engineer',
          status: 'INTERESTED',
          mailboxId: 'mb-1',
          mailbox: { id: 'mb-1', emailAddress: 'inbox@archive.com', provider: 'GMAIL' },
          threads: [],
          repliedAt: null,
          updatedAt: now,
        },
      ];
      mockPrisma.candidate.findMany.mockResolvedValueOnce(rows);
      mockPrisma.candidate.count.mockResolvedValueOnce(1);

      const res = await request(app)
        .get('/api/candidates?page=1&limit=20')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.data[0].role).toBe('Senior Backend Engineer');
    });
  });

  describe('PATCH /api/candidates/:id', () => {
    it('rejects an unknown status enum value with 400', async () => {
      const res = await request(app)
        .patch('/api/candidates/cand-1')
        .set('Authorization', AUTH)
        .send({ status: 'INVALID_STATUS' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      // Validation should reject before any DB lookup happens.
      expect(mockPrisma.candidate.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.candidate.update).not.toHaveBeenCalled();
    });

    it('updates a candidate when the payload is valid', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValueOnce({
        id: 'cand-1',
        email: 'a@example.com',
        status: 'PENDING',
      });
      mockPrisma.candidate.update.mockResolvedValueOnce({
        id: 'cand-1',
        email: 'a@example.com',
        status: 'INTERESTED',
      });

      const res = await request(app)
        .patch('/api/candidates/cand-1')
        .set('Authorization', AUTH)
        .send({ status: 'INTERESTED' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('INTERESTED');
      expect(mockPrisma.candidate.update).toHaveBeenCalledWith({
        where: { id: 'cand-1' },
        data: { status: 'INTERESTED' },
      });
    });
  });

  describe('POST /api/candidates/:id/ignore', () => {
    it('sets status=IGNORED and discards live drafts atomically via $transaction', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValueOnce({
        id: 'cand-1',
        email: 'a@example.com',
        status: 'PENDING',
        threads: [{ id: 't-1' }, { id: 't-2' }],
      });
      // $transaction([updateCandidate, updateManyDrafts]) → [updatedCandidate, { count }]
      mockPrisma.$transaction.mockResolvedValueOnce([
        { id: 'cand-1', email: 'a@example.com', status: 'IGNORED' },
        { count: 3 },
      ]);

      const res = await request(app)
        .post('/api/candidates/cand-1/ignore')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('IGNORED');
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      // The route should have prepared two operations: the candidate update and
      // the draft discard updateMany. Each shows up as a call on the model
      // method when passed through $transaction([ ... ]).
      expect(mockPrisma.candidate.update).toHaveBeenCalledWith({
        where: { id: 'cand-1' },
        data: { status: 'IGNORED' },
      });
      expect(mockPrisma.emailDraft.updateMany).toHaveBeenCalledWith({
        where: {
          threadId: { in: ['t-1', 't-2'] },
          status: { in: ['PENDING', 'APPROVED', 'SCHEDULED', 'FAILED'] },
        },
        data: { status: 'DISCARDED' },
      });
    });

    it('returns 404 when the candidate does not exist', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/api/candidates/missing/ignore')
        .set('Authorization', AUTH);

      expect(res.status).toBe(404);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/candidates/:id/unignore', () => {
    it('reverts status to NEUTRAL', async () => {
      mockPrisma.candidate.findUnique.mockResolvedValueOnce({
        id: 'cand-1',
        email: 'a@example.com',
        status: 'IGNORED',
      });
      mockPrisma.candidate.update.mockResolvedValueOnce({
        id: 'cand-1',
        email: 'a@example.com',
        status: 'NEUTRAL',
      });

      const res = await request(app)
        .post('/api/candidates/cand-1/unignore')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('NEUTRAL');
      expect(mockPrisma.candidate.update).toHaveBeenCalledWith({
        where: { id: 'cand-1' },
        data: { status: 'NEUTRAL' },
      });
    });
  });
});

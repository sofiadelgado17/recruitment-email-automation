import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

import { buildPrismaMock, resetPrismaMock, type MockPrisma } from '../_setup/mockPrisma';
import { loadApp, bearer } from '../_setup/testApp';

// Hoisted Gmail + Claude service mocks. /approve and /send go through
// `createDraft` and `sendDraft` from `services/gmail.service`; the regenerate
// path goes through `classifyReply` and `generateDraftReply` from
// `services/claude.service`. We stub all four at the import boundary so the
// tests don't reach real Google or Anthropic APIs.
const { createDraft, sendDraft, classifyReply, generateDraftReply } = vi.hoisted(() => ({
  createDraft: vi.fn(),
  sendDraft: vi.fn(),
  classifyReply: vi.fn(),
  generateDraftReply: vi.fn(),
}));

vi.mock('../../src/services/gmail.service', async () => {
  // Preserve unrelated exports the rest of the app pulls from gmail.service
  // (`handleCallback`, `watchMailbox`, etc.) — those modules are imported
  // transitively by app.ts even though our tests don't hit them.
  const actual = await vi.importActual<typeof import('../../src/services/gmail.service')>(
    '../../src/services/gmail.service'
  );
  return {
    ...actual,
    createDraft,
    sendDraft,
  };
});

vi.mock('../../src/services/claude.service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/claude.service')>(
    '../../src/services/claude.service'
  );
  return {
    ...actual,
    classifyReply,
    generateDraftReply,
  };
});

vi.mock('../../src/db/client', () => {
  const prisma = buildPrismaMock();
  return { prisma, default: prisma };
});

import { prisma as injectedPrisma } from '../../src/db/client';
const mockPrisma = injectedPrisma as unknown as MockPrisma;

const AUTH = bearer('test-user-1');

const baseMailbox = {
  id: 'mb-1',
  emailAddress: 'inbox@archive.com',
  displayName: 'Inbox',
  provider: 'GMAIL',
  isActive: true,
};
const baseCandidate = {
  id: 'cand-1',
  name: 'Candidate A',
  email: 'a@example.com',
};
const baseThread = {
  id: 'thread-1',
  externalThreadId: 'ext-thread-1',
  subject: 'Re: opportunity',
  mailbox: baseMailbox,
  candidate: baseCandidate,
};

function pendingDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: 'draft-1',
    status: 'PENDING',
    subject: 'Re: opportunity',
    bodyText: 'hello',
    bodyHtml: null,
    externalDraftId: null,
    inReplyToMessageId: null,
    referencesHeader: null,
    thread: baseThread,
    ...overrides,
  };
}

describe('/api/drafts', () => {
  let app: Awaited<ReturnType<typeof loadApp>>;

  beforeEach(async () => {
    resetPrismaMock(mockPrisma);
    createDraft.mockReset();
    sendDraft.mockReset();
    classifyReply.mockReset();
    generateDraftReply.mockReset();
    app = await loadApp();
  });

  describe('GET /api/drafts', () => {
    it('returns 401 without an Authorization header', async () => {
      const res = await request(app).get('/api/drafts');
      expect(res.status).toBe(401);
      expect(mockPrisma.emailDraft.findMany).not.toHaveBeenCalled();
    });

    it('returns a paginated list when authenticated', async () => {
      const now = new Date('2026-05-01T00:00:00Z');
      mockPrisma.emailDraft.findMany.mockResolvedValueOnce([
        {
          id: 'draft-1',
          status: 'PENDING',
          subject: 'Re: opportunity',
          createdAt: now,
          inReplyToMessageId: null,
          thread: {
            id: 'thread-1',
            mailbox: { ...baseMailbox },
            candidate: { id: 'cand-1', name: 'A', email: 'a@example.com' },
            messages: [
              {
                id: 'msg-1',
                externalMessageId: 'gm-1',
                fromAddress: 'a@example.com',
                fromName: 'A',
                subject: 'opportunity',
                bodyText: 'hi',
                bodyHtml: null,
                receivedAt: now,
              },
            ],
          },
        },
      ]);
      mockPrisma.emailDraft.count.mockResolvedValueOnce(1);

      const res = await request(app)
        .get('/api/drafts?page=1&limit=10')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.meta).toEqual({ total: 1, page: 1, limit: 10 });
      // List view strips bulk messages from the response.
      expect(res.body.data[0].thread.messages).toBeUndefined();
      expect(res.body.data[0].originalMessage).toMatchObject({
        fromAddress: 'a@example.com',
      });
    });

    it('orders the PENDING queue by the thread lastMessageAt ascending (longest-waiting first)', async () => {
      mockPrisma.emailDraft.findMany.mockResolvedValueOnce([]);
      mockPrisma.emailDraft.count.mockResolvedValueOnce(0);

      const res = await request(app)
        .get('/api/drafts?status=PENDING')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(mockPrisma.emailDraft.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { thread: { lastMessageAt: 'asc' } },
        })
      );
    });

    it('keeps the APPROVED list ordered by createdAt descending', async () => {
      mockPrisma.emailDraft.findMany.mockResolvedValueOnce([]);
      mockPrisma.emailDraft.count.mockResolvedValueOnce(0);

      const res = await request(app)
        .get('/api/drafts?status=APPROVED')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(mockPrisma.emailDraft.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
        })
      );
    });

    it('keeps the unfiltered list ordered by createdAt descending', async () => {
      mockPrisma.emailDraft.findMany.mockResolvedValueOnce([]);
      mockPrisma.emailDraft.count.mockResolvedValueOnce(0);

      const res = await request(app).get('/api/drafts').set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(mockPrisma.emailDraft.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
        })
      );
    });
  });

  describe('POST /api/drafts/:id/approve', () => {
    it('creates a Gmail draft and marks the row APPROVED for a PENDING Gmail draft', async () => {
      mockPrisma.emailDraft.findUnique.mockResolvedValueOnce(pendingDraft());
      createDraft.mockResolvedValueOnce('ext-draft-1');
      mockPrisma.emailDraft.update.mockResolvedValueOnce({
        id: 'draft-1',
        status: 'APPROVED',
        externalDraftId: 'ext-draft-1',
      });

      const res = await request(app)
        .post('/api/drafts/draft-1/approve')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(createDraft).toHaveBeenCalledTimes(1);
      expect(createDraft).toHaveBeenCalledWith(
        'mb-1',
        expect.objectContaining({
          threadId: 'thread-1',
          externalThreadId: 'ext-thread-1',
          toAddress: 'a@example.com',
        })
      );
      expect(mockPrisma.emailDraft.update).toHaveBeenCalledWith({
        where: { id: 'draft-1' },
        data: { status: 'APPROVED', externalDraftId: 'ext-draft-1' },
      });
    });

    it('returns 400 when the draft is not PENDING', async () => {
      mockPrisma.emailDraft.findUnique.mockResolvedValueOnce(
        pendingDraft({ status: 'SENT' })
      );

      const res = await request(app)
        .post('/api/drafts/draft-1/approve')
        .set('Authorization', AUTH);

      expect(res.status).toBe(400);
      expect(createDraft).not.toHaveBeenCalled();
      expect(mockPrisma.emailDraft.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/drafts/:id/discard', () => {
    it('updates the row to DISCARDED', async () => {
      mockPrisma.emailDraft.findUnique.mockResolvedValueOnce({
        id: 'draft-1',
        status: 'PENDING',
      });
      mockPrisma.emailDraft.update.mockResolvedValueOnce({
        id: 'draft-1',
        status: 'DISCARDED',
      });

      const res = await request(app)
        .post('/api/drafts/draft-1/discard')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(mockPrisma.emailDraft.update).toHaveBeenCalledWith({
        where: { id: 'draft-1' },
        data: { status: 'DISCARDED' },
      });
    });

    it('refuses to discard a SENT draft (400)', async () => {
      mockPrisma.emailDraft.findUnique.mockResolvedValueOnce({
        id: 'draft-1',
        status: 'SENT',
      });

      const res = await request(app)
        .post('/api/drafts/draft-1/discard')
        .set('Authorization', AUTH);

      expect(res.status).toBe(400);
      expect(mockPrisma.emailDraft.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/drafts/:id/send', () => {
    it('sends via Gmail and then marks the row SENT', async () => {
      mockPrisma.emailDraft.findUnique.mockResolvedValueOnce(
        pendingDraft({ status: 'APPROVED', externalDraftId: 'ext-draft-1' })
      );
      sendDraft.mockResolvedValueOnce(undefined);
      mockPrisma.emailDraft.update.mockResolvedValueOnce({
        id: 'draft-1',
        status: 'SENT',
        sentAt: new Date('2026-05-01T00:00:00Z'),
      });
      mockPrisma.candidate.update.mockResolvedValueOnce({
        id: 'cand-1',
        status: 'REPLIED',
      });

      const res = await request(app)
        .post('/api/drafts/draft-1/send')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Ordering matters: Gmail send must succeed before DB transitions to SENT.
      const sendCallOrder = sendDraft.mock.invocationCallOrder[0]!;
      const dbUpdateCallOrder = mockPrisma.emailDraft.update.mock.invocationCallOrder[0]!;
      expect(sendCallOrder).toBeLessThan(dbUpdateCallOrder);
      expect(sendDraft).toHaveBeenCalledWith('mb-1', 'ext-draft-1');
      expect(mockPrisma.emailDraft.update).toHaveBeenCalledWith({
        where: { id: 'draft-1' },
        data: { status: 'SENT', sentAt: expect.any(Date) },
      });
      // Candidate transitions to REPLIED after a successful send.
      expect(mockPrisma.candidate.update).toHaveBeenCalledWith({
        where: { id: 'cand-1' },
        data: { status: 'REPLIED', repliedAt: expect.any(Date) },
      });
    });

    it('does NOT mark the row SENT when the Gmail send throws (atomicity)', async () => {
      mockPrisma.emailDraft.findUnique.mockResolvedValueOnce(
        pendingDraft({ status: 'APPROVED', externalDraftId: 'ext-draft-1' })
      );
      sendDraft.mockRejectedValueOnce(new Error('Gmail API exploded'));

      const res = await request(app)
        .post('/api/drafts/draft-1/send')
        .set('Authorization', AUTH);

      expect(res.status).toBe(500);
      expect(sendDraft).toHaveBeenCalledTimes(1);
      // The row must NOT have been transitioned to SENT — Phase T's fix
      // ensures the DB stays in its pre-send status when the API call fails.
      expect(mockPrisma.emailDraft.update).not.toHaveBeenCalled();
      expect(mockPrisma.candidate.update).not.toHaveBeenCalled();
    });

    it('rejects sending a non-APPROVED draft with 400', async () => {
      mockPrisma.emailDraft.findUnique.mockResolvedValueOnce(
        pendingDraft({ status: 'PENDING' })
      );

      const res = await request(app)
        .post('/api/drafts/draft-1/send')
        .set('Authorization', AUTH);

      expect(res.status).toBe(400);
      expect(sendDraft).not.toHaveBeenCalled();
      expect(mockPrisma.emailDraft.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/drafts/:id/regenerate', () => {
    it('returns 400 when the draft is not in PENDING status', async () => {
      mockPrisma.emailDraft.findUnique.mockResolvedValueOnce({
        id: 'draft-1',
        status: 'APPROVED',
        thread: {
          ...baseThread,
          messages: [],
        },
        inReplyToMessageId: null,
      });

      const res = await request(app)
        .post('/api/drafts/draft-1/regenerate')
        .set('Authorization', AUTH);

      expect(res.status).toBe(400);
      // Should never touch Claude.
      expect(classifyReply).not.toHaveBeenCalled();
      expect(generateDraftReply).not.toHaveBeenCalled();
    });

    it('logs CANDIDATE_ROLE_CHANGED when classifier role differs from stored role', async () => {
      // Phase AR bug #3: observability for role churn on regen. Candidate
      // already has role='Backend Engineer'; classifier returns
      // role='Staff Backend Engineer'. The update logic intentionally keeps
      // the existing role (don't churn on every follow-up), but we want a
      // log entry so unexpected swings are auditable.
      const inboundDate = new Date('2026-04-01T00:00:00Z');
      const inbound = {
        id: 'msg-1',
        externalMessageId: 'gm-1',
        fromAddress: 'a@example.com',
        fromName: 'A',
        subject: 'opportunity',
        bodyText: 'are you interested?',
        bodyHtml: null,
        receivedAt: inboundDate,
      };

      mockPrisma.emailDraft.findUnique.mockResolvedValueOnce({
        id: 'draft-1',
        status: 'PENDING',
        inReplyToMessageId: null,
        updatedAt: inboundDate,
        thread: {
          ...baseThread,
          candidate: { ...baseCandidate, role: 'Backend Engineer' },
          messages: [inbound],
        },
      });
      mockPrisma.emailMessage.findMany.mockResolvedValueOnce([inbound]);

      classifyReply.mockResolvedValueOnce({
        classification: 'INTERESTED',
        confidence: 0.9,
        role: 'Staff Backend Engineer',
      });
      generateDraftReply.mockResolvedValueOnce({
        subject: 'Re: opportunity',
        bodyText: 'thanks!',
        bodyHtml: '<p>thanks!</p>',
      });
      mockPrisma.emailDraft.update.mockResolvedValueOnce({
        id: 'draft-1',
        status: 'PENDING',
      });

      const res = await request(app)
        .post('/api/drafts/draft-1/regenerate')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);

      // The CANDIDATE_ROLE_DETECTED branch (role && !candidate.role) should
      // NOT fire — candidate already has a role.
      const detectedCalls = mockPrisma.systemLog.create.mock.calls.filter(
        ([arg]) =>
          (arg as { data: { event: string } }).data.event === 'CANDIDATE_ROLE_DETECTED'
      );
      expect(detectedCalls).toHaveLength(0);
      // Also: we should NOT have updated candidate.role.
      expect(mockPrisma.candidate.update).not.toHaveBeenCalled();

      // But CANDIDATE_ROLE_CHANGED SHOULD fire with both old and new values.
      const changedCalls = mockPrisma.systemLog.create.mock.calls.filter(
        ([arg]) =>
          (arg as { data: { event: string } }).data.event === 'CANDIDATE_ROLE_CHANGED'
      );
      expect(changedCalls).toHaveLength(1);
      const detailsJson = (changedCalls[0]![0] as {
        data: { details: string | null };
      }).data.details;
      const details = JSON.parse(detailsJson ?? '{}');
      expect(details).toMatchObject({
        candidateId: 'cand-1',
        from: 'Backend Engineer',
        to: 'Staff Backend Engineer',
        via: 'regenerate',
      });
    });

    it('does NOT log CANDIDATE_ROLE_CHANGED when classifier returns the same role', async () => {
      const inboundDate = new Date('2026-04-01T00:00:00Z');
      const inbound = {
        id: 'msg-1',
        externalMessageId: 'gm-1',
        fromAddress: 'a@example.com',
        fromName: 'A',
        subject: 'opportunity',
        bodyText: 'are you interested?',
        bodyHtml: null,
        receivedAt: inboundDate,
      };

      mockPrisma.emailDraft.findUnique.mockResolvedValueOnce({
        id: 'draft-1',
        status: 'PENDING',
        inReplyToMessageId: null,
        updatedAt: inboundDate,
        thread: {
          ...baseThread,
          candidate: { ...baseCandidate, role: 'Backend Engineer' },
          messages: [inbound],
        },
      });
      mockPrisma.emailMessage.findMany.mockResolvedValueOnce([inbound]);

      classifyReply.mockResolvedValueOnce({
        classification: 'INTERESTED',
        confidence: 0.9,
        role: 'Backend Engineer',
      });
      generateDraftReply.mockResolvedValueOnce({
        subject: 'Re: opportunity',
        bodyText: 'thanks!',
        bodyHtml: '<p>thanks!</p>',
      });
      mockPrisma.emailDraft.update.mockResolvedValueOnce({
        id: 'draft-1',
        status: 'PENDING',
      });

      const res = await request(app)
        .post('/api/drafts/draft-1/regenerate')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);

      const changedCalls = mockPrisma.systemLog.create.mock.calls.filter(
        ([arg]) =>
          (arg as { data: { event: string } }).data.event === 'CANDIDATE_ROLE_CHANGED'
      );
      expect(changedCalls).toHaveLength(0);
    });
  });

  describe('POST /api/drafts/regenerate-pending', () => {
    it('returns counts of regenerated + skipped drafts', async () => {
      // Bulk endpoint first fetches { id } of every pending draft on an
      // active mailbox, then loops calling `regenerateDraftById(id)`. Each
      // call triggers a second `findUnique` with the deep thread include.
      mockPrisma.emailDraft.findMany.mockResolvedValueOnce([
        { id: 'd-pending-1' },
        { id: 'd-pending-2' },
      ]);

      const inbound = {
        id: 'msg-1',
        externalMessageId: 'gm-1',
        fromAddress: 'a@example.com',
        fromName: 'A',
        subject: 'opportunity',
        bodyText: 'are you interested?',
        bodyHtml: null,
        receivedAt: new Date('2026-04-01T00:00:00Z'),
      };

      // d-pending-1 regenerates successfully.
      mockPrisma.emailDraft.findUnique.mockResolvedValueOnce({
        id: 'd-pending-1',
        status: 'PENDING',
        inReplyToMessageId: null,
        updatedAt: new Date('2026-04-01T00:00:00Z'),
        thread: {
          ...baseThread,
          messages: [inbound],
        },
      });
      // Phase AA #18: regenerateDraftById re-fetches thread messages just
      // before calling Claude so the regen reflects any new inbound.
      mockPrisma.emailMessage.findMany.mockResolvedValueOnce([inbound]);
      classifyReply.mockResolvedValueOnce({
        classification: 'INTERESTED',
        confidence: 0.9,
      });
      generateDraftReply.mockResolvedValueOnce({
        subject: 'Re: opportunity',
        bodyText: 'thanks!',
        bodyHtml: '<p>thanks!</p>',
      });
      mockPrisma.emailDraft.update.mockResolvedValueOnce({
        id: 'd-pending-1',
        status: 'PENDING',
      });

      // d-pending-2 → status flipped under us; route should record a skip
      // and continue without throwing.
      mockPrisma.emailDraft.findUnique.mockResolvedValueOnce({
        id: 'd-pending-2',
        status: 'APPROVED',
        inReplyToMessageId: null,
        updatedAt: new Date('2026-04-01T00:00:00Z'),
        thread: { ...baseThread, messages: [inbound] },
      });

      const res = await request(app)
        .post('/api/drafts/regenerate-pending')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.regenerated).toBe(1);
      expect(res.body.skipped).toHaveLength(1);
      expect(res.body.skipped[0]).toMatch(/d-pending-2/);
    });
  });
});

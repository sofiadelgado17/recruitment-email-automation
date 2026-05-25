import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

import { buildPrismaMock, resetPrismaMock, type MockPrisma } from '../_setup/mockPrisma';
import { loadApp, bearer } from '../_setup/testApp';

// `mailboxes.ts` reaches into `services/gmail.service` for several helpers
// (`getAuthUrl`, `resolveMailboxDisplayName`, `syncMessages`,
// `createServiceAccountClient`, `serializeCredentials`). Stubbing them at the
// import boundary keeps the route tests off real Google APIs.
const {
  getAuthUrl,
  resolveMailboxDisplayName,
  syncMessages,
  createServiceAccountClient,
  serializeCredentials,
} = vi.hoisted(() => ({
  getAuthUrl: vi.fn(),
  resolveMailboxDisplayName: vi.fn(),
  syncMessages: vi.fn(),
  createServiceAccountClient: vi.fn(),
  serializeCredentials: vi.fn(),
}));

vi.mock('../../src/services/gmail.service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/gmail.service')>(
    '../../src/services/gmail.service'
  );
  return {
    ...actual,
    getAuthUrl,
    resolveMailboxDisplayName,
    syncMessages,
    createServiceAccountClient,
    serializeCredentials,
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
  provider: 'GMAIL',
  emailAddress: 'inbox@archive.com',
  displayName: 'Inbox',
  isActive: true,
  watchExpiry: null,
  createdAt: new Date('2026-04-01T00:00:00Z'),
  updatedAt: new Date('2026-04-01T00:00:00Z'),
};

describe('/api/mailboxes', () => {
  let app: Awaited<ReturnType<typeof loadApp>>;

  beforeEach(async () => {
    resetPrismaMock(mockPrisma);
    getAuthUrl.mockReset();
    resolveMailboxDisplayName.mockReset();
    syncMessages.mockReset();
    createServiceAccountClient.mockReset();
    serializeCredentials.mockReset();
    app = await loadApp();
  });

  describe('GET /api/mailboxes', () => {
    it('returns 401 without an Authorization header', async () => {
      const res = await request(app).get('/api/mailboxes');
      expect(res.status).toBe(401);
      expect(mockPrisma.mailbox.findMany).not.toHaveBeenCalled();
    });

    it('returns the mailbox list when authenticated', async () => {
      mockPrisma.mailbox.findMany.mockResolvedValueOnce([
        { ...baseMailbox, _count: { threads: 4, messages: 12 } },
      ]);

      const res = await request(app)
        .get('/api/mailboxes')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        id: 'mb-1',
        emailAddress: 'inbox@archive.com',
        provider: 'GMAIL',
        isActive: true,
      });
    });
  });

  describe('POST /api/mailboxes/gmail/auth', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/mailboxes/gmail/auth');
      expect(res.status).toBe(401);
      expect(getAuthUrl).not.toHaveBeenCalled();
    });

    it('returns an authUrl and stores OAuth state when authenticated', async () => {
      getAuthUrl.mockImplementation(
        (state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`
      );

      const res = await request(app)
        .post('/api/mailboxes/gmail/auth')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.data.authUrl).toBe('string');
      expect(res.body.data.authUrl).toContain('state=');
      // The route generates state internally and threads it through getAuthUrl.
      expect(getAuthUrl).toHaveBeenCalledTimes(1);
      expect(typeof getAuthUrl.mock.calls[0]?.[0]).toBe('string');
    });
  });

  describe('DELETE /api/mailboxes/:id', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).delete('/api/mailboxes/mb-1');
      expect(res.status).toBe(401);
      expect(mockPrisma.mailbox.update).not.toHaveBeenCalled();
    });

    it('soft-deletes the mailbox by flipping isActive to false', async () => {
      mockPrisma.mailbox.findUnique.mockResolvedValueOnce(baseMailbox);
      mockPrisma.mailbox.update.mockResolvedValueOnce({ ...baseMailbox, isActive: false });

      const res = await request(app)
        .delete('/api/mailboxes/mb-1')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockPrisma.mailbox.update).toHaveBeenCalledWith({
        where: { id: 'mb-1' },
        data: { isActive: false },
      });
    });

    it('returns 404 when the mailbox does not exist', async () => {
      mockPrisma.mailbox.findUnique.mockResolvedValueOnce(null);

      const res = await request(app)
        .delete('/api/mailboxes/missing')
        .set('Authorization', AUTH);

      expect(res.status).toBe(404);
      expect(mockPrisma.mailbox.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/mailboxes/:id/resync', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/mailboxes/mb-1/resync');
      expect(res.status).toBe(401);
      expect(syncMessages).not.toHaveBeenCalled();
    });

    it('runs syncMessages for the mailbox and returns the result', async () => {
      mockPrisma.mailbox.findUnique.mockResolvedValueOnce(baseMailbox);
      syncMessages.mockResolvedValueOnce({
        scanned: 12,
        ingested: 3,
        skipped: 9,
      });

      const res = await request(app)
        .post('/api/mailboxes/mb-1/resync')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({ scanned: 12, ingested: 3, skipped: 9 });
      expect(syncMessages).toHaveBeenCalledWith('mb-1', { maxResults: 250, daysBack: 30 });
    });

    it('returns 404 when the mailbox does not exist', async () => {
      mockPrisma.mailbox.findUnique.mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/api/mailboxes/missing/resync')
        .set('Authorization', AUTH);

      expect(res.status).toBe(404);
      expect(syncMessages).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/mailboxes/:id/refresh-profile', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/mailboxes/mb-1/refresh-profile');
      expect(res.status).toBe(401);
      expect(resolveMailboxDisplayName).not.toHaveBeenCalled();
    });

    it('updates displayName from the userinfo source', async () => {
      mockPrisma.mailbox.findUnique.mockResolvedValueOnce({
        ...baseMailbox,
        displayName: 'old name',
      });
      resolveMailboxDisplayName.mockResolvedValueOnce({
        displayName: 'Sofia Delgado',
        source: 'userinfo',
      });
      mockPrisma.mailbox.update.mockResolvedValueOnce({
        ...baseMailbox,
        displayName: 'Sofia Delgado',
      });

      const res = await request(app)
        .post('/api/mailboxes/mb-1/refresh-profile')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.source).toBe('userinfo');
      expect(res.body.data.mailbox.displayName).toBe('Sofia Delgado');
      expect(mockPrisma.mailbox.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'mb-1' },
          data: { displayName: 'Sofia Delgado' },
        })
      );
    });

    it('updates displayName from the sent-messages fallback', async () => {
      mockPrisma.mailbox.findUnique.mockResolvedValueOnce({
        ...baseMailbox,
        displayName: 'old name',
      });
      resolveMailboxDisplayName.mockResolvedValueOnce({
        displayName: 'Andriy K',
        source: 'sent_messages',
      });
      mockPrisma.mailbox.update.mockResolvedValueOnce({
        ...baseMailbox,
        displayName: 'Andriy K',
      });

      const res = await request(app)
        .post('/api/mailboxes/mb-1/refresh-profile')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.data.source).toBe('sent_messages');
      expect(res.body.data.mailbox.displayName).toBe('Andriy K');
    });

    it('returns 400 when neither userinfo nor sent-messages produces a name', async () => {
      mockPrisma.mailbox.findUnique.mockResolvedValueOnce(baseMailbox);
      resolveMailboxDisplayName.mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/api/mailboxes/mb-1/refresh-profile')
        .set('Authorization', AUTH);

      expect(res.status).toBe(400);
      expect(mockPrisma.mailbox.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/mailboxes/refresh-all-profiles', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/mailboxes/refresh-all-profiles');
      expect(res.status).toBe(401);
      expect(resolveMailboxDisplayName).not.toHaveBeenCalled();
    });

    it('iterates over active mailboxes and reports updated / unchanged / failed counts', async () => {
      const mb1 = { ...baseMailbox, id: 'mb-1', displayName: 'Old A' };
      const mb2 = {
        ...baseMailbox,
        id: 'mb-2',
        emailAddress: 'b@archive.com',
        displayName: 'Same Name',
      };
      const mb3 = {
        ...baseMailbox,
        id: 'mb-3',
        emailAddress: 'c@archive.com',
        displayName: 'Old C',
      };

      mockPrisma.mailbox.findMany.mockResolvedValueOnce([mb1, mb2, mb3]);

      // mb-1: userinfo says "New A" → updated
      resolveMailboxDisplayName.mockResolvedValueOnce({
        displayName: 'New A',
        source: 'userinfo',
      });
      // mb-2: resolver returns the same name → unchanged
      resolveMailboxDisplayName.mockResolvedValueOnce({
        displayName: 'Same Name',
        source: 'userinfo',
      });
      // mb-3: resolver returns null → failed
      resolveMailboxDisplayName.mockResolvedValueOnce(null);

      mockPrisma.mailbox.update.mockResolvedValueOnce({ ...mb1, displayName: 'New A' });

      const res = await request(app)
        .post('/api/mailboxes/refresh-all-profiles')
        .set('Authorization', AUTH);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        updated: 1,
        unchanged: 1,
        failed: 1,
        total: 3,
      });
      expect(res.body.data.details).toHaveLength(3);
      expect(resolveMailboxDisplayName).toHaveBeenCalledTimes(3);
      // Only the updated mailbox should have triggered a write.
      expect(mockPrisma.mailbox.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.mailbox.update).toHaveBeenCalledWith({
        where: { id: 'mb-1' },
        data: { displayName: 'New A' },
      });
    });
  });

  describe('POST /api/mailboxes/workspace/connect', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/mailboxes/workspace/connect')
        .send({ emailAddresses: ['a@archive.com'] });
      expect(res.status).toBe(401);
      expect(createServiceAccountClient).not.toHaveBeenCalled();
    });

    it('returns a per-email error when GOOGLE_SERVICE_ACCOUNT_KEY_JSON is missing', async () => {
      // The route delegates the env-var check to createServiceAccountClient,
      // which throws "GOOGLE_SERVICE_ACCOUNT_KEY_JSON is not set ...". The
      // route catches per-email errors and records them in results.
      const original = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
      delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
      createServiceAccountClient.mockImplementation(async () => {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_JSON is not set — required for workspace OAuth');
      });

      try {
        const res = await request(app)
          .post('/api/mailboxes/workspace/connect')
          .set('Authorization', AUTH)
          .send({ emailAddresses: ['a@archive.com', 'b@archive.com'] });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveLength(2);
        for (const result of res.body.data) {
          expect(result.success).toBe(false);
          expect(result.error).toMatch(/GOOGLE_SERVICE_ACCOUNT_KEY_JSON/);
        }
        // Mailbox should not have been created when the service account
        // client could not be constructed.
        expect(mockPrisma.mailbox.upsert).not.toHaveBeenCalled();
      } finally {
        if (original !== undefined) process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON = original;
      }
    });

    it('rejects an empty emailAddresses array with 400', async () => {
      const res = await request(app)
        .post('/api/mailboxes/workspace/connect')
        .set('Authorization', AUTH)
        .send({ emailAddresses: [] });

      expect(res.status).toBe(400);
      expect(createServiceAccountClient).not.toHaveBeenCalled();
    });

    it('returns 403 when the authenticated user is not an admin', async () => {
      // Override the default admin mock — non-admin recruiters must NOT be able
      // to attach arbitrary @archive.com mailboxes via the service-account DWD
      // path, which would let them ingest the CEO's email.
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'test-user-1', role: 'recruiter' });

      const res = await request(app)
        .post('/api/mailboxes/workspace/connect')
        .set('Authorization', AUTH)
        .send({ emailAddresses: ['ceo@archive.com'] });

      expect(res.status).toBe(403);
      expect(createServiceAccountClient).not.toHaveBeenCalled();
      expect(mockPrisma.mailbox.upsert).not.toHaveBeenCalled();
    });

    it('connects mailboxes when the authenticated user is an admin', async () => {
      const gmailClient = {
        users: { messages: { list: vi.fn().mockResolvedValue({ data: { messages: [] } }) } },
      };
      createServiceAccountClient.mockResolvedValue(gmailClient);
      serializeCredentials.mockImplementation((c: unknown) => JSON.stringify(c));
      mockPrisma.mailbox.upsert.mockResolvedValueOnce({ ...baseMailbox, id: 'mb-new' });
      syncMessages.mockResolvedValueOnce({ scanned: 0, ingested: 0, skipped: 0 });

      const res = await request(app)
        .post('/api/mailboxes/workspace/connect')
        .set('Authorization', AUTH)
        .send({ emailAddresses: ['ops@archive.com'] });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([{ email: 'ops@archive.com', success: true }]);
      expect(createServiceAccountClient).toHaveBeenCalledWith('ops@archive.com');
      expect(mockPrisma.mailbox.upsert).toHaveBeenCalledTimes(1);
    });
  });
});

// The Today summary (R4) is four raw SQL statements plus shaping. These run
// the exact SQL against real Postgres (PGlite) with every migration applied.
import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { migratedDb } from '../_setup/pglite';
import { getTodaySummary, type TodaySummary } from '../../src/services/today.service';

const NOW = new Date('2026-10-22T15:00:00Z'); // Thu 11:00 ET
const H = 3600_000;
const D = 24 * H;
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

interface DraftSeed {
  id: string;
  status: string;
  classification?: string;
  confidence?: number;
  createdAt: number;
  snoozedUntil?: number;
  sentAt?: number;
  mailbox?: string;
}

const DRAFTS: DraftSeed[] = [
  { id: 'd_int', status: 'PENDING', classification: 'INTERESTED', createdAt: -2 * H },
  { id: 'd_int_old', status: 'PENDING', classification: 'INTERESTED', createdAt: -5 * D },
  // Expires within 24h (21-day window).
  { id: 'd_expiring', status: 'PENDING', classification: 'NOT_INTERESTED', createdAt: -(20 * D + 12 * H) },
  { id: 'd_low', status: 'PENDING', classification: 'INTERESTED', confidence: 0.4, createdAt: -3 * H },
  // FAILED is waiting (needs_review) but never "expiring".
  { id: 'd_failed', status: 'FAILED', classification: 'INTERESTED', createdAt: -(20 * D + 20 * H) },
  { id: 'd_snoozed', status: 'PENDING', classification: 'INTERESTED', createdAt: -H, snoozedUntil: D },
  // Snooze ran out but nobody released it yet: waiting again, no write needed.
  { id: 'd_snooze_over', status: 'PENDING', classification: 'INTERESTED', createdAt: -4 * H, snoozedUntil: -H },
  { id: 'd_sent_today', status: 'SENT', createdAt: -D, sentAt: -H },
  { id: 'd_sent_mb2', status: 'SENT', createdAt: -D, sentAt: -2 * H, mailbox: 'mb2' },
  // 2026-10-20 10:00 ET and 2026-10-20 23:30 ET (03:30Z on the 21st).
  { id: 'd_sent_d2', status: 'SENT', createdAt: -3 * D, sentAt: -(2 * D) - H },
  { id: 'd_sent_d2_late', status: 'SENT', createdAt: -3 * D, sentAt: -(D + 11 * H + 30 * 60_000) },
  { id: 'd_sent_old', status: 'SENT', createdAt: -30 * D, sentAt: -20 * D },
  { id: 'd_mb2', status: 'PENDING', classification: 'NOT_INTERESTED', createdAt: -30 * 60_000, mailbox: 'mb2' },
];

async function seed(db: PGlite): Promise<void> {
  await db.exec(`
    INSERT INTO "Mailbox" (id, "emailAddress", "sendAsAddresses", "updatedAt") VALUES
      ('mb1', 'a@archive.com', '{a@archive.com,alias@archive.com}', now()),
      ('mb2', 'b@archive.com', '{}', now()),
      ('mb3', 'c@archive.com', '{}', now());
  `);
  for (const d of DRAFTS) {
    const mb = d.mailbox ?? 'mb1';
    await db.query(
      `INSERT INTO "Candidate" (id, name, email, status, "mailboxId", "updatedAt") VALUES ($1, $1, $1 || '@x.com', 'INTERESTED', $2, now())`,
      [`c_${d.id}`, mb]
    );
    await db.query(
      `INSERT INTO "EmailThread" (id, "candidateId", "mailboxId", "externalThreadId", subject) VALUES ($1, $2, $3, $1, 's')`,
      [`t_${d.id}`, `c_${d.id}`, mb]
    );
    await db.query(
      `INSERT INTO "EmailDraft" (id, "threadId", subject, "bodyText", classification, confidence, status,
         "createdAt", "updatedAt", "snoozedUntil", "sentAt")
       VALUES ($1, $2, 's', 'b', $3, $4, $5, $6, $6, $7, $8)`,
      [
        d.id,
        `t_${d.id}`,
        d.classification ?? 'INTERESTED',
        d.confidence ?? 0.9,
        d.status,
        iso(d.createdAt),
        d.snoozedUntil === undefined ? null : iso(d.snoozedUntil),
        d.sentAt === undefined ? null : iso(d.sentAt),
      ]
    );
  }
  // NEEDS_REVIEW candidate with no draft — the oldest waiting item (6 days).
  await db.query(
    `INSERT INTO "Candidate" (id, name, email, status, "mailboxId", "lastInboundAt", "updatedAt") VALUES
       ('c_review', 'r', 'r@x.com', 'NEEDS_REVIEW', 'mb1', $1, $1)`,
    [iso(-6 * D)]
  );

  // Messages on d_int's thread (candidate c_d_int@x.com, mailbox mb1).
  const msgs: Array<[string, string, string, number]> = [
    ['m_in_today', 't_d_int', 'C_D_INT@x.com', -2 * H], // case-insensitive match
    ['m_in_today2', 't_d_int', 'c_d_int@x.com', -3 * H],
    ['m_in_d1', 't_d_int', 'c_d_int@x.com', -D],
    ['m_out', 't_d_int', 'alias@archive.com', -H], // recruiter → not received
    ['m_colleague', 't_d_int', 'boss@archive.com', -30 * 60_000], // CC'd colleague → not a reply, but still "received"
    ['m_in_old', 't_d_int', 'c_d_int@x.com', -40 * D],
  ];
  for (const [id, thread, from, at] of msgs) {
    await db.query(
      `INSERT INTO "EmailMessage" (id, "threadId", "mailboxId", "externalMessageId", "fromAddress", subject, "receivedAt")
       VALUES ($1, $2, 'mb1', $1, $3, 's', $4)`,
      [id, thread, from, iso(at)]
    );
  }
  // mb2: only an old inbound message, outside the 14-day window.
  await db.query(
    `INSERT INTO "EmailMessage" (id, "threadId", "mailboxId", "externalMessageId", "fromAddress", subject, "receivedAt")
     VALUES ('m_mb2', 't_d_mb2', 'mb2', 'm_mb2', 'c_d_mb2@x.com', 's', $1)`,
    [iso(-30 * D)]
  );

  // Lever: interested-not-in-Lever candidates + opportunity-created logs.
  await db.query(
    `INSERT INTO "Candidate" (id, name, email, status, "mailboxId", "leverState", "updatedAt") VALUES
       ('c_nl1', 'a', 'nl1@x.com', 'INTERESTED', 'mb1', 'NOT_FOUND', now()),
       ('c_nl2', 'b', 'nl2@x.com', 'INTERESTED', 'mb2', 'NOT_FOUND', now()),
       ('c_in', 'c', 'in@x.com', 'INTERESTED', 'mb1', 'ACTIVE', now()),
       ('c_ni', 'd', 'ni@x.com', 'NOT_INTERESTED', 'mb1', 'NOT_FOUND', now())`
  );
  const logs: Array<[string, number]> = [
    ['l_today', -H],
    ['l_mon', -(3 * D)], // Mon 2026-10-19 11:00 ET — this week
    ['l_prev_week', -(5 * D)], // Sat 2026-10-17 — last week
  ];
  for (const [id, at] of logs) {
    await db.query(
      `INSERT INTO "SystemLog" (id, event, details, "createdAt") VALUES ($1, 'LEVER_OPPORTUNITY_CREATED', '{"candidateId":"c_in"}', $2)`,
      [id, iso(at)]
    );
  }
  await db.query(
    `INSERT INTO "SystemLog" (id, event, "createdAt") VALUES ('l_other', 'LEVER_SYNC_DONE', $1)`,
    [iso(-H)]
  );
}

describe('today summary SQL (R4)', () => {
  let db: PGlite;
  let calls: number;
  const query = async <T>(sql: Prisma.Sql): Promise<T[]> => {
    calls++;
    return (await db.query<T>(sql.text, sql.values as unknown[])).rows;
  };
  let all: TodaySummary;
  // Snapshot of `calls` for the unscoped summary alone: later tests reuse
  // `query`, and tests may run in any order (CI uses --sequence.shuffle).
  let summaryQueries: number;

  beforeAll(async () => {
    db = await migratedDb();
    await seed(db);
    calls = 0;
    all = await getTodaySummary({}, NOW, query);
    summaryQueries = calls;
  }, 60_000);

  it('runs at most four queries', () => {
    expect(summaryQueries).toBeLessThanOrEqual(4);
  });

  it('counts replies waiting per Inbox view, including snooze-expired drafts', () => {
    expect(all.views).toEqual({ needs_review: 3, interested: 3, not_interested: 2 });
  });

  it('counts sent today with the Inbox rule (ET midnight)', () => {
    expect(all.sentToday).toBe(2);
  });

  it('reports the oldest waiting item across the three views', () => {
    // d_mb2 (drafted 30 min ago) answers m_mb2, received 30 days ago.
    expect(all.oldestWaitingAt).toBe(iso(-30 * D));
  });

  it('counts live PENDING/APPROVED drafts expiring within 24h (not FAILED)', () => {
    expect(all.draftsExpiringSoon).toBe(1);
  });

  it('gives every active mailbox a row: waiting, sent today, last received', () => {
    const byId = Object.fromEntries(all.mailboxes.map((m) => [m.mailboxId, m]));
    expect(Object.keys(byId).sort()).toEqual(['mb1', 'mb2', 'mb3']);
    expect(byId.mb1).toEqual({ mailboxId: 'mb1', waiting: 7, sentToday: 1, lastReceivedAt: iso(-30 * 60_000) });
    expect(byId.mb2).toEqual({ mailboxId: 'mb2', waiting: 1, sentToday: 1, lastReceivedAt: iso(-30 * D) });
    expect(byId.mb3).toEqual({ mailboxId: 'mb3', waiting: 0, sentToday: 0, lastReceivedAt: null });
  });

  it('zero-fills 14 consecutive ET days, oldest first, ending today', () => {
    expect(all.series).toHaveLength(14);
    expect(all.series[0].day).toBe('2026-10-09');
    expect(all.series[13].day).toBe('2026-10-22');
    const byDay = Object.fromEntries(all.series.map((s) => [s.day, s]));
    // Candidate replies only: not the recruiter alias, not the CC'd colleague.
    expect(byDay['2026-10-22']).toEqual({ day: '2026-10-22', received: 2, sent: 2 });
    expect(byDay['2026-10-21']).toEqual({ day: '2026-10-21', received: 1, sent: 0 });
    // 23:30 ET on the 20th is still the 20th.
    expect(byDay['2026-10-20']).toEqual({ day: '2026-10-20', received: 0, sent: 2 });
    expect(all.series.reduce((n, s) => n + s.received, 0)).toBe(3);
  });

  it('Lever snapshot: interested not in Lever, added today / this week (since Monday ET)', () => {
    expect(all.lever).toEqual({ interestedNotInLever: 2, addedToday: 1, addedThisWeek: 2 });
  });

  it('scopes everything mailbox-bound to mailboxId', async () => {
    const mb2 = await getTodaySummary({ mailboxId: 'mb2' }, NOW, query);
    expect(mb2.views).toEqual({ needs_review: 0, interested: 0, not_interested: 1 });
    expect(mb2.sentToday).toBe(1);
    expect(mb2.mailboxes.map((m) => m.mailboxId)).toEqual(['mb2']);
    expect(mb2.series.reduce((n, s) => n + s.received, 0)).toBe(0);
    expect(mb2.series.reduce((n, s) => n + s.sent, 0)).toBe(1);
    expect(mb2.lever.interestedNotInLever).toBe(1);
  });

  it('is empty-safe on a database with no data', async () => {
    const empty = await migratedDb();
    const q = async <T>(sql: Prisma.Sql): Promise<T[]> => (await empty.query<T>(sql.text, sql.values as unknown[])).rows;
    const s = await getTodaySummary({}, NOW, q);
    expect(s).toMatchObject({
      views: { needs_review: 0, interested: 0, not_interested: 0 },
      sentToday: 0,
      oldestWaitingAt: null,
      draftsExpiringSoon: 0,
      mailboxes: [],
      lever: { interestedNotInLever: 0, addedToday: 0, addedThisWeek: 0 },
    });
    expect(s.series).toHaveLength(14);
    expect(s.series.every((d) => d.received === 0 && d.sent === 0)).toBe(true);
  }, 60_000);
});

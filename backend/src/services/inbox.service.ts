// Inbox queue (U0): which view each draft / NEEDS_REVIEW candidate belongs
// to, counted in one grouped query and listed with a keyset cursor.
//
// The view rules live in one SQL CTE (inboxItemsCte) shared by the counts
// and the items query, so the counts can never disagree with the lists:
//
//   sent_today      SENT since ET midnight, plus in-flight SCHEDULED/SENDING
//                   (so a reload during the undo window still offers undo)
//   snoozed         live draft with snoozedUntil in the future
//   needs_review    FAILED sends; PENDING/APPROVED with confidence < 0.7 or a
//                   label other than INTERESTED/NOT_INTERESTED (NEUTRAL would
//                   otherwise be in no view); NEEDS_REVIEW candidates with no
//                   live draft (kind 'candidate')
//   interested /    PENDING/APPROVED by classification
//   not_interested
//
// Expired (> DRAFT_EXPIRY_DAYS) and stale (candidate answered outside the
// app after the draft was written, H5) items are in no live view.
import { Prisma } from '@prisma/client';
import { prisma } from '../db/client';
import { LIVE_DRAFT_STATUSES, DRAFT_EXPIRY_DAYS, draftExpiresAt } from '../lib/draftStatus';
import { LOW_CONFIDENCE_THRESHOLD } from '../lib/candidateState';
import { confidenceLabel, type ConfidenceLabel } from '../lib/confidence';
import { resolveDraftCc } from './draftCc.service';
import { listPresence, type PresenceEntry } from './draftPresence.service';

export const INBOX_VIEWS = ['needs_review', 'interested', 'not_interested', 'snoozed', 'sent_today'] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];
export type InboxOrder = 'newest' | 'oldest';
export type InboxItemKind = 'draft' | 'candidate';

export const INBOX_PAGE_LIMIT = 50;
const PREVIEW_CHARS = 200;

export interface InboxCursor {
  sortAt: Date;
  kind: InboxItemKind;
  id: string;
}

/** Midnight in America/New_York for the ET calendar day containing `now`. */
export function etMidnight(now: Date): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const utcMidnight = Date.UTC(get('year'), get('month') - 1, get('day'));
  // ET's UTC offset just after local midnight (DST flips at 2am local, so
  // 1am ET — utcMidnight + 6h — has midnight's offset).
  const offsetName =
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
      .formatToParts(new Date(utcMidnight + 6 * 3600_000))
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const offsetHours = Number(offsetName.replace('GMT', '') || '0');
  return new Date(utcMidnight - offsetHours * 3600_000);
}

export function encodeCursor(c: InboxCursor): string {
  return Buffer.from(`${c.sortAt.toISOString()}|${c.kind}|${c.id}`).toString('base64url');
}

export function decodeCursor(raw: string): InboxCursor | null {
  const [at, kind, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const sortAt = new Date(at ?? '');
  if (Number.isNaN(sortAt.getTime()) || (kind !== 'draft' && kind !== 'candidate') || !id) return null;
  return { sortAt, kind, id };
}

export interface CteParams {
  now: Date;
  mailboxId?: string;
}

/** `?role=` filter: exact role titles, plus `unknown` for a null/blank role (`__none__`). */
export interface InboxRoleFilter {
  roles: string[];
  unknown: boolean;
}
export const ROLE_UNKNOWN_PARAM = '__none__';

/** SQL predicate on inbox_items.role; TRUE when there's no filter. */
function roleMatch(f: InboxRoleFilter | null | undefined): Prisma.Sql {
  if (!f || (f.roles.length === 0 && !f.unknown)) return Prisma.sql`TRUE`;
  const parts: Prisma.Sql[] = [];
  if (f.roles.length) parts.push(Prisma.sql`role IN (${Prisma.join(f.roles)})`);
  if (f.unknown) parts.push(Prisma.sql`role IS NULL`);
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

/**
 * The view rules as a CTE ending in `inbox_items (id, kind, view, sortAt,
 * mailboxId, expiresAt, role)`. role is the trimmed role or NULL. expiresAt is set for PENDING/APPROVED drafts only
 * (the ones the expiry window applies to). Shared with today.service.
 */
export function inboxItemsCte({ now, mailboxId }: CteParams): Prisma.Sql {
  const midnight = etMidnight(now);
  const expiryCutoff = new Date(now.getTime() - DRAFT_EXPIRY_DAYS * 24 * 3600_000);
  const draftMailbox = mailboxId ? Prisma.sql`AND t."mailboxId" = ${mailboxId}` : Prisma.empty;
  const candidateMailbox = mailboxId ? Prisma.sql`AND c."mailboxId" = ${mailboxId}` : Prisma.empty;
  return Prisma.sql`
    WITH draft_items AS (
      SELECT d.id, 'draft'::text AS kind,
        CASE
          WHEN d.status IN ('SCHEDULED', 'SENDING') OR (d.status = 'SENT' AND d."sentAt" >= ${midnight})
            THEN 'sent_today'
          WHEN d.status IN ('PENDING', 'APPROVED', 'FAILED') AND d."snoozedUntil" > ${now}
            THEN 'snoozed'
          WHEN d.status = 'FAILED'
            THEN 'needs_review'
          WHEN d.status IN ('PENDING', 'APPROVED')
            AND d."createdAt" >= ${expiryCutoff}
            AND NOT (d.status = 'PENDING' AND c."repliedAt" IS NOT NULL AND c."repliedAt" > d."createdAt")
            THEN CASE
              WHEN d.confidence < ${LOW_CONFIDENCE_THRESHOLD}
                OR d.classification NOT IN ('INTERESTED', 'NOT_INTERESTED') THEN 'needs_review'
              WHEN d.classification = 'INTERESTED' THEN 'interested'
              ELSE 'not_interested'
            END
        END AS view,
        CASE WHEN d.status IN ('SCHEDULED', 'SENDING', 'SENT')
          THEN COALESCE(d."sentAt", d."scheduledSendAt", d."updatedAt")
          ELSE COALESCE(replied_to."receivedAt", d."createdAt")
        END AS "sortAt",
        t."mailboxId" AS "mailboxId",
        CASE WHEN d.status IN ('PENDING', 'APPROVED')
          THEN d."createdAt" + make_interval(days => ${DRAFT_EXPIRY_DAYS}::int)
        END AS "expiresAt",
        NULLIF(BTRIM(c.role), '') AS role
      FROM "EmailDraft" d
      JOIN "EmailThread" t ON t.id = d."threadId"
      JOIN "Mailbox" mb ON mb.id = t."mailboxId"
      LEFT JOIN "Candidate" c ON c.id = t."candidateId"
      -- The inbound message the draft answers: latest one not from the
      -- mailbox at or before the draft (as drafts.ts pickOriginalMessage).
      LEFT JOIN LATERAL (
        SELECT m."receivedAt" FROM "EmailMessage" m
        WHERE m."threadId" = d."threadId"
          AND lower(m."fromAddress") <> lower(mb."emailAddress")
          AND m."receivedAt" <= d."createdAt"
        ORDER BY m."receivedAt" DESC LIMIT 1
      ) replied_to ON TRUE
      WHERE d.status IN ('PENDING', 'APPROVED', 'FAILED', 'SCHEDULED', 'SENDING', 'SENT')
        AND (d.status <> 'SENT' OR d."sentAt" >= ${midnight})
        ${draftMailbox}
    ),
    candidate_items AS (
      SELECT c.id, 'candidate'::text AS kind, 'needs_review'::text AS view,
        -- Received time, never updatedAt (bumped by Lever/Gem syncs). The
        -- message fallback covers rows lastInboundAt was never backfilled on.
        COALESCE(c."lastInboundAt", latest_in."receivedAt", c."repliedAt", c."createdAt") AS "sortAt",
        c."mailboxId" AS "mailboxId", NULL::timestamp AS "expiresAt",
        NULLIF(BTRIM(c.role), '') AS role
      FROM "Candidate" c
      LEFT JOIN LATERAL (
        SELECT m."receivedAt" FROM "EmailThread" t1
        JOIN "EmailMessage" m ON m."threadId" = t1.id
        WHERE t1."candidateId" = c.id AND lower(m."fromAddress") = lower(c.email)
        ORDER BY m."receivedAt" DESC LIMIT 1
      ) latest_in ON c."lastInboundAt" IS NULL
      WHERE c.status = 'NEEDS_REVIEW'
        AND COALESCE(c."lastInboundAt", c."updatedAt") >= ${expiryCutoff}
        ${candidateMailbox}
        AND NOT EXISTS (
          SELECT 1 FROM "EmailThread" t2
          JOIN "EmailDraft" d2 ON d2."threadId" = t2.id
          WHERE t2."candidateId" = c.id AND d2.status IN (${Prisma.join(LIVE_DRAFT_STATUSES)})
        )
    ),
    inbox_items AS (
      SELECT id, kind, view, "sortAt", "mailboxId", "expiresAt", role FROM draft_items WHERE view IS NOT NULL
      UNION ALL
      SELECT id, kind, view, "sortAt", "mailboxId", "expiresAt", role FROM candidate_items
    )`;
}

/**
 * Item count per view: one query for all five tabs. A role filter narrows
 * only `view`'s count (the list it applies to); other tabs stay whole.
 */
export function inboxCountsSql(params: CteParams & { view?: InboxView; roleFilter?: InboxRoleFilter | null }): Prisma.Sql {
  const where = params.view ? Prisma.sql`WHERE view <> ${params.view} OR ${roleMatch(params.roleFilter)}` : Prisma.empty;
  return Prisma.sql`${inboxItemsCte(params)}
    SELECT view, COUNT(*)::int AS count FROM inbox_items ${where} GROUP BY view`;
}

/** Item count per role in one view (unfiltered by role), for the role filter. */
export function inboxRoleCountsSql(params: CteParams & { view: InboxView }): Prisma.Sql {
  return Prisma.sql`${inboxItemsCte(params)}
    SELECT role, COUNT(*)::int AS count FROM inbox_items WHERE view = ${params.view} GROUP BY role`;
}

export interface InboxItemsParams extends CteParams {
  view: InboxView;
  order: InboxOrder;
  cursor: InboxCursor | null;
  limit: number;
  roleFilter?: InboxRoleFilter | null;
}

/** One page of (id, kind, sortAt) for a view, keyset-paginated on (sortAt, kind, id). */
export function inboxItemsSql(p: InboxItemsParams): Prisma.Sql {
  const desc = p.order === 'newest';
  const after = p.cursor
    ? desc
      ? Prisma.sql`AND ("sortAt", kind, id) < (${p.cursor.sortAt}, ${p.cursor.kind}, ${p.cursor.id})`
      : Prisma.sql`AND ("sortAt", kind, id) > (${p.cursor.sortAt}, ${p.cursor.kind}, ${p.cursor.id})`
    : Prisma.empty;
  const orderBy = desc
    ? Prisma.sql`ORDER BY "sortAt" DESC, kind DESC, id DESC`
    : Prisma.sql`ORDER BY "sortAt" ASC, kind ASC, id ASC`;
  return Prisma.sql`${inboxItemsCte(p)}
    SELECT id, kind, "sortAt" FROM inbox_items
    WHERE view = ${p.view} AND ${roleMatch(p.roleFilter)} ${after}
    ${orderBy}
    LIMIT ${p.limit}`;
}

export interface InboxDraftSummary {
  id: string;
  threadId: string;
  status: string;
  subject: string;
  preview: string;
  classification: string;
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  classificationReason: string | null;
  evidenceQuote: string | null;
  hasEdits: boolean;
  editedAt: Date | null;
  /** Who made the edits (name, else email); null without edits. */
  editedByName: string | null;
  /** When a PENDING/APPROVED draft leaves the live views; null otherwise. */
  expiresAt: Date | null;
  snoozedUntil: Date | null;
  returnedFromSnoozeAt: Date | null;
  scheduledSendAt: Date | null;
  sentAt: Date | null;
  sendError: string | null;
  ccAddress: string | null;
  createdAt: Date;
}

export interface InboxCandidateSummary {
  id: string;
  name: string;
  email: string;
  role: string | null;
  status: string;
  leverState: string | null;
  leverStage: string | null;
  leverPostingTitle: string | null;
  leverOpportunityId: string | null;
}

export interface InboxItem {
  kind: InboxItemKind;
  id: string;
  view: InboxView;
  sortAt: Date;
  ageMs: number;
  draft: InboxDraftSummary | null;
  candidate: InboxCandidateSummary | null;
  mailbox: { id: string; emailAddress: string; displayName: string | null } | null;
  presence: PresenceEntry[];
}

export interface InboxPage {
  items: InboxItem[];
  counts: Record<InboxView, number>;
  /** Items per role in this view (ignoring the role filter); role null = unknown. */
  roleCounts: Array<{ role: string | null; count: number }>;
  nextCursor: string | null;
}

const candidateSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  leverState: true,
  leverStage: true,
  leverPostingTitle: true,
  leverOpportunityId: true,
} as const;
const mailboxSelect = { id: true, emailAddress: true, displayName: true } as const;

/**
 * Snoozes that ran out come back as unread: snoozedUntil → returnedFromSnoozeAt.
 * Run before reading so the counts and lists already reflect it.
 */
export async function releaseExpiredSnoozes(now: Date): Promise<number> {
  const res = await prisma.emailDraft.updateMany({
    where: { snoozedUntil: { lte: now } },
    data: { snoozedUntil: null, returnedFromSnoozeAt: now },
  });
  return res.count;
}

export async function getInbox(
  q: {
    view: InboxView;
    mailboxId?: string;
    order: InboxOrder;
    cursor: InboxCursor | null;
    roleFilter?: InboxRoleFilter | null;
  },
  userId: string | undefined,
  now: Date = new Date()
): Promise<InboxPage> {
  await releaseExpiredSnoozes(now);

  const [countRows, roleRows, pageRows] = await Promise.all([
    prisma.$queryRaw<Array<{ view: InboxView; count: number }>>(
      inboxCountsSql({ now, mailboxId: q.mailboxId, view: q.view, roleFilter: q.roleFilter })
    ),
    prisma.$queryRaw<Array<{ role: string | null; count: number }>>(
      inboxRoleCountsSql({ now, mailboxId: q.mailboxId, view: q.view })
    ),
    prisma.$queryRaw<Array<{ id: string; kind: InboxItemKind; sortAt: Date }>>(
      inboxItemsSql({ ...q, now, limit: INBOX_PAGE_LIMIT + 1 })
    ),
  ]);

  const counts = Object.fromEntries(INBOX_VIEWS.map((v) => [v, 0])) as Record<InboxView, number>;
  for (const r of countRows ?? []) counts[r.view] = Number(r.count);
  const roleCounts = (roleRows ?? []).map((r) => ({ role: r.role ?? null, count: Number(r.count) }));

  const rows = (pageRows ?? []).slice(0, INBOX_PAGE_LIMIT);
  const last = rows[rows.length - 1];
  const nextCursor =
    (pageRows ?? []).length > INBOX_PAGE_LIMIT && last
      ? encodeCursor({ sortAt: new Date(last.sortAt), kind: last.kind, id: last.id })
      : null;

  const draftIds = rows.filter((r) => r.kind === 'draft').map((r) => r.id);
  const candidateIds = rows.filter((r) => r.kind === 'candidate').map((r) => r.id);
  const [drafts, candidates, presence] = await Promise.all([
    draftIds.length
      ? prisma.emailDraft.findMany({
          where: { id: { in: draftIds } },
          include: { thread: { include: { candidate: { select: candidateSelect }, mailbox: { select: mailboxSelect } } } },
        })
      : Promise.resolve([]),
    candidateIds.length
      ? prisma.candidate.findMany({
          where: { id: { in: candidateIds } },
          select: { ...candidateSelect, mailbox: { select: mailboxSelect } },
        })
      : Promise.resolve([]),
    listPresence(draftIds, userId, now),
  ]);
  const draftById = new Map(drafts.map((d) => [d.id, d]));
  const editorIds = [...new Set(drafts.flatMap((d) => (d.editedByUserId ? [d.editedByUserId] : [])))];
  const editors = editorIds.length
    ? await prisma.user.findMany({ where: { id: { in: editorIds } }, select: { id: true, name: true, email: true } })
    : [];
  const editorName = new Map(editors.map((u) => [u.id, u.name || u.email]));
  const candidateById = new Map(candidates.map((c) => [c.id, c]));

  const items: InboxItem[] = [];
  for (const r of rows) {
    const sortAt = new Date(r.sortAt);
    const base = { kind: r.kind, id: r.id, view: q.view, sortAt, ageMs: Math.max(0, now.getTime() - sortAt.getTime()) };
    if (r.kind === 'draft') {
      const d = draftById.get(r.id);
      if (!d) continue; // deleted between the two queries
      const { mailbox, candidate } = d.thread;
      const hasEdits = d.aiBodyText !== null && d.aiBodyText !== d.bodyText;
      items.push({
        ...base,
        draft: {
          id: d.id,
          threadId: d.threadId,
          status: d.status,
          subject: d.subject,
          preview: d.bodyText.slice(0, PREVIEW_CHARS),
          classification: d.classification,
          confidence: d.confidence,
          confidenceLabel: confidenceLabel(d.confidence),
          classificationReason: d.classificationReason,
          evidenceQuote: d.evidenceQuote,
          hasEdits,
          editedAt: d.editedAt,
          editedByName: hasEdits && d.editedByUserId ? (editorName.get(d.editedByUserId) ?? null) : null,
          expiresAt: draftExpiresAt(d.status, d.createdAt),
          snoozedUntil: d.snoozedUntil,
          returnedFromSnoozeAt: d.returnedFromSnoozeAt,
          scheduledSendAt: d.scheduledSendAt,
          sentAt: d.sentAt,
          sendError: d.sendError,
          ccAddress: resolveDraftCc(d.ccEmail, mailbox.emailAddress),
          createdAt: d.createdAt,
        },
        candidate: candidate ?? null,
        mailbox,
        presence: presence.get(d.id) ?? [],
      });
    } else {
      const c = candidateById.get(r.id);
      if (!c) continue;
      const { mailbox, ...candidate } = c;
      items.push({ ...base, draft: null, candidate, mailbox: mailbox ?? null, presence: [] });
    }
  }

  return { items, counts, roleCounts, nextCursor };
}

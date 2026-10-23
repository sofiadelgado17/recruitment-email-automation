// Pure helpers for the R3 Candidates page: the one reply-label chip, last
// activity, filters ⇄ URL ⇄ API params, and the default saved views.
import type { Candidate, CandidateSortColumn, fetchCandidates } from './api';

/** Draft statuses that are a reply waiting in the Inbox (Inbox, side panel, ⌘K). */
export const LIVE_DRAFT_STATUSES: ReadonlySet<string> = new Set(['PENDING', 'APPROVED', 'SCHEDULED', 'SENDING', 'FAILED']);

export type ReplyLabelText = 'Interested' | 'Unsure' | 'Needs review' | 'Not interested' | 'No reply' | 'Ignored';
export type ReplyLabelTone = 'success' | 'warning' | 'destructive' | 'info' | 'secondary';

/**
 * Interest status and reply state as one chip, in words — the same words as
 * the status filter, row/bulk menu and side panel (docs/DESIGN-SYSTEM.md
 * "Status vocabulary"). PENDING means "not classified yet": "No reply" until
 * they write, then "Needs review" (like NEEDS_REVIEW and legacy REPLIED).
 */
export function replyLabel(c: Pick<Candidate, 'status' | 'lastInboundAt' | 'repliedAt'>): {
  text: ReplyLabelText;
  tone: ReplyLabelTone;
} {
  switch (c.status) {
    case 'INTERESTED':
      return { text: 'Interested', tone: 'success' };
    case 'NOT_INTERESTED':
      return { text: 'Not interested', tone: 'destructive' };
    case 'IGNORED':
      return { text: 'Ignored', tone: 'secondary' };
    case 'NEUTRAL':
      return { text: 'Unsure', tone: 'warning' };
    case 'PENDING':
      return c.lastInboundAt || c.repliedAt ? { text: 'Needs review', tone: 'warning' } : { text: 'No reply', tone: 'info' };
    default:
      return { text: 'Needs review', tone: 'warning' };
  }
}

/** Latest message either way; `who` is null when only a fallback timestamp exists. */
export function lastActivity(c: Candidate): { at: string; who: 'them' | 'you' | null } {
  const inbound = c.lastInboundAt ? Date.parse(c.lastInboundAt) : 0;
  const outbound = c.lastOutboundAt ? Date.parse(c.lastOutboundAt) : 0;
  if (inbound || outbound) {
    return inbound >= outbound ? { at: c.lastInboundAt!, who: 'them' } : { at: c.lastOutboundAt!, who: 'you' };
  }
  // Never updatedAt: Lever/Gem syncs bump it without any message.
  return { at: c.threads?.[0]?.lastMessageAt ?? c.createdAt, who: null };
}

// ── Filters ──────────────────────────────────────────────────────────────

export type SortKey = 'name' | 'status' | 'lever' | 'role' | 'mailbox' | 'lastActivity';
export type SortDir = 'asc' | 'desc';

/** `status` '' (absent) = active (not ignored); 'ALL' includes ignored. */
export interface CandidateFilters {
  status?: string;
  reply?: 'AWAITING_REPLY';
  lever?: 'IN' | 'NOT_IN';
  q?: string;
  sort?: SortKey;
  dir?: SortDir;
}

export const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'INTERESTED', label: 'Interested' },
  { value: 'NEUTRAL', label: 'Unsure' },
  { value: 'NEEDS_REVIEW', label: 'Needs review' },
  { value: 'NOT_INTERESTED', label: 'Not interested' },
  { value: 'PENDING', label: 'No reply' },
  { value: 'IGNORED', label: 'Ignored' },
  { value: 'ALL', label: 'All, incl. ignored' },
];

/** Statuses a recruiter can set (row menu, bulk bar). */
export const SETTABLE_STATUSES: Array<{ value: Candidate['status']; label: string }> = [
  { value: 'INTERESTED', label: 'Interested' },
  { value: 'NEUTRAL', label: 'Unsure' },
  { value: 'NOT_INTERESTED', label: 'Not interested' },
  { value: 'NEEDS_REVIEW', label: 'Needs review' },
  { value: 'PENDING', label: 'No reply' },
];

const STATUSES = new Set([...STATUS_OPTIONS.map((o) => o.value), 'REPLIED']);
const SORT_KEYS = new Set<string>(['name', 'status', 'lever', 'role', 'mailbox', 'lastActivity']);
const FILTER_KEYS = ['status', 'reply', 'lever', 'q', 'sort', 'dir'] as const;

/** Filters from the URL. Legacy `?filter=` pills (Today page) still work. */
export function filtersFromParams(p: URLSearchParams): CandidateFilters {
  const f: CandidateFilters = {};
  const legacy = p.get('filter');
  const status = p.get('status') ?? (legacy === 'NEEDS_REVIEW' ? legacy : null);
  const reply = p.get('reply') ?? (legacy === 'AWAITING_REPLY' ? legacy : null);
  const lever = p.get('lever');
  const q = p.get('q')?.trim();
  const sort = p.get('sort');
  const dir = p.get('dir');
  if (status && STATUSES.has(status)) f.status = status;
  if (reply === 'AWAITING_REPLY') f.reply = reply;
  if (lever === 'IN' || lever === 'NOT_IN') f.lever = lever;
  if (q) f.q = q;
  if (sort && SORT_KEYS.has(sort)) f.sort = sort as SortKey;
  if (dir === 'asc' || dir === 'desc') f.dir = dir;
  return f;
}

/** The URL for new filters: keeps other params, drops page and the legacy pill. */
export function filtersToParams(prev: URLSearchParams, f: CandidateFilters): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const k of [...FILTER_KEYS, 'filter', 'page']) next.delete(k);
  for (const k of FILTER_KEYS) {
    const v = f[k];
    if (v) next.set(k, v);
  }
  return next;
}

type ApiParams = NonNullable<Parameters<typeof fetchCandidates>[0]>;

export function filtersToApi(
  f: CandidateFilters,
  opts: { page: number; limit: number; mailboxId?: string }
): ApiParams {
  const sort = f.sort ?? 'lastActivity';
  const out: ApiParams = { page: opts.page, limit: opts.limit };
  if (opts.mailboxId) out.mailboxId = opts.mailboxId;
  if (f.status && f.status !== 'ALL') out.status = f.status;
  if (f.reply) out.replyStatus = f.reply;
  if (f.lever) out.lever = f.lever;
  if (f.q) out.search = f.q;
  out.includeIgnored = f.status === 'ALL' || f.status === 'IGNORED';
  out.sort = sort as CandidateSortColumn;
  out.dir = f.dir ?? (sort === 'lastActivity' ? 'desc' : 'asc');
  return out;
}

/** Same filter set (sort is a view preference, not a filter). */
export function sameFilters(a: CandidateFilters, b: CandidateFilters): boolean {
  return (['status', 'reply', 'lever', 'q'] as const).every((k) => (a[k] || '') === (b[k] || ''));
}

/** What a saved view stores (SavedView.filters). */
export function viewFilters(f: CandidateFilters): CandidateFilters {
  const out: CandidateFilters = {};
  for (const k of FILTER_KEYS) {
    const v = f[k];
    if (v) (out as Record<string, string>)[k] = v;
  }
  return out;
}

export function activeFilterChips(f: CandidateFilters): Array<{ key: 'status' | 'reply' | 'lever' | 'q'; label: string }> {
  const chips: Array<{ key: 'status' | 'reply' | 'lever' | 'q'; label: string }> = [];
  if (f.status) {
    const label = STATUS_OPTIONS.find((o) => o.value === f.status)?.label ?? f.status;
    chips.push({ key: 'status', label: `Status: ${label}` });
  }
  if (f.reply) chips.push({ key: 'reply', label: 'Awaiting your reply' });
  if (f.lever) chips.push({ key: 'lever', label: f.lever === 'IN' ? 'In Lever' : 'Not in Lever' });
  if (f.q) chips.push({ key: 'q', label: `Search: “${f.q}”` });
  return chips;
}

export interface CandidateView {
  id: string;
  name: string;
  filters: CandidateFilters;
  /** Built-in, team-shared (userId null) or the caller's own. */
  kind: 'default' | 'team' | 'personal';
}

export const DEFAULT_VIEWS: CandidateView[] = [
  { id: 'all', name: 'All active', filters: {}, kind: 'default' },
  { id: 'awaiting', name: 'Awaiting your reply', filters: { reply: 'AWAITING_REPLY' }, kind: 'default' },
  { id: 'interested-not-in-lever', name: 'Interested · not in Lever', filters: { status: 'INTERESTED', lever: 'NOT_IN' }, kind: 'default' },
  { id: 'needs-review', name: 'Needs review', filters: { status: 'NEEDS_REVIEW' }, kind: 'default' },
];

// Pure helpers for the R2 Inbox: label wording, view metadata, snooze
// presets (ET), evidence highlighting, word diff and auto-advance.
import type { ConfidenceLabel, InboxItem, InboxView } from './api';

export type LabelTone = 'success' | 'warning' | 'destructive';
export type LabelText = 'Interested' | 'Unsure' | 'Not interested';

/** The classifier's label in words. NEUTRAL or low confidence reads "Unsure". */
export function labelFor(
  classification: string,
  confidenceLabel?: ConfidenceLabel | null
): { text: LabelText; tone: LabelTone } {
  if (classification === 'NEUTRAL' || confidenceLabel === 'low') return { text: 'Unsure', tone: 'warning' };
  if (classification === 'INTERESTED') return { text: 'Interested', tone: 'success' };
  if (classification === 'NOT_INTERESTED') return { text: 'Not interested', tone: 'destructive' };
  return { text: 'Unsure', tone: 'warning' };
}

export const VIEWS: Array<{ id: InboxView; label: string; empty: string; hint: string }> = [
  {
    id: 'needs_review',
    label: 'Needs review',
    empty: 'Inbox zero — nothing waiting',
    hint: "Unsure labels, failed sends and replies Claude couldn't read land here.",
  },
  {
    id: 'interested',
    label: 'Interested',
    empty: 'Inbox zero — nothing waiting',
    hint: 'Candidates who want to talk land here, with a hand-off reply drafted.',
  },
  {
    id: 'not_interested',
    label: 'Not interested',
    empty: 'Inbox zero — nothing waiting',
    hint: 'Polite declines land here — select several to send in one go.',
  },
  { id: 'snoozed', label: 'Snoozed', empty: 'Nothing snoozed', hint: 'Press S on a reply to bring it back later.' },
  {
    id: 'sent_today',
    label: 'Sent today',
    empty: 'Nothing sent yet today',
    hint: 'Replies you send show up here, with undo while they are sending.',
  },
];

export function isInboxView(v: string | null | undefined): v is InboxView {
  return VIEWS.some((x) => x.id === v);
}

// ── Role filter / grouping ───────────────────────────────────────────────
/** `?role=` value for candidates whose role Claude couldn't detect. */
export const ROLE_UNKNOWN = '__none__';
export const ROLE_UNKNOWN_LABEL = 'Role unknown';

export type InboxSort = 'newest' | 'oldest';
export const SORTS: Array<{ id: InboxSort; label: string }> = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest waiting first' },
];

/** Role key of an item: the trimmed role, or ROLE_UNKNOWN. */
export function roleKey(item: InboxItem): string {
  return item.candidate?.role?.trim() || ROLE_UNKNOWN;
}

export interface RoleGroup {
  key: string;
  label: string;
  count: number;
  items: InboxItem[];
}

/**
 * Sections for "Group by role": count desc, then name; Role unknown last.
 * Counts come from the server's roleCounts (the whole view); a role missing
 * there falls back to how many are loaded. Items keep their list order.
 */
export function groupByRole(items: InboxItem[], roleCounts: Array<{ role: string | null; count: number }> = []): RoleGroup[] {
  const total = new Map(roleCounts.map((r) => [r.role?.trim() || ROLE_UNKNOWN, r.count]));
  const groups = new Map<string, RoleGroup>();
  for (const item of items) {
    const key = roleKey(item);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: key === ROLE_UNKNOWN ? ROLE_UNKNOWN_LABEL : key, count: 0, items: [] };
      groups.set(key, g);
    }
    g.items.push(item);
  }
  for (const g of groups.values()) g.count = total.get(g.key) ?? g.items.length;
  return [...groups.values()].sort((a, b) => {
    if (a.key === ROLE_UNKNOWN || b.key === ROLE_UNKNOWN) return a.key === ROLE_UNKNOWN ? 1 : -1;
    return b.count - a.count || a.label.localeCompare(b.label);
  });
}

// ── ET time ──────────────────────────────────────────────────────────────
const ET = 'America/New_York';

function etParts(d: Date): { y: number; m: number; d: number; weekday: number; h: number; min: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { y: +get('year'), m: +get('month'), d: +get('day'), weekday, h: +get('hour'), min: +get('minute') };
}

/** UTC offset of ET (in hours, e.g. -4) at the given instant. */
function etOffsetHours(at: Date): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: ET, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  return Number(name.replace('GMT', '') || '0');
}

/** The instant that is `h:min` ET on calendar day y-m-d (month 1-based; overflow allowed). */
function etWallTime(y: number, m: number, d: number, h: number, min = 0): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  return new Date(guess - etOffsetHours(new Date(guess)) * 3600_000);
}

/** "2:00 PM" in ET. */
function etClock(d: Date): string {
  return d.toLocaleTimeString('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' });
}

/**
 * An instant in ET, labelled ("Fri, Oct 23, 9:00 AM ET"). Snoozes are
 * scheduled in ET, so they're shown in ET whatever the browser's zone.
 */
export function formatEt(d: Date): string {
  const date = d.toLocaleDateString('en-US', { timeZone: ET, weekday: 'short', month: 'short', day: 'numeric' });
  return `${date}, ${etClock(d)} ET`;
}

/** An instant in ET with the year ("Oct 21, 2026, 3:04 PM ET"), for exact timestamps. */
export function formatEtFull(d: Date): string {
  const date = d.toLocaleDateString('en-US', { timeZone: ET, month: 'short', day: 'numeric', year: 'numeric' });
  return `${date}, ${etClock(d)} ET`;
}

export type SnoozeKey = 'later' | 'tomorrow' | 'next_week';

export function snoozePresets(now: Date): Array<{ key: SnoozeKey; label: string; until: Date }> {
  const p = etParts(now);
  const endOfDay = etWallTime(p.y, p.m, p.d, 23, 59);
  const later = new Date(Math.min(now.getTime() + 3 * 3600_000, endOfDay.getTime()));
  const daysToMonday = ((8 - p.weekday) % 7) || 7;
  return [
    { key: 'later', label: `Later today · ${etClock(later)} ET`, until: later },
    { key: 'tomorrow', label: 'Tomorrow 9am ET', until: etWallTime(p.y, p.m, p.d + 1, 9) },
    { key: 'next_week', label: 'Next week · Mon 9am ET', until: etWallTime(p.y, p.m, p.d + daysToMonday, 9) },
  ];
}

/** Custom snooze: 9am ET on the chosen `YYYY-MM-DD`. */
export function customSnooze(dateYmd: string): Date {
  const [y, m, d] = dateYmd.split('-').map(Number);
  return etWallTime(y, m, d, 9);
}

export function highlightSegments(text: string, quote: string | null | undefined): Array<{ text: string; mark: boolean }> {
  const at = quote ? text.indexOf(quote) : -1;
  if (!quote || at < 0) return [{ text, mark: false }];
  return [
    { text: text.slice(0, at), mark: false },
    { text: quote, mark: true },
    { text: text.slice(at + quote.length), mark: false },
  ].filter((s) => s.text.length > 0);
}

export type DiffOp = 'same' | 'add' | 'del';

/** Word-level diff (LCS over word and whitespace tokens), adjacent ops merged. */
export function diffWords(before: string, after: string): Array<{ text: string; op: DiffOp }> {
  const a = before.match(/\s+|[^\s]+/g) ?? [];
  const b = after.match(/\s+|[^\s]+/g) ?? [];
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Array<{ text: string; op: DiffOp }> = [];
  const push = (text: string, op: DiffOp) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ text, op });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(a[i], 'same');
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push(a[i++], 'del');
    } else {
      push(b[j++], 'add');
    }
  }
  while (i < n) push(a[i++], 'del');
  while (j < m) push(b[j++], 'add');
  return out;
}

export function sendLine(mailbox: string, ccFirstName: string | null): string {
  return `Sending as ${mailbox} · CC ${ccFirstName ?? 'no one'}`;
}

/** Item to open after acting on `current`: the next one, else the previous, else none. */
export function nextItemId(ids: string[], current: string): string | null {
  const at = ids.indexOf(current);
  if (at < 0) return ids[0] ?? null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

/** A message body as plain text: the text part, else the HTML with tags stripped. */
export function messagePlainText(bodyText: string | null | undefined, bodyHtml: string | null | undefined): string {
  if (bodyText && bodyText.trim()) return bodyText;
  if (!bodyHtml) return '';
  return bodyHtml
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Triage drafts (H8) ───────────────────────────────────────────────────

/** A recruiter's decision on a draftless Needs-review candidate. */
export type TriageClass = 'INTERESTED' | 'NOT_INTERESTED';

/** The view a triage draft lands in (it has confidence 1, so never Needs review). */
export function viewForClass(c: TriageClass): 'interested' | 'not_interested' {
  return c === 'INTERESTED' ? 'interested' : 'not_interested';
}

/** "Hand-off to Sofia from paul.b@" for a hand-off draft, else "Reply from <mailbox>". */
export function draftedLine(opts: {
  classification: string;
  mailbox: string;
  ccEmail?: string | null;
  ccFirstName?: string | null;
}): string {
  const { classification, mailbox, ccEmail } = opts;
  const handoff = classification === 'INTERESTED' && !!ccEmail && ccEmail.toLowerCase() !== mailbox.toLowerCase();
  if (!handoff) return `Reply from ${mailbox}`;
  const local = ccEmail.split('@')[0];
  const cc = opts.ccFirstName ?? local.charAt(0).toUpperCase() + local.slice(1);
  return `Hand-off to ${cc} from ${mailbox.split('@')[0]}@`;
}

// ── Inbox pass 2 (U1b) ───────────────────────────────────────────────────

/** URL key of an item: the draft id, or `candidate:<id>` for draftless rows. */
export function itemKey(item: InboxItem): string {
  return item.kind === 'candidate' ? `candidate:${item.id}` : item.id;
}

/** Loaded pages in order; an item that slid across a page boundary between polls appears once. */
export function mergePages(pages: InboxItem[][]): InboxItem[] {
  const seen = new Set<string>();
  const out: InboxItem[] = [];
  for (const page of pages) {
    for (const item of page) {
      const key = itemKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/** The 423 alert's warning, worded for the action being blocked. */
const LOCK_VERBS: Record<string, string> = {
  Send: 'Sending',
  Dismiss: 'Dismissing',
  Rewrite: 'Rewriting',
  Regenerate: 'Regenerating',
  Change: 'Changing the CC',
  Restore: 'Restoring',
};

export function lockWarning(actionLabel: string): string {
  const verb = LOCK_VERBS[actionLabel.split(' ')[0]] ?? 'Acting';
  return `${verb} now may overwrite their changes.`;
}

const EXPIRY_WARN_MS = 3 * 86_400_000;

/** "Expires in 2d" / "Expires in 5h" / "Expires soon" within 3 days of expiry, else null. */
export function expiresIn(expiresAt: string | null | undefined, now: number = Date.now()): string | null {
  if (!expiresAt) return null;
  const left = new Date(expiresAt).getTime() - now;
  if (!(left > 0) || left > EXPIRY_WARN_MS) return null;
  const hours = Math.floor(left / 3_600_000);
  if (hours >= 24) return `Expires in ${Math.floor(hours / 24)}d`;
  if (hours >= 1) return `Expires in ${hours}h`;
  return 'Expires soon';
}

/** Views a new candidate reply can land in (snoozed/sent only change through our own actions). */
const ARRIVAL_VIEWS: InboxView[] = ['needs_review', 'interested', 'not_interested'];

/** How many replies arrived between two polls' counts; 0 without a baseline. */
export function newReplyDelta(prev: Record<InboxView, number> | null, next: Record<InboxView, number>): number {
  if (!prev) return 0;
  const sum = (c: Record<InboxView, number>) => ARRIVAL_VIEWS.reduce((n, v) => n + (c[v] ?? 0), 0);
  return Math.max(0, sum(next) - sum(prev));
}

/** Screen-reader summary after an action: "Sent to Ana. Opened Ben." */
export function liveSummary(done: string, opened?: string): string {
  return opened ? `${done}. Opened ${opened}.` : `${done}.`;
}

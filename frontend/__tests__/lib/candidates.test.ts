import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEWS,
  SETTABLE_STATUSES,
  STATUS_OPTIONS,
  activeFilterChips,
  filtersFromParams,
  filtersToApi,
  filtersToParams,
  lastActivity,
  replyLabel,
  sameFilters,
  viewFilters,
} from '../../src/lib/candidates';
import type { Candidate } from '../../src/lib/api';

const base: Candidate = {
  id: 'c1',
  name: 'Ada',
  email: 'ada@example.org',
  status: 'PENDING',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};
const c = (o: Partial<Candidate>): Candidate => ({ ...base, ...o });

describe('replyLabel — one chip for interest + reply state', () => {
  it.each([
    ['INTERESTED', 'Interested', 'success'],
    ['NOT_INTERESTED', 'Not interested', 'destructive'],
    ['NEUTRAL', 'Unsure', 'warning'],
    ['NEEDS_REVIEW', 'Needs review', 'warning'],
    ['REPLIED', 'Needs review', 'warning'],
    ['IGNORED', 'Ignored', 'secondary'],
  ] as const)('%s reads "%s" (%s)', (status, text, tone) => {
    expect(replyLabel(c({ status }))).toEqual({ text, tone });
  });

  it('PENDING with nothing from them reads "No reply"; once they wrote it is "Needs review"', () => {
    expect(replyLabel(c({ status: 'PENDING' }))).toEqual({ text: 'No reply', tone: 'info' });
    expect(replyLabel(c({ status: 'PENDING', lastInboundAt: '2026-10-03T00:00:00.000Z' }))).toEqual({
      text: 'Needs review',
      tone: 'warning',
    });
  });
});

describe('status vocabulary (U2a) — chip, filter and bulk menu use the same words', () => {
  const label = (opts: Array<{ value: string; label: string }>, v: string) => opts.find((o) => o.value === v)?.label;

  it.each([
    ['INTERESTED', 'Interested'],
    ['NEUTRAL', 'Unsure'],
    ['NEEDS_REVIEW', 'Needs review'],
    ['NOT_INTERESTED', 'Not interested'],
    ['PENDING', 'No reply'],
  ])('%s is "%s" in the filter and the bulk/row menu', (value, text) => {
    expect(label(STATUS_OPTIONS, value)).toBe(text);
    expect(label(SETTABLE_STATUSES, value)).toBe(text);
  });

  it('the chip says the same word as the filter for every settable status', () => {
    for (const { value, label: text } of SETTABLE_STATUSES) {
      expect(replyLabel(c({ status: value })).text).toBe(text);
    }
  });

  it('never says "Pending" to a recruiter', () => {
    expect([...STATUS_OPTIONS, ...SETTABLE_STATUSES].map((o) => o.label)).not.toContain('Pending');
  });
});

describe('lastActivity', () => {
  it('is the later of their last message and ours, saying who wrote it', () => {
    expect(lastActivity(c({ lastInboundAt: '2026-10-05T00:00:00.000Z', lastOutboundAt: '2026-10-04T00:00:00.000Z' }))).toEqual({
      at: '2026-10-05T00:00:00.000Z',
      who: 'them',
    });
    expect(lastActivity(c({ lastInboundAt: '2026-10-03T00:00:00.000Z', lastOutboundAt: '2026-10-04T00:00:00.000Z' }))).toEqual({
      at: '2026-10-04T00:00:00.000Z',
      who: 'you',
    });
  });
  it('falls back to the latest thread, then createdAt (never updatedAt: syncs bump it)', () => {
    expect(lastActivity(c({ threads: [{ lastMessageAt: '2026-10-06T00:00:00.000Z' } as never] }))).toEqual({
      at: '2026-10-06T00:00:00.000Z',
      who: null,
    });
    expect(lastActivity(c({}))).toEqual({ at: '2026-10-01T00:00:00.000Z', who: null });
  });
});

describe('URL ⇄ filters', () => {
  it('reads status, reply, lever, q, sort and dir; drops unknown values', () => {
    const p = new URLSearchParams('status=INTERESTED&reply=AWAITING_REPLY&lever=NOT_IN&q=ada&sort=role&dir=desc&x=1');
    expect(filtersFromParams(p)).toEqual({
      status: 'INTERESTED',
      reply: 'AWAITING_REPLY',
      lever: 'NOT_IN',
      q: 'ada',
      sort: 'role',
      dir: 'desc',
    });
    expect(filtersFromParams(new URLSearchParams('status=BOGUS&lever=MAYBE&sort=passwordHash&dir=up'))).toEqual({});
  });

  it('maps the Today page legacy ?filter= pills', () => {
    expect(filtersFromParams(new URLSearchParams('filter=AWAITING_REPLY'))).toEqual({ reply: 'AWAITING_REPLY' });
    expect(filtersFromParams(new URLSearchParams('filter=NEEDS_REVIEW'))).toEqual({ status: 'NEEDS_REVIEW' });
  });

  it('writes only the set filters back', () => {
    const next = filtersToParams(new URLSearchParams('mailboxId=mb1&filter=NEEDS_REVIEW&page=3&status=PENDING'), {
      lever: 'IN',
      q: 'bo',
    });
    expect(Object.fromEntries(next)).toEqual({ mailboxId: 'mb1', lever: 'IN', q: 'bo' });
  });
});

describe('filtersToApi — server params', () => {
  it('defaults to active candidates, newest activity first', () => {
    expect(filtersToApi({}, { page: 1, limit: 50 })).toEqual({
      page: 1,
      limit: 50,
      includeIgnored: false,
      sort: 'lastActivity',
      dir: 'desc',
    });
  });

  it('sends search together with every filter', () => {
    expect(
      filtersToApi(
        { status: 'INTERESTED', reply: 'AWAITING_REPLY', lever: 'NOT_IN', q: 'ada', sort: 'mailbox', dir: 'asc' },
        { page: 2, limit: 50, mailboxId: 'mb1' }
      )
    ).toEqual({
      page: 2,
      limit: 50,
      mailboxId: 'mb1',
      status: 'INTERESTED',
      replyStatus: 'AWAITING_REPLY',
      lever: 'NOT_IN',
      search: 'ada',
      includeIgnored: false,
      sort: 'mailbox',
      dir: 'asc',
    });
  });

  it('ALL and IGNORED include ignored candidates; ALL sends no status', () => {
    expect(filtersToApi({ status: 'ALL' }, { page: 1, limit: 50 })).toMatchObject({ includeIgnored: true });
    expect(filtersToApi({ status: 'ALL' }, { page: 1, limit: 50 }).status).toBeUndefined();
    expect(filtersToApi({ status: 'IGNORED' }, { page: 1, limit: 50 })).toMatchObject({ status: 'IGNORED', includeIgnored: true });
  });

  it('a column sort without a dir is ascending (activity: descending)', () => {
    expect(filtersToApi({ sort: 'name' }, { page: 1, limit: 50 })).toMatchObject({ sort: 'name', dir: 'asc' });
  });
});

describe('saved views', () => {
  it('ships the four default views with the right filters', () => {
    expect(DEFAULT_VIEWS.map((v) => [v.name, v.filters])).toEqual([
      ['All active', {}],
      ['Awaiting your reply', { reply: 'AWAITING_REPLY' }],
      ['Interested · not in Lever', { status: 'INTERESTED', lever: 'NOT_IN' }],
      ['Needs review', { status: 'NEEDS_REVIEW' }],
    ]);
  });

  it('sameFilters compares filters, not sort', () => {
    expect(sameFilters({ status: 'INTERESTED', sort: 'name' }, { status: 'INTERESTED' })).toBe(true);
    expect(sameFilters({ status: 'INTERESTED' }, { status: 'INTERESTED', lever: 'NOT_IN' })).toBe(false);
    expect(sameFilters({}, { q: '' })).toBe(true);
  });

  it('viewFilters keeps the known keys only (stored as SavedView.filters)', () => {
    expect(viewFilters({ status: 'INTERESTED', q: '', sort: 'role', dir: 'asc', junk: 1 } as never)).toEqual({
      status: 'INTERESTED',
      sort: 'role',
      dir: 'asc',
    });
  });
});

describe('activeFilterChips', () => {
  it('names each active filter in words, removable by key', () => {
    expect(activeFilterChips({ status: 'NEUTRAL', reply: 'AWAITING_REPLY', lever: 'IN', q: 'ada' })).toEqual([
      { key: 'status', label: 'Status: Unsure' },
      { key: 'reply', label: 'Awaiting your reply' },
      { key: 'lever', label: 'In Lever' },
      { key: 'q', label: 'Search: “ada”' },
    ]);
    expect(activeFilterChips({ sort: 'name' })).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hoursSince,
  isOverdue,
  OVERDUE_THRESHOLD_HOURS,
} from '../../src/lib/utils';

const NOW = new Date('2026-06-04T12:00:00.000Z');

describe('hoursSince', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the calendar hours elapsed since the given date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const tenHoursAgo = new Date(NOW.getTime() - 10 * 60 * 60 * 1000);
    expect(hoursSince(tenHoursAgo)).toBeCloseTo(10, 5);
  });

  it('accepts an ISO string', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const oneHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    expect(hoursSince(oneHourAgo)).toBeCloseTo(1, 5);
  });
});

describe('isOverdue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flags a message that has waited longer than 48 hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const overdue = new Date(NOW.getTime() - 49 * 60 * 60 * 1000);
    expect(isOverdue(overdue)).toBe(true);
  });

  it('does not flag a fresh message', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fresh = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    expect(isOverdue(fresh)).toBe(false);
  });

  it('treats exactly 48 hours as the boundary (not yet overdue)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const exactly48h = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);
    expect(isOverdue(exactly48h)).toBe(false);
  });

  it('defaults its threshold to OVERDUE_THRESHOLD_HOURS (48)', () => {
    expect(OVERDUE_THRESHOLD_HOURS).toBe(48);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const justOver = new Date(NOW.getTime() - 48.5 * 60 * 60 * 1000);
    expect(isOverdue(justOver)).toBe(true);
    expect(isOverdue(justOver, 72)).toBe(false);
  });
});

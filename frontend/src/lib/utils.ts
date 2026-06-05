import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTimeAgo(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// Calendar hours a candidate has been waiting; anything past this threshold is
// surfaced as "overdue" on the Pending drafts queue.
export const OVERDUE_THRESHOLD_HOURS = 48;

export function hoursSince(date: Date | string): number {
  const d = typeof date === 'string' ? new Date(date) : date;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60);
}

export function isOverdue(
  date: Date | string,
  thresholdHours = OVERDUE_THRESHOLD_HOURS
): boolean {
  return hoursSince(date) > thresholdHours;
}

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

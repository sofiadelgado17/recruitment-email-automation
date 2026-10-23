// The row age says how long ago the candidate's email arrived; hovering it
// shows the exact time so "56d" vs "2h" is never a mystery.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AgeStamp } from '../../../src/components/inbox/chips';
import { TooltipProvider } from '../../../src/components/ui/tooltip';
import { formatEtFull } from '../../../src/lib/inbox';

const AT = '2026-10-21T19:04:00.000Z'; // 3:04 PM EDT

async function hoverText(): Promise<string> {
  await userEvent.hover(screen.getByText('56d'));
  return (await screen.findByRole('tooltip')).textContent ?? '';
}

describe('AgeStamp', () => {
  it('shows the age with the exact received time in a tooltip', async () => {
    render(
      <TooltipProvider>
        <AgeStamp ageMs={56 * 86400_000} at={AT} />
      </TooltipProvider>
    );
    expect(screen.getByText('56d').closest('time')).toHaveAttribute('dateTime', AT);
    expect(await hoverText()).toContain('Received Oct 21, 2026, 3:04 PM ET');
  });

  it('says Sent for sent rows', async () => {
    render(
      <TooltipProvider>
        <AgeStamp ageMs={56 * 86400_000} at={AT} verb="Sent" />
      </TooltipProvider>
    );
    expect(await hoverText()).toContain('Sent Oct 21, 2026, 3:04 PM ET');
  });
});

describe('formatEtFull', () => {
  it('formats an instant in ET with the year, across DST', () => {
    expect(formatEtFull(new Date(AT))).toBe('Oct 21, 2026, 3:04 PM ET');
    expect(formatEtFull(new Date('2026-12-01T17:30:00Z'))).toBe('Dec 1, 2026, 12:30 PM ET');
  });
});

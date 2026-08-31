import { describe, expect, it } from 'vitest';
import { icsCaptureLine } from '../src/data/icsCapture';
import type { CalEvent } from '../src/lib/types';

function calEvent(over: Partial<CalEvent> = {}): CalEvent {
  return {
    uid: 'cal-uid-1',
    title: 'Team sync',
    start: new Date(2026, 7, 31, 10, 0),
    end: new Date(2026, 7, 31, 11, 0),
    allDay: false,
    ...over,
  };
}

describe('icsCaptureLine', () => {
  it('formats a checkbox line with the Day Planner range, title and ics-uid marker', () => {
    expect(icsCaptureLine(calEvent())).toBe('- [ ] 10:00 - 11:00 Team sync [ics-uid:: cal-uid-1]');
  });

  it('carries no scheduled-date stamp — the drop lands on the rail, not the grid', () => {
    const line = icsCaptureLine(calEvent());
    expect(line).not.toMatch(/⏳/);
    expect(line).not.toMatch(/scheduled::/);
  });

  it('clamps an event that runs past midnight to the bottom of the day it starts on', () => {
    const ev = calEvent({
      start: new Date(2026, 7, 31, 23, 0),
      end: new Date(2026, 8, 1, 1, 0),
    });
    // `dayPlannerRange`'s own `hhmm` wraps minutes-of-day modulo 24h, so the
    // clamped end (1440) prints as `00:00` rather than `24:00` — the same
    // formatting every other caller of `dayPlannerRange` already gets.
    expect(icsCaptureLine(ev)).toBe('- [ ] 23:00 - 00:00 Team sync [ics-uid:: cal-uid-1]');
  });

  it('round-trips through findIcsLinks', async () => {
    const { findIcsLinks } = await import('../src/data/parse');
    const line = icsCaptureLine(calEvent({ uid: 'abc/def-123' }));
    const links = findIcsLinks(line, 'Weekly/2026-W36.md');
    expect(links).toHaveLength(1);
    expect(links[0].uid).toBe('abc/def-123');
  });
});

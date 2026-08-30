import { describe, expect, it } from 'vitest';
import { DURATION_CHOICES, dueChoices, isoDate, nextWeekday } from '../src/data/dates';

// 2026-08-30 is a Sunday; 2026-08-31 a Monday.
const SUNDAY = new Date(2026, 7, 30, 14, 30);
const MONDAY = new Date(2026, 7, 31, 9, 0);
const FRIDAY = new Date(2026, 8, 4, 23, 59);

describe('isoDate', () => {
  it('formats a local calendar date', () => {
    expect(isoDate(new Date(2026, 8, 4))).toBe('2026-09-04');
    expect(isoDate(new Date(2026, 0, 1))).toBe('2026-01-01');
  });

  // `toISOString` would answer in UTC, which is a different day for most of
  // the world for part of every day. A due date is a day someone wrote down.
  it('does not shift the day for a late-evening local time', () => {
    expect(isoDate(new Date(2026, 8, 4, 23, 59, 59))).toBe('2026-09-04');
  });

  it('does not shift the day for an early-morning local time', () => {
    expect(isoDate(new Date(2026, 8, 4, 0, 0, 1))).toBe('2026-09-04');
  });
});

describe('nextWeekday', () => {
  it('finds the coming Friday from a Sunday', () => {
    expect(isoDate(nextWeekday(SUNDAY, 5))).toBe('2026-09-04');
  });

  it('finds the coming Monday from a Sunday — tomorrow', () => {
    expect(isoDate(nextWeekday(SUNDAY, 1))).toBe('2026-08-31');
  });

  it('finds next Monday from a Monday, not today', () => {
    expect(isoDate(nextWeekday(MONDAY, 1))).toBe('2026-09-07');
  });

  // The one that matters: "This Friday" on a Friday must mean the next one.
  // Resolving to today would make the item a silent no-op once a week.
  it('never returns the day it was asked on', () => {
    expect(isoDate(nextWeekday(FRIDAY, 5))).toBe('2026-09-11');
    for (let d = 0; d < 7; d++) {
      const from = new Date(2026, 7, 30 + d);
      for (let wd = 1; wd <= 7; wd++) {
        expect(isoDate(nextWeekday(from, wd))).not.toBe(isoDate(from));
      }
    }
  });

  it('always lands on the weekday asked for', () => {
    for (let d = 0; d < 14; d++) {
      const from = new Date(2026, 7, 30 + d);
      for (let wd = 1; wd <= 7; wd++) {
        const got = nextWeekday(from, wd);
        expect(got.getDay() === 0 ? 7 : got.getDay()).toBe(wd);
      }
    }
  });

  it('is always within the next seven days', () => {
    for (let wd = 1; wd <= 7; wd++) {
      const days = (nextWeekday(SUNDAY, wd).getTime() - new Date(2026, 7, 30).getTime()) / 86400000;
      expect(days).toBeGreaterThanOrEqual(1);
      expect(days).toBeLessThanOrEqual(7);
    }
  });

  it('does not mutate the date it was given', () => {
    const from = new Date(2026, 7, 30, 14, 30);
    const before = from.getTime();
    nextWeekday(from, 5);
    expect(from.getTime()).toBe(before);
  });
});

describe('dueChoices', () => {
  it('offers them nearest-first, none in the past', () => {
    const choices = dueChoices(SUNDAY);
    // Sunday: 'Next Monday' is tomorrow, so it is dropped as a duplicate.
    expect(choices.map((c) => c.label)).toEqual(['Today', 'Tomorrow', 'This Friday']);
    const dates = choices.map((c) => c.date);
    expect([...dates].sort()).toEqual(dates);
    for (const d of dates) expect(d >= '2026-08-30').toBe(true);
  });

  it('gives today as today, whatever the hour', () => {
    expect(dueChoices(new Date(2026, 7, 30, 23, 59)).find((c) => c.label === 'Today')!.date).toBe(
      '2026-08-30',
    );
  });

  it('crosses a month boundary correctly', () => {
    expect(dueChoices(new Date(2026, 7, 31)).find((c) => c.label === 'Tomorrow')!.date).toBe(
      '2026-09-01',
    );
  });

  it('crosses a year boundary correctly', () => {
    expect(dueChoices(new Date(2026, 11, 31)).find((c) => c.label === 'Tomorrow')!.date).toBe(
      '2027-01-01',
    );
  });
});

describe('DURATION_CHOICES', () => {
  // The planner snaps to 30 minutes. Offering a value it would immediately
  // change is offering a lie.
  it('are all whole multiples of a quarter hour, ascending', () => {
    expect([...DURATION_CHOICES].sort((a, b) => a - b)).toEqual([...DURATION_CHOICES]);
    for (const m of DURATION_CHOICES) expect(m % 15).toBe(0);
  });

  it('all sit inside taskmeta’s own sanity rails', () => {
    for (const m of DURATION_CHOICES) {
      expect(m).toBeGreaterThanOrEqual(5);
      expect(m).toBeLessThanOrEqual(12 * 60);
    }
  });
});

describe('dueChoices never offers the same date twice', () => {
  // A menu with two items that do exactly the same thing makes you stop and
  // work out whether they do. It happens about twice a week.
  it('drops the duplicate on every day of a fortnight', () => {
    for (let d = 0; d < 14; d++) {
      const choices = dueChoices(new Date(2026, 7, 30 + d));
      const dates = choices.map((c) => c.date);
      expect(new Set(dates).size, `duplicate on day ${d}: ${dates.join(', ')}`).toBe(dates.length);
      expect([...dates].sort()).toEqual(dates);
      expect(choices.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps the more immediate wording when two collide', () => {
    // Thursday: "Tomorrow" and "This Friday" are the same day.
    const thursday = dueChoices(new Date(2026, 8, 3));
    expect(thursday.map((c) => c.label)).toContain('Tomorrow');
    expect(thursday.map((c) => c.label)).not.toContain('This Friday');
  });

  it('keeps all four when nothing collides', () => {
    // Monday: tomorrow is Tuesday, Friday is Friday, next Monday is a week on.
    expect(dueChoices(new Date(2026, 7, 31))).toHaveLength(4);
  });
});

describe('dueChoices reads in time order', () => {
  // From a Saturday, "This Friday" is nearly a week out while "Next Monday"
  // is in two days — the written order is not the chronological one.
  it('puts Next Monday above This Friday on a Saturday', () => {
    const labels = dueChoices(new Date(2026, 8, 5)).map((c) => c.label);
    expect(labels.indexOf('Next Monday')).toBeLessThan(labels.indexOf('This Friday'));
  });

  it('is ascending on every day of a fortnight', () => {
    for (let d = 0; d < 14; d++) {
      const dates = dueChoices(new Date(2026, 7, 30 + d)).map((c) => c.date);
      expect([...dates].sort(), `out of order on day ${d}`).toEqual(dates);
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  addDays,
  addWeeks,
  dayIndex,
  fmtClock,
  fmtHourLabel,
  fmtMinutes,
  fmtWeekRange,
  isoWeekId,
  minutesOfDay,
  sameDate,
  startOfISOWeek,
} from '../src/lib/week';

/** Local-time date, so these read like the calendar rather than like UTC. */
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min);

describe('isoWeekId', () => {
  it('numbers ordinary weeks', () => {
    expect(isoWeekId(at(2026, 8, 24))).toBe('2026-W35'); // Monday
    expect(isoWeekId(at(2026, 8, 30))).toBe('2026-W35'); // the Sunday after
    expect(isoWeekId(at(2026, 8, 31))).toBe('2026-W36'); // next Monday
  });

  it('assigns January days to the previous year when ISO says so', () => {
    // ISO 8601: a week belongs to the year containing its Thursday.
    expect(isoWeekId(at(2027, 1, 1))).toBe('2026-W53');
    expect(isoWeekId(at(2027, 1, 3))).toBe('2026-W53'); // Sunday of W53
    expect(isoWeekId(at(2027, 1, 4))).toBe('2027-W01'); // Monday of W01
    expect(isoWeekId(at(2021, 1, 3))).toBe('2020-W53');
    expect(isoWeekId(at(2016, 1, 3))).toBe('2015-W53');
  });

  it('assigns late-December days to the next year when ISO says so', () => {
    expect(isoWeekId(at(2025, 12, 28))).toBe('2025-W52');
    expect(isoWeekId(at(2025, 12, 29))).toBe('2026-W01'); // Monday
    expect(isoWeekId(at(2024, 12, 30))).toBe('2025-W01');
    expect(isoWeekId(at(2019, 12, 30))).toBe('2020-W01');
  });

  it('produces W53 only in long years', () => {
    expect(isoWeekId(at(2026, 12, 31))).toBe('2026-W53'); // 2026 starts on a Thursday
    expect(isoWeekId(at(2025, 12, 31))).toBe('2026-W01'); // 2025 is a 52-week year
  });

  it('is stable across every day of a week', () => {
    const monday = at(2026, 9, 28);
    const ids = new Set(
      Array.from({ length: 7 }, (_, i) => isoWeekId(addDays(monday, i))),
    );
    expect([...ids]).toEqual(['2026-W40']);
  });
});

describe('startOfISOWeek', () => {
  it('walks back to Monday midnight from any day', () => {
    for (let i = 0; i < 7; i++) {
      const start = startOfISOWeek(addDays(at(2026, 8, 24, 13, 45), i));
      expect(start.getDay()).toBe(1); // Monday
      expect([start.getFullYear(), start.getMonth() + 1, start.getDate()]).toEqual([
        2026, 8, 24,
      ]);
      expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0]);
    }
  });

  it('treats Sunday as the end of the week, not the start', () => {
    const sunday = at(2026, 8, 30, 23, 59);
    expect(startOfISOWeek(sunday).getDate()).toBe(24);
  });

  it('crosses a month and a year boundary', () => {
    expect(startOfISOWeek(at(2026, 9, 2)).getDate()).toBe(31); // Mon 31 Aug
    expect(startOfISOWeek(at(2027, 1, 1)).getDate()).toBe(28); // Mon 28 Dec 2026
    expect(startOfISOWeek(at(2027, 1, 1)).getFullYear()).toBe(2026);
  });
});

describe('addDays / addWeeks', () => {
  it('rolls over month and year ends', () => {
    expect(addDays(at(2026, 8, 31), 1).getMonth()).toBe(8); // September
    expect(addDays(at(2026, 12, 31), 1).getFullYear()).toBe(2027);
    expect(addWeeks(at(2026, 8, 24), 2).getDate()).toBe(7); // Mon 7 Sep
  });

  it('handles a leap day', () => {
    const d = addDays(at(2028, 2, 28), 1);
    expect([d.getMonth() + 1, d.getDate()]).toEqual([2, 29]);
  });

  it('keeps the wall-clock time it was given', () => {
    const d = addDays(at(2026, 8, 24, 18, 30), 3);
    expect([d.getHours(), d.getMinutes()]).toEqual([18, 30]);
  });
});

describe('dayIndex', () => {
  const weekStart = at(2026, 8, 24); // Mon 24 Aug 2026

  it('maps each day of the week to its column', () => {
    for (let i = 0; i < 7; i++) {
      expect(dayIndex(addDays(weekStart, i), weekStart)).toBe(i);
    }
  });

  it('ignores the time of day', () => {
    expect(dayIndex(at(2026, 8, 26, 0, 1), weekStart)).toBe(2);
    expect(dayIndex(at(2026, 8, 26, 23, 59), weekStart)).toBe(2);
  });

  it('falls outside 0..6 for other weeks — which is what filters them out', () => {
    expect(dayIndex(at(2026, 8, 23, 12, 0), weekStart)).toBe(-1); // the Sunday before
    expect(dayIndex(at(2026, 8, 31, 6, 0), weekStart)).toBe(7); // the Monday after
  });
});

describe('formatting', () => {
  it('fmtClock drops :00 and uses 12-hour am/pm', () => {
    expect(fmtClock(at(2026, 8, 24, 0, 0))).toBe('12am');
    expect(fmtClock(at(2026, 8, 24, 6, 0))).toBe('6am');
    expect(fmtClock(at(2026, 8, 24, 12, 0))).toBe('12pm');
    expect(fmtClock(at(2026, 8, 24, 18, 30))).toBe('6:30pm');
    expect(fmtClock(at(2026, 8, 24, 23, 5))).toBe('11:05pm');
  });

  it('fmtMinutes matches fmtClock for the same wall time', () => {
    expect(fmtMinutes(0)).toBe('12am');
    expect(fmtMinutes(6 * 60 + 30)).toBe('6:30am');
    expect(fmtMinutes(12 * 60)).toBe('12pm');
    expect(fmtMinutes(18 * 60 + 30)).toBe('6:30pm');
  });

  it('fmtHourLabel names midnight and noon', () => {
    expect(fmtHourLabel(0)).toBe('12am');
    expect(fmtHourLabel(12)).toBe('noon');
    expect(fmtHourLabel(5)).toBe('5am');
    expect(fmtHourLabel(23)).toBe('11pm');
    expect(fmtHourLabel(24)).toBe('12am'); // the grid's exclusive end hour
  });

  it('fmtWeekRange spans the Monday to the Sunday', () => {
    expect(fmtWeekRange(at(2026, 8, 24))).toBe('24 Aug – 30 Aug');
    expect(fmtWeekRange(at(2026, 8, 31))).toBe('31 Aug – 6 Sep');
    expect(fmtWeekRange(at(2026, 12, 28))).toBe('28 Dec – 3 Jan');
  });
});

describe('minutesOfDay / sameDate', () => {
  it('minutesOfDay is minutes since local midnight', () => {
    expect(minutesOfDay(at(2026, 8, 24, 0, 0))).toBe(0);
    expect(minutesOfDay(at(2026, 8, 24, 18, 30))).toBe(1110);
  });

  it('sameDate compares the calendar day, not the instant', () => {
    expect(sameDate(at(2026, 8, 24, 0, 0), at(2026, 8, 24, 23, 59))).toBe(true);
    expect(sameDate(at(2026, 8, 24, 23, 59), at(2026, 8, 25, 0, 0))).toBe(false);
  });
});

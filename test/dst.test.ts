import { describe, expect, it } from 'vitest';
import { addDays, addWeeks, dayIndex, isoWeekId, startOfISOWeek } from '../src/lib/week';
import { computeStreaks } from '../src/lib/streaks';
import { buildUpcoming } from '../src/lib/upcoming';
import type { CalEvent, SkeletonBlock } from '../src/lib/types';

/**
 * Phase 3 §4, first bullet: the dated deadline.
 *
 * Sydney daylight saving starts **Sun 4 Oct 2026** — 02:00 AEST becomes 03:00
 * AEDT, so that Sunday is 23 hours long. It's the last column of the week
 * starting Mon 28 Sep 2026 (2026-W40). `dayIndex` is the one piece of the week
 * maths that works in milliseconds rather than calendar fields, and it rounds;
 * the skeleton/streak/upcoming maths all build times with setHours() on a date
 * derived from the week start. None of it had ever been exercised across a day
 * that isn't 24 hours long.
 *
 * DST ending (Sun 5 Apr 2026, a 25-hour day) is the mirror case and is covered
 * too — the rounding has to survive an error in both directions.
 *
 * These assertions are only meaningful in a timezone that actually observes
 * daylight saving on those dates, so the run pins TZ (vitest.config.ts) and the
 * first test here fails loudly if that didn't take.
 */

const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min);

const SPRING = at(2026, 10, 4); // 23-hour day (AEST -> AEDT)
const AUTUMN = at(2026, 4, 5); // 25-hour day (AEDT -> AEST)

describe('the test run itself', () => {
  it('is pinned to Australia/Sydney', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Australia/Sydney');
  });

  it('really does see a 23-hour Sunday on 4 Oct 2026 and a 25-hour one on 5 Apr', () => {
    const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;
    expect(hours(SPRING, at(2026, 10, 5))).toBe(23);
    expect(hours(AUTUMN, at(2026, 4, 6))).toBe(25);
    // 02:00–02:59 does not exist on 4 Oct; asking for it lands at 03:00.
    expect(at(2026, 10, 4, 2, 30).getHours()).toBe(3);
  });
});

describe('week identity across the spring-forward week (2026-W40)', () => {
  const weekStart = startOfISOWeek(SPRING);

  it('starts on Mon 28 Sep and is 2026-W40 for all seven days', () => {
    expect(weekStart.getDate()).toBe(28);
    expect(weekStart.getMonth() + 1).toBe(9);
    for (let i = 0; i < 7; i++) {
      expect(isoWeekId(addDays(weekStart, i))).toBe('2026-W40');
    }
  });

  it('every day of the week still lands on its own column', () => {
    // The transition happens *inside* Sunday (02:00), after its midnight, so
    // the seven midnights here are still exactly 24h apart. The rounding earns
    // its keep in the cross-week cases below.
    for (let i = 0; i < 7; i++) {
      expect(dayIndex(addDays(weekStart, i), weekStart)).toBe(i);
    }
    expect(dayIndex(SPRING, weekStart)).toBe(6);
  });

  it('puts an event anywhere on the short Sunday in the Sunday column', () => {
    for (const [h, m] of [
      [0, 30],
      [1, 59],
      [3, 0], // the first minute that exists after the jump
      [12, 0],
      [18, 30],
      [23, 59],
    ]) {
      expect(dayIndex(at(2026, 10, 4, h, m), weekStart)).toBe(6);
    }
  });

  it('keeps the week start stable when navigating away and back', () => {
    const next = addWeeks(weekStart, 1);
    expect(next.getDate()).toBe(5); // Mon 5 Oct
    expect(next.getHours()).toBe(0); // not 23:00 the night before
    expect(addWeeks(next, -1).getTime()).toBe(weekStart.getTime());
  });
});

describe('dayIndex across the boundary — the case the rounding is for', () => {
  it('reads -1 / 7 across the 23-hour day (raw values are 6.958 and -0.958)', () => {
    const w40 = startOfISOWeek(SPRING); // Mon 28 Sep, AEST
    const w41 = startOfISOWeek(at(2026, 10, 5)); // Mon 5 Oct, AEDT
    expect(dayIndex(at(2026, 10, 5, 9, 0), w40)).toBe(7); // next week's Monday
    expect(dayIndex(at(2026, 10, 4, 20, 0), w41)).toBe(-1); // last week's Sunday
    expect(dayIndex(at(2026, 10, 10), w40)).toBe(12); // two weeks of drift, still integral
  });

  it('reads -1 / 7 across the 25-hour day too (raw values are 7.042 and -1.042)', () => {
    const wA = startOfISOWeek(AUTUMN); // Mon 30 Mar, AEDT
    const wB = startOfISOWeek(at(2026, 4, 6)); // Mon 6 Apr, AEST
    expect(dayIndex(at(2026, 4, 6, 9, 0), wA)).toBe(7);
    expect(dayIndex(at(2026, 4, 5, 20, 0), wB)).toBe(-1);
  });
});

describe('skeleton-derived times on the short day', () => {
  // The real skeleton's Sunday entries (Handoff Log "Skeleton"): a grocery run
  // and meal prep, both well clear of the 02:00–03:00 gap.
  const skeleton: SkeletonBlock[] = [
    { name: 'Gym', kind: 'gym', days: [0, 1, 2, 3, 4], startMin: 6 * 60, endMin: 7 * 60 },
    {
      name: 'Grocery Run',
      kind: 'errand',
      days: [6],
      startMin: 14 * 60,
      endMin: 15 * 60,
    },
    { name: 'Meal Prep', kind: 'meal-prep', days: [6], startMin: 15 * 60, endMin: 17 * 60 },
  ];

  it('places a Sunday block at its wall-clock time, not an hour off', () => {
    const weekStart = startOfISOWeek(SPRING);
    const sunday = addDays(weekStart, 6);
    sunday.setHours(14, 0, 0, 0);
    expect(sunday.getDate()).toBe(4);
    expect(sunday.getHours()).toBe(14);
    // ...and it is genuinely on the far side of the transition.
    expect(sunday.getTimezoneOffset()).toBe(-660); // AEDT
    expect(weekStart.getTimezoneOffset()).toBe(-600); // AEST
  });

  it('matches a real Sunday event to its skeleton slot across the transition', () => {
    const weekStart = startOfISOWeek(SPRING);
    const events: CalEvent[] = [
      {
        uid: 'a',
        title: 'Groceries',
        start: at(2026, 10, 4, 14, 0),
        end: at(2026, 10, 4, 15, 0),
        allDay: false,
      },
      {
        uid: 'b',
        title: 'Gym',
        start: at(2026, 9, 28, 6, 0),
        end: at(2026, 9, 28, 7, 0),
        allDay: false,
      },
    ];
    const streaks = computeStreaks(weekStart, events, skeleton);
    // Grocery Run + Meal Prep share a Sunday, so neither is a 2+ slot "streak"
    // on its own; Gym is the one with five slots, and only one is done.
    const gym = streaks.find((s) => s.kind === 'gym');
    expect(gym).toEqual({ kind: 'gym', label: 'Gym', done: 1, target: 5 });
    // The Sunday event was found in the Sunday column, not spilled into Saturday.
    expect(dayIndex(events[0].start, weekStart)).toBe(6);
  });

  it('a Sunday-only kind with two slots still scores across the short day', () => {
    const weekStart = startOfISOWeek(SPRING);
    const twice: SkeletonBlock[] = [
      { name: 'Grocery Run', kind: 'errand', days: [6], startMin: 14 * 60, endMin: 15 * 60 },
      { name: 'Errand', kind: 'errand', days: [3], startMin: 9 * 60, endMin: 10 * 60 },
    ];
    const events: CalEvent[] = [
      {
        uid: 'a',
        title: 'Groceries',
        start: at(2026, 10, 4, 14, 15),
        end: at(2026, 10, 4, 15, 0),
        allDay: false,
      },
    ];
    expect(computeStreaks(weekStart, events, twice)).toEqual([
      { kind: 'errand', label: 'Errand', done: 1, target: 2 },
    ]);
  });

  it('buildUpcoming spans the transition without duplicating or dropping a block', () => {
    // Standing on Saturday evening, looking at Saturday + the short Sunday.
    const now = at(2026, 10, 3, 20, 0);
    const up = buildUpcoming([], skeleton, now, 10);
    const sunday = up.filter((u) => u.when.getDate() === 4);
    expect(sunday.map((u) => u.label)).toEqual(['Grocery Run', 'Meal Prep']);
    expect(sunday[0].when.getHours()).toBe(14);
    expect(sunday[1].when.getHours()).toBe(15);
    // Ordered by instant, and the gap between them really is one hour.
    expect(sunday[1].when.getTime() - sunday[0].when.getTime()).toBe(3_600_000);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_BLOCK,
  busyByDay,
  compareGaps,
  computeGaps,
  fitTasks,
  freeMinutes,
  freeWithin,
  mergeIntervals,
  snapToGap,
} from '../src/lib/gaps';
import { parseSkeletonDoc, parseWindows, stringifySkeleton } from '../src/lib/skeleton';
import { addDays, startOfISOWeek } from '../src/lib/week';
import type {
  AvailabilityWindow,
  CalEvent,
  DurationMap,
  SkeletonBlock,
  VaultTask,
} from '../src/lib/types';

/**
 * Phase 4 §2 — the open-gap engine.
 *
 * `lib/gaps.ts` is pure precisely so it can be tested this hard: no clock, no
 * IO, no IPC. Everything below is arithmetic over a skeleton, a calendar and a
 * time map, including the DST week the rest of this project has been bitten by.
 */

// A plain Monday-start week well clear of any transition.
const WEEK = startOfISOWeek(new Date(2026, 8, 2)); // Wed 2 Sep 2026 -> Mon 31 Aug
const MON = 0;
const TUE = 1;
const WED = 2;
const SAT = 5;
const SUN = 6;

const at = (day: number, h: number, m = 0, weekStart = WEEK) => {
  const d = addDays(weekStart, day);
  d.setHours(h, m, 0, 0);
  return d;
};

const ev = (
  uid: string,
  start: Date,
  end: Date,
  allDay = false,
  title = uid,
): CalEvent => ({ uid, title, start, end, allDay });

const win = (
  name: string,
  days: number[],
  startMin: number,
  endMin: number,
  minBlockMin = 0,
): AvailabilityWindow => ({ name, days, startMin, endMin, minBlockMin });

const task = (text: string, line = 0, done = false, file = 'Weekly/2026-W36.md'): VaultTask => ({
  text,
  done,
  file,
  line,
});

const DURATIONS: DurationMap = {
  defaultMinutes: 60,
  byKind: { content: 90, admin: 30, errand: 45, deep: 120 },
};

const GYM: SkeletonBlock = {
  name: 'Gym',
  kind: 'gym',
  days: [0, 1, 2, 3, 4],
  startMin: 6 * 60,
  endMin: 7 * 60,
};
const STREAM: SkeletonBlock = {
  name: 'Twitch Stream',
  kind: 'stream',
  days: [0, 1, 3, 4],
  startMin: 18 * 60 + 30,
  endMin: 21 * 60 + 30,
};

// ---------------------------------------------------------------------------
// The interval arithmetic underneath
// ---------------------------------------------------------------------------

describe('mergeIntervals', () => {
  it('collapses overlapping and touching intervals', () => {
    expect(
      mergeIntervals([
        { startMin: 600, endMin: 660 },
        { startMin: 630, endMin: 720 },
        { startMin: 720, endMin: 780 },
      ]),
    ).toEqual([{ startMin: 600, endMin: 780 }]);
  });

  it('keeps disjoint ones apart, in order, whatever order they came in', () => {
    expect(
      mergeIntervals([
        { startMin: 900, endMin: 960 },
        { startMin: 600, endMin: 660 },
      ]),
    ).toEqual([
      { startMin: 600, endMin: 660 },
      { startMin: 900, endMin: 960 },
    ]);
  });

  it('swallows an interval fully inside another', () => {
    expect(
      mergeIntervals([
        { startMin: 600, endMin: 900 },
        { startMin: 660, endMin: 700 },
      ]),
    ).toEqual([{ startMin: 600, endMin: 900 }]);
  });

  it('does not mutate its input', () => {
    const input = [{ startMin: 600, endMin: 660 }];
    mergeIntervals(input);
    expect(input).toEqual([{ startMin: 600, endMin: 660 }]);
  });
});

describe('freeWithin', () => {
  const window = { startMin: 540, endMin: 720 }; // 09:00–12:00

  it('returns the whole window when nothing is busy', () => {
    expect(freeWithin(window, [])).toEqual([window]);
  });

  it('cuts a hole in the middle', () => {
    expect(freeWithin(window, [{ startMin: 600, endMin: 630 }])).toEqual([
      { startMin: 540, endMin: 600 },
      { startMin: 630, endMin: 720 },
    ]);
  });

  it('returns nothing when the window is completely covered', () => {
    expect(freeWithin(window, [{ startMin: 0, endMin: 1440 }])).toEqual([]);
  });

  it('ignores busy time entirely outside the window', () => {
    expect(
      freeWithin(window, [
        { startMin: 0, endMin: 400 },
        { startMin: 800, endMin: 900 },
      ]),
    ).toEqual([window]);
  });
});

// ---------------------------------------------------------------------------
// Busy time — the arithmetic that has bitten this project before
// ---------------------------------------------------------------------------

describe('busyByDay', () => {
  it('lays a skeleton block on every day it runs', () => {
    const days = busyByDay(WEEK, [GYM], []);
    for (const d of [0, 1, 2, 3, 4]) {
      expect(days[d]).toEqual([{ startMin: 360, endMin: 420 }]);
    }
    expect(days[SAT]).toEqual([]);
    expect(days[SUN]).toEqual([]);
  });

  it('merges an event that overlaps a skeleton block', () => {
    const days = busyByDay(WEEK, [GYM], [ev('a', at(MON, 6, 30), at(MON, 8, 0))]);
    expect(days[MON]).toEqual([{ startMin: 360, endMin: 480 }]);
  });

  it('merges two events that overlap each other', () => {
    const days = busyByDay(WEEK, [], [
      ev('a', at(TUE, 9, 0), at(TUE, 11, 0)),
      ev('b', at(TUE, 10, 0), at(TUE, 12, 0)),
    ]);
    expect(days[TUE]).toEqual([{ startMin: 540, endMin: 720 }]);
  });

  it('splits an event that runs past midnight across both days', () => {
    const days = busyByDay(WEEK, [], [ev('a', at(MON, 22, 0), at(TUE, 1, 30))]);
    expect(days[MON]).toEqual([{ startMin: 22 * 60, endMin: 1440 }]);
    expect(days[TUE]).toEqual([{ startMin: 0, endMin: 90 }]);
  });

  it('does not leave a zero-length sliver when an event ends exactly at midnight', () => {
    const days = busyByDay(WEEK, [], [ev('a', at(MON, 22, 0), at(TUE, 0, 0))]);
    expect(days[MON]).toEqual([{ startMin: 22 * 60, endMin: 1440 }]);
    expect(days[TUE]).toEqual([]);
  });

  it('fills every day a multi-day timed event covers', () => {
    const days = busyByDay(WEEK, [], [ev('a', at(MON, 20, 0), at(WED, 9, 0))]);
    expect(days[MON]).toEqual([{ startMin: 1200, endMin: 1440 }]);
    expect(days[TUE]).toEqual([{ startMin: 0, endMin: 1440 }]);
    expect(days[WED]).toEqual([{ startMin: 0, endMin: 540 }]);
  });

  it('clips an event that starts before the week or ends after it', () => {
    const days = busyByDay(WEEK, [], [
      ev('before', at(-1, 20, 0), at(MON, 9, 0)),
      ev('after', at(SUN, 22, 0), at(7, 6, 0)),
    ]);
    expect(days[MON]).toEqual([{ startMin: 0, endMin: 540 }]);
    expect(days[SUN]).toEqual([{ startMin: 22 * 60, endMin: 1440 }]);
  });

  it('ignores an event outside the week entirely', () => {
    const days = busyByDay(WEEK, [], [ev('a', at(-3, 9, 0), at(-3, 10, 0))]);
    expect(days.every((d) => d.length === 0)).toBe(true);
  });

  it('takes an event that starts before the 05:00 grid start, which the grid never shows', () => {
    // The grid starts at 05:00, but a 03:00–08:00 event still eats the 07:00
    // window. Clipping busy time to the visible grid would have proposed a slot
    // inside a real event.
    const days = busyByDay(WEEK, [], [ev('a', at(MON, 3, 0), at(MON, 8, 0))]);
    expect(days[MON]).toEqual([{ startMin: 180, endMin: 480 }]);
  });

  it('discards an event whose end is before its start', () => {
    const days = busyByDay(WEEK, [], [ev('a', at(MON, 10, 0), at(MON, 9, 0))]);
    expect(days[MON]).toEqual([]);
  });

  describe('all-day events', () => {
    it('blocks the whole day (the end date is exclusive)', () => {
      const days = busyByDay(WEEK, [], [ev('a', at(TUE, 0, 0), at(WED, 0, 0), true)]);
      expect(days[TUE]).toEqual([{ startMin: 0, endMin: 1440 }]);
      expect(days[WED]).toEqual([]);
    });

    it('blocks every day of a multi-day all-day event', () => {
      const days = busyByDay(WEEK, [], [ev('a', at(MON, 0, 0), at(3, 0, 0), true)]);
      for (const d of [MON, TUE, WED]) {
        expect(days[d]).toEqual([{ startMin: 0, endMin: 1440 }]);
      }
      expect(days[3]).toEqual([]);
    });

    it('survives a same-day end (some feeds write DTEND = DTSTART)', () => {
      const days = busyByDay(WEEK, [], [ev('a', at(TUE, 0, 0), at(TUE, 0, 0), true)]);
      expect(days[TUE]).toEqual([{ startMin: 0, endMin: 1440 }]);
    });

    it('can be told to ignore all-day events instead', () => {
      const days = busyByDay(WEEK, [], [ev('a', at(TUE, 0, 0), at(WED, 0, 0), true)], false);
      expect(days[TUE]).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// computeGaps — the engine proper
// ---------------------------------------------------------------------------

describe('computeGaps', () => {
  const deep = win('deep', [MON, TUE], 7 * 60, 12 * 60);

  it('returns nothing when no windows are configured', () => {
    expect(computeGaps(WEEK, [GYM, STREAM], [], [])).toEqual([]);
  });

  it('offers the whole window when nothing is booked', () => {
    const gaps = computeGaps(WEEK, [], [], [deep]);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatchObject({
      day: MON,
      startMin: 420,
      endMin: 720,
      minutes: 300,
      window: 'deep',
      windowIndex: 0,
    });
  });

  it('never proposes a slot inside a real event', () => {
    const gaps = computeGaps(WEEK, [], [ev('a', at(MON, 9, 0), at(MON, 10, 30))], [deep]);
    const monday = gaps.filter((g) => g.day === MON);
    expect(monday.map((g) => [g.startMin, g.endMin])).toEqual([
      [420, 540],
      [630, 720],
    ]);
  });

  it('never proposes a slot inside a skeleton block', () => {
    // A window deliberately laid over the 06:00 gym.
    const gaps = computeGaps(WEEK, [GYM], [], [win('deep', [MON], 5 * 60, 9 * 60)]);
    expect(gaps.map((g) => [g.startMin, g.endMin])).toEqual([
      [300, 360],
      [420, 540],
    ]);
  });

  it('returns nothing for a fully booked week', () => {
    const wall: CalEvent[] = Array.from({ length: 7 }, (_, d) =>
      ev(`d${d}`, at(d, 0, 0), at(d + 1, 0, 0)),
    );
    expect(computeGaps(WEEK, [GYM, STREAM], wall, [deep, win('admin', [MON], 12 * 60, 18 * 60)])).toEqual([]);
  });

  it('returns nothing when an all-day event owns the day', () => {
    const gaps = computeGaps(WEEK, [], [ev('leave', at(MON, 0, 0), at(TUE, 0, 0), true)], [deep]);
    expect(gaps.map((g) => g.day)).toEqual([TUE]);
  });

  describe('min_block', () => {
    it('suppresses a sliver too small for the window', () => {
      // 07:00–12:00 with a meeting 08:00–11:30 leaves 60m + 30m; a 60-minute
      // min_block keeps only the first.
      const gaps = computeGaps(
        WEEK,
        [],
        [ev('a', at(MON, 8, 0), at(MON, 11, 30))],
        [win('deep', [MON], 7 * 60, 12 * 60, 60)],
      );
      expect(gaps.map((g) => [g.startMin, g.minutes])).toEqual([[420, 60]]);
    });

    it('keeps a gap exactly the size of min_block', () => {
      const gaps = computeGaps(
        WEEK,
        [],
        [ev('a', at(MON, 8, 0), at(MON, 12, 0))],
        [win('deep', [MON], 7 * 60, 12 * 60, 60)],
      );
      expect(gaps.map((g) => g.minutes)).toEqual([60]);
    });

    it('with no min_block still drops a zero-length gap', () => {
      const gaps = computeGaps(
        WEEK,
        [],
        [ev('a', at(MON, 7, 0), at(MON, 12, 0))],
        [win('deep', [MON], 7 * 60, 12 * 60, 0)],
      );
      expect(gaps).toEqual([]);
    });
  });

  describe('the clock, when the caller hands one over', () => {
    it('drops days already gone and trims the one in progress', () => {
      const gaps = computeGaps(WEEK, [], [], [win('deep', [MON, TUE, WED], 7 * 60, 12 * 60)], {
        now: at(TUE, 9, 10),
      });
      expect(gaps.map((g) => [g.day, g.startMin])).toEqual([
        [TUE, 570], // 09:30 — rounded up to the 30-minute lattice
        [WED, 420],
      ]);
    });

    it('offers the whole week when no clock is given', () => {
      const gaps = computeGaps(WEEK, [], [], [win('deep', [MON, TUE], 7 * 60, 12 * 60)]);
      expect(gaps.map((g) => g.day)).toEqual([MON, TUE]);
    });

    it('offers the whole week for a clock that sits before it', () => {
      const gaps = computeGaps(WEEK, [], [], [deep], { now: at(-4, 12, 0) });
      expect(gaps.map((g) => g.day)).toEqual([MON, TUE]);
    });

    it('offers nothing for a week already finished', () => {
      expect(computeGaps(WEEK, [], [], [deep], { now: at(9, 12, 0) })).toEqual([]);
    });

    it('drops today entirely once the window has passed', () => {
      expect(
        computeGaps(WEEK, [], [], [win('deep', [MON], 7 * 60, 12 * 60)], {
          now: at(MON, 14, 0),
        }),
      ).toEqual([]);
    });
  });

  it('ignores a window with no days, no name or an inverted range', () => {
    expect(computeGaps(WEEK, [], [], [win('deep', [], 420, 720)])).toEqual([]);
    expect(computeGaps(WEEK, [], [], [win('deep', [MON], 720, 420)])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The ranking rule
// ---------------------------------------------------------------------------

describe('ranking', () => {
  it('is chronological: earlier day, then earlier in the day', () => {
    const gaps = computeGaps(
      WEEK,
      [],
      [ev('a', at(MON, 9, 0), at(MON, 10, 0))],
      [win('deep', [MON, TUE], 7 * 60, 12 * 60), win('admin', [MON], 13 * 60, 17 * 60)],
    );
    expect(gaps.map((g) => [g.day, g.startMin, g.window])).toEqual([
      [MON, 420, 'deep'],
      [MON, 600, 'deep'],
      [MON, 780, 'admin'],
      [TUE, 420, 'deep'],
    ]);
  });

  it('breaks a same-day, same-start tie on the window order in the yaml', () => {
    // Two windows deliberately laid over the same hour.
    const gaps = computeGaps(WEEK, [], [], [
      win('content', [MON], 9 * 60, 10 * 60),
      win('deep', [MON], 9 * 60, 10 * 60),
    ]);
    expect(gaps.map((g) => g.window)).toEqual(['content', 'deep']);
    // ...and the other declaration order gives the other answer, deterministically.
    const flipped = computeGaps(WEEK, [], [], [
      win('deep', [MON], 9 * 60, 10 * 60),
      win('content', [MON], 9 * 60, 10 * 60),
    ]);
    expect(flipped.map((g) => g.window)).toEqual(['deep', 'content']);
  });

  it('compareGaps totally orders a shuffled list, with no stable-sort dependence', () => {
    const gaps = computeGaps(WEEK, [], [], [
      win('deep', [MON, TUE, WED], 7 * 60, 12 * 60),
      win('admin', [MON, TUE], 13 * 60, 17 * 60),
    ]);
    const shuffled = [...gaps].reverse().sort(compareGaps);
    expect(shuffled).toEqual(gaps);
    // Every adjacent pair is strictly ordered, so no two entries can swap.
    for (let i = 1; i < gaps.length; i++) {
      expect(compareGaps(gaps[i - 1], gaps[i])).toBeLessThan(0);
    }
  });

  it('is a pure function — same inputs, same ranked output, twice', () => {
    const blocks: SkeletonBlock[] = [GYM, STREAM];
    const events = [ev('a', at(MON, 9, 0), at(MON, 10, 0))];
    const windows = [win('deep', [MON, TUE], 7 * 60, 12 * 60)];
    expect(computeGaps(WEEK, blocks, events, windows)).toEqual(
      computeGaps(WEEK, blocks, events, windows),
    );
    // ...and the inputs come back untouched.
    expect(blocks).toEqual([GYM, STREAM]);
    expect(events[0].start).toEqual(at(MON, 9, 0));
  });
});

// ---------------------------------------------------------------------------
// The rail footer's free half
// ---------------------------------------------------------------------------

describe('freeMinutes', () => {
  it('is null, not zero, when no windows are configured', () => {
    expect(freeMinutes([], [])).toBeNull();
  });

  it('is zero for a configured but fully booked week', () => {
    const windows = [win('deep', [MON], 7 * 60, 12 * 60)];
    const gaps = computeGaps(WEEK, [], [ev('a', at(MON, 0, 0), at(TUE, 0, 0))], windows);
    expect(freeMinutes(windows, gaps)).toBe(0);
  });

  it('adds the week up', () => {
    const windows = [win('deep', [MON, TUE], 7 * 60, 12 * 60)];
    expect(freeMinutes(windows, computeGaps(WEEK, [], [], windows))).toBe(600);
  });

  it('subtracts the skeleton — this is *skeleton-free* time', () => {
    const windows = [win('deep', [MON], 6 * 60, 12 * 60)];
    // 6h of window minus the 1h gym.
    expect(freeMinutes(windows, computeGaps(WEEK, [GYM], [], windows))).toBe(300);
  });

  it('does not double-count two windows over the same hours', () => {
    const windows = [
      win('deep', [SAT], 9 * 60, 12 * 60),
      win('content', [SAT], 10 * 60, 13 * 60),
    ];
    const gaps = computeGaps(WEEK, [], [], windows);
    expect(gaps).toHaveLength(2);
    // 09:00–13:00 is four hours, not the six the two windows sum to.
    expect(freeMinutes(windows, gaps)).toBe(240);
  });

  it('excludes slivers suppressed by min_block, so the number can be trusted', () => {
    const windows = [win('deep', [MON], 7 * 60, 12 * 60, 60)];
    const gaps = computeGaps(WEEK, [], [ev('a', at(MON, 8, 0), at(MON, 11, 30))], windows);
    expect(freeMinutes(windows, gaps)).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// "Fit this week"
// ---------------------------------------------------------------------------

describe('fitTasks', () => {
  const windows = [
    win('deep', [MON, TUE], 7 * 60, 12 * 60, 30),
    win('admin', [MON, TUE], 13 * 60, 17 * 60, 30),
  ];
  const gaps = computeGaps(WEEK, [], [], windows);

  it('places every task and proposes nothing else', () => {
    const { proposals, unplaced } = fitTasks(
      [task('Book dentist', 0), task('Email the accountant #admin', 1)],
      gaps,
      DURATIONS,
    );
    expect(unplaced).toEqual([]);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({
      title: 'Book dentist',
      minutes: 60,
      day: MON,
      startMin: 420,
      endMin: 480,
      window: 'deep',
      key: 'Weekly/2026-W36.md:0',
    });
  });

  it('prefers the window whose name matches the task tag, over an earlier slot', () => {
    const { proposals } = fitTasks([task('Email the accountant #admin', 0)], gaps, DURATIONS);
    // Monday 07:00 is earlier, but `#admin` wants the admin window.
    expect(proposals[0]).toMatchObject({ day: MON, startMin: 780, window: 'admin' });
  });

  it('front-loads the week when no window matches', () => {
    const { proposals } = fitTasks([task('Book dentist')], gaps, DURATIONS);
    expect(proposals[0]).toMatchObject({ day: MON, startMin: 420 });
  });

  it('packs several tasks nose to tail down one gap, in rail order', () => {
    const { proposals } = fitTasks(
      [task('One', 0), task('Two', 1), task('Three', 2)],
      gaps,
      DURATIONS,
    );
    expect(proposals.map((p) => [p.title, p.day, p.startMin])).toEqual([
      ['One', MON, 420],
      ['Two', MON, 480],
      ['Three', MON, 540],
    ]);
  });

  it('keeps the list in the order it was given — the note is the priority order', () => {
    const { proposals } = fitTasks(
      [task('Big one ~4h', 0), task('Small one ~30m', 1)],
      gaps,
      DURATIONS,
    );
    // A largest-first packer would put the small one first; this one doesn't.
    expect(proposals.map((p) => p.title)).toEqual(['Big one', 'Small one']);
    expect(proposals[0].minutes).toBe(240);
  });

  it('skips a done task', () => {
    const { proposals } = fitTasks([task('Already done', 0, true)], gaps, DURATIONS);
    expect(proposals).toEqual([]);
  });

  it('reports a task too big for every gap rather than dropping it', () => {
    const tight = computeGaps(WEEK, [], [], [win('deep', [MON], 9 * 60, 10 * 60, 30)]);
    const { proposals, unplaced } = fitTasks([task('Edit video A ~4h')], tight, DURATIONS);
    expect(proposals).toEqual([]);
    expect(unplaced).toEqual([
      {
        key: 'Weekly/2026-W36.md:0',
        title: 'Edit video A',
        minutes: 240,
        // One 1h gap on Monday: session one fits, and then there is nowhere
        // left for the other three hours (Phase 4 §3, rule 8 — all or nothing).
        reason: 'no-gap',
      },
    ]);
  });

  it('reports everything as unplaced when there are no gaps at all', () => {
    const { proposals, unplaced } = fitTasks([task('Anything')], [], DURATIONS);
    expect(proposals).toEqual([]);
    expect(unplaced).toHaveLength(1);
  });

  it('drops a leftover smaller than the window min_block instead of proposing into it', () => {
    // A 90-minute window with a 60-minute min_block: one 60m task fits and the
    // 30m remainder is not offered to the next.
    const small = computeGaps(WEEK, [], [], [win('deep', [MON], 9 * 60, 10 * 60 + 30, 60)]);
    const { proposals, unplaced } = fitTasks(
      [task('First', 0), task('Second #admin', 1)],
      small,
      DURATIONS,
    );
    expect(proposals).toHaveLength(1);
    // The title keeps its tag — only the estimate syntax is stripped.
    expect(unplaced.map((u) => u.title)).toEqual(['Second #admin']);
  });

  it('never overlaps two proposals', () => {
    const { proposals } = fitTasks(
      [task('a ~90m', 0), task('b ~90m', 1), task('c ~90m', 2), task('d ~90m', 3)],
      gaps,
      DURATIONS,
    );
    const byDay = new Map<number, { startMin: number; endMin: number }[]>();
    for (const p of proposals) {
      const list = byDay.get(p.day) ?? [];
      list.push(p);
      byDay.set(p.day, list);
    }
    for (const list of byDay.values()) {
      list.sort((x, y) => x.startMin - y.startMin);
      for (let i = 1; i < list.length; i++) {
        expect(list[i].startMin).toBeGreaterThanOrEqual(list[i - 1].endMin);
      }
    }
  });

  it('proposes only inside gaps — never over a block or an event', () => {
    const ws = [win('deep', [MON], 5 * 60, 12 * 60, 30)];
    const events = [ev('standup', at(MON, 9, 0), at(MON, 9, 30))];
    const g = computeGaps(WEEK, [GYM], events, ws);
    const { proposals } = fitTasks(
      [task('a', 0), task('b', 1), task('c', 2), task('d', 3)],
      g,
      DURATIONS,
    );
    for (const p of proposals) {
      const home = g.find(
        (x) => x.day === p.day && x.startMin <= p.startMin && x.endMin >= p.endMin,
      );
      expect(home, `${p.title} at ${p.startMin} sits outside every gap`).toBeTruthy();
    }
  });

  it('sizes from the duration ladder — override beats tag beats fallback', () => {
    const { proposals } = fitTasks(
      [task('Cut the VOD #content', 0), task('Cut the VOD #content ~30m', 1), task('Plain', 2)],
      gaps,
      DURATIONS,
    );
    expect(proposals.map((p) => p.minutes)).toEqual([90, 30, 60]);
  });

  it('does not mutate the gaps it was handed', () => {
    const before = JSON.parse(JSON.stringify(gaps));
    fitTasks([task('a', 0), task('b', 1)], gaps, DURATIONS);
    expect(gaps).toEqual(before);
  });

  it('is deterministic — the same tasks and gaps twice give the same plan', () => {
    const tasks = [task('a #admin', 0), task('b', 1), task('c ~90m', 2)];
    expect(fitTasks(tasks, gaps, DURATIONS)).toEqual(fitTasks(tasks, gaps, DURATIONS));
  });

  it('gives distinct keys to two tasks on the same line of different files', () => {
    const { proposals } = fitTasks(
      [task('a', 3, false, 'Weekly/2026-W36.md'), task('b', 3, false, 'Backlog.md')],
      gaps,
      DURATIONS,
    );
    expect(proposals.map((p) => p.key)).toEqual(['Weekly/2026-W36.md:3', 'Backlog.md:3']);
  });
});

// ---------------------------------------------------------------------------
// Drag snapping
// ---------------------------------------------------------------------------

describe('snapToGap', () => {
  const gaps = computeGaps(WEEK, [], [], [
    win('deep', [MON], 7 * 60, 9 * 60, 30),
    win('admin', [MON], 13 * 60, 14 * 60, 30),
  ]);

  it('keeps the drop where it landed when it is already inside a gap', () => {
    expect(snapToGap(gaps, MON, 8 * 60, 60)?.startMin).toBe(8 * 60);
  });

  it('pulls a near miss onto the edge of the gap', () => {
    expect(snapToGap(gaps, MON, 6 * 60 + 30, 60)?.startMin).toBe(7 * 60);
  });

  it('pulls back so the whole block still fits inside the gap', () => {
    // Dropped at 08:30 in a gap ending at 09:00 — a 60m block starts at 08:00.
    expect(snapToGap(gaps, MON, 8 * 60 + 30, 60)?.startMin).toBe(8 * 60);
  });

  it('ignores a gap too small to hold the task', () => {
    // The admin gap is only an hour; a 90-minute task can't use it, and the
    // deep gap is far out of reach.
    expect(snapToGap(gaps, MON, 13 * 60, 90)).toBeNull();
  });

  it('does not reach across half a day', () => {
    expect(snapToGap(gaps, MON, 17 * 60, 60)).toBeNull();
  });

  it('never jumps to another day', () => {
    expect(snapToGap(gaps, TUE, 8 * 60, 60)).toBeNull();
  });

  it('returns nothing when there are no gaps at all', () => {
    expect(snapToGap([], MON, 8 * 60, 60)).toBeNull();
  });

  it('breaks a tie on the earlier gap, then the window order', () => {
    const twin = computeGaps(WEEK, [], [], [
      win('content', [MON], 9 * 60, 11 * 60, 30),
      win('deep', [MON], 9 * 60, 11 * 60, 30),
    ]);
    expect(snapToGap(twin, MON, 9 * 60 + 30, 60)?.gap.window).toBe('content');
  });
});

// ---------------------------------------------------------------------------
// The DST week — Sydney springs forward Sun 4 Oct 2026 (2026-W40)
// ---------------------------------------------------------------------------

describe('the spring-forward week (2026-W40)', () => {
  const W40 = startOfISOWeek(new Date(2026, 9, 4)); // Mon 28 Sep 2026
  const on = (day: number, h: number, m = 0) => at(day, h, m, W40);

  it('is genuinely the week with the 23-hour Sunday', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Australia/Sydney');
    expect(W40.getDate()).toBe(28);
    const sunday = addDays(W40, 6);
    expect(sunday.getDate()).toBe(4);
    expect((addDays(W40, 7).getTime() - sunday.getTime()) / 3_600_000).toBe(23);
  });

  it('offers the Sunday window at its wall-clock time, not an hour off', () => {
    const gaps = computeGaps(W40, [], [], [win('errands', [SUN], 9 * 60, 14 * 60, 30)]);
    expect(gaps).toEqual([
      {
        day: SUN,
        startMin: 540,
        endMin: 840,
        minutes: 300,
        window: 'errands',
        windowIndex: 0,
        minBlockMin: 30,
      },
    ]);
  });

  it('subtracts a Sunday event on the far side of the transition', () => {
    const gaps = computeGaps(
      W40,
      [],
      [ev('groceries', on(SUN, 11, 0), on(SUN, 12, 0))],
      [win('errands', [SUN], 9 * 60, 14 * 60, 30)],
    );
    expect(gaps.map((g) => [g.startMin, g.endMin])).toEqual([
      [540, 660],
      [720, 840],
    ]);
  });

  it('puts a Sunday event in the Sunday column, not spilled into Saturday', () => {
    const days = busyByDay(W40, [], [ev('a', on(SUN, 14, 0), on(SUN, 15, 0))]);
    expect(days[SAT]).toEqual([]);
    expect(days[SUN]).toEqual([{ startMin: 840, endMin: 900 }]);
  });

  it('keeps the free-hours total honest across the short day', () => {
    // Sat 09:00–18:00 (9h) + Sun 09:00–14:00 (5h) = 14h, on a 167-hour week.
    const windows = [
      win('content', [SAT], 9 * 60, 18 * 60, 45),
      win('errands', [SUN], 9 * 60, 14 * 60, 30),
    ];
    expect(freeMinutes(windows, computeGaps(W40, [], [], windows))).toBe(14 * 60);
  });

  it('fits a task onto the short Sunday without drifting an hour', () => {
    const windows = [win('errands', [SUN], 9 * 60, 14 * 60, 30)];
    const { proposals } = fitTasks(
      [task('Pick up the parcel #errand')],
      computeGaps(W40, [], [], windows),
      DURATIONS,
    );
    // `#errand` is 45m in the map, snapped up to the grid's 30-minute lattice.
    expect(proposals[0]).toMatchObject({ day: SUN, startMin: 540, endMin: 600 });
  });

  it('trims to a clock that sits on the short Sunday', () => {
    const gaps = computeGaps(W40, [], [], [win('errands', [SUN], 9 * 60, 14 * 60, 30)], {
      now: on(SUN, 11, 10),
    });
    expect(gaps.map((g) => g.startMin)).toEqual([690]); // 11:30
  });
});

describe('the autumn week (Sun 5 Apr 2026 — the 25-hour day)', () => {
  const WA = startOfISOWeek(new Date(2026, 3, 5)); // Mon 30 Mar 2026

  it('offers the Sunday window unchanged on the long day too', () => {
    const gaps = computeGaps(WA, [], [], [win('errands', [SUN], 9 * 60, 14 * 60, 30)]);
    expect(gaps.map((g) => [g.day, g.startMin, g.minutes])).toEqual([[SUN, 540, 300]]);
  });

  it('still splits a past-midnight event into the right two days', () => {
    const start = addDays(WA, SAT);
    start.setHours(23, 0, 0, 0);
    const end = addDays(WA, SUN);
    end.setHours(1, 0, 0, 0);
    const days = busyByDay(WA, [], [ev('a', start, end)]);
    expect(days[SAT]).toEqual([{ startMin: 1380, endMin: 1440 }]);
    expect(days[SUN]).toEqual([{ startMin: 0, endMin: 60 }]);
  });
});

// ---------------------------------------------------------------------------
// The yaml side
// ---------------------------------------------------------------------------

describe('parseWindows', () => {
  it('reads a window, days and all', () => {
    expect(
      parseWindows([
        { name: 'Deep', days: ['mon', 'wed'], start: '07:00', end: '12:00', min_block: '60m' },
      ]),
    ).toEqual([
      { name: 'deep', days: [0, 2], startMin: 420, endMin: 720, minBlockMin: 60 },
    ]);
  });

  it('defaults min_block when it is missing or a typo', () => {
    const [a] = parseWindows([{ name: 'deep', days: ['mon'], start: '07:00', end: '12:00' }]);
    const [b] = parseWindows([
      { name: 'deep', days: ['mon'], start: '07:00', end: '12:00', min_block: 'banana' },
    ]);
    expect(a.minBlockMin).toBe(DEFAULT_MIN_BLOCK);
    expect(b.minBlockMin).toBe(DEFAULT_MIN_BLOCK);
  });

  it('takes an explicit `min_block: 0` as "no minimum"', () => {
    const [w] = parseWindows([
      { name: 'deep', days: ['mon'], start: '07:00', end: '12:00', min_block: 0 },
    ]);
    expect(w.minBlockMin).toBe(0);
  });

  it('drops a window that spans nothing, has no name, or names no day', () => {
    expect(
      parseWindows([
        { name: '', days: ['mon'], start: '07:00', end: '12:00' },
        { name: 'deep', days: [], start: '07:00', end: '12:00' },
        { name: 'deep', days: ['mon'], start: '12:00', end: '07:00' },
        { name: 'deep', days: ['mon'] },
        null,
      ]),
    ).toEqual([]);
  });

  it('is empty for a file with no windows: at all', () => {
    expect(parseWindows(undefined)).toEqual([]);
    expect(parseWindows('nope')).toEqual([]);
  });
});

describe('parseSkeletonDoc / stringifySkeleton with windows', () => {
  it('round-trips windows, so a save from the editor cannot drop them', () => {
    const doc = {
      blocks: [],
      durations: { defaultMinutes: 60, byKind: { content: 90 } },
      windows: [
        { name: 'deep', days: [0, 1], startMin: 420, endMin: 720, minBlockMin: 60 },
        { name: 'content', days: [5], startMin: 540, endMin: 1080, minBlockMin: 0 },
      ],
      timezone: 'Australia/Sydney',
    };
    const out = parseSkeletonDoc(stringifySkeleton(doc));
    expect(out.windows).toEqual(doc.windows);
    expect(out.durations).toEqual(doc.durations);
    expect(out.timezone).toBe('Australia/Sydney');
  });

  it('still reads a file written before windows existed', () => {
    const doc = parseSkeletonDoc('blocks:\n  - name: Gym\n    days: [mon]\n    start: "06:00"\n    end: "07:00"\n');
    expect(doc.windows).toEqual([]);
  });

  it('reads the shipped seed file, so the time map Tyler gets is the tested one', async () => {
    const { readFile } = await import('node:fs/promises');
    const doc = parseSkeletonDoc(
      await readFile('public/config/week-skeleton.yaml', 'utf8'),
    );
    // Seeded from Backlog.md's prose: weekday mornings after 07:00, weekday
    // afternoons before 18:30, Wednesday evenings, most of Saturday and Sunday
    // morning.
    expect(doc.windows.map((w) => [w.name, w.days, w.startMin, w.endMin])).toEqual([
      ['deep', [0, 1, 2, 3, 4], 420, 720],
      ['admin', [0, 1, 2, 3, 4], 720, 1110],
      ['content', [2], 1110, 1290],
      ['content', [5], 540, 1080],
      ['errands', [6], 540, 840],
    ]);
    expect(doc.windows.every((w) => w.minBlockMin >= 30)).toBe(true);
  });

  it('the shipped skeleton and time map produce the week the Backlog describes', async () => {
    // The end-to-end number behind the rail footer, with the real seed.
    const { readFile } = await import('node:fs/promises');
    const doc = parseSkeletonDoc(
      await readFile('public/config/week-skeleton.yaml', 'utf8'),
    );
    const gaps = computeGaps(WEEK, doc.blocks, [], doc.windows);

    // 74.5h: deep 5×5h + admin 5×6.5h + Wed content 3h + Sat 9h + Sun 5h. That
    // is the Backlog's prose read literally, not a claim about how much of it
    // Tyler wants to fill — the windows are his to narrow in the editor, and
    // narrowing them is exactly what makes the footer's "/ Nh free" bite.
    expect(freeMinutes(doc.windows, gaps)).toBe(74.5 * 60);

    // The skeleton sits outside every window by construction, which is the
    // point: the windows were drawn around it. Nothing lands on the 06:00 gym,
    // the 18:30 stream, or the Sunday grocery run / meal prep.
    expect(gaps.some((g) => g.startMin < 7 * 60)).toBe(false);
    expect(gaps.some((g) => g.day !== 2 && g.endMin > 18 * 60 + 30)).toBe(false);
    expect(gaps.some((g) => g.day === SUN && g.endMin > 14 * 60)).toBe(false);

    // ...and it stays true with the real skeleton subtracted, whatever changes
    // above: no gap may intersect a block.
    for (const g of gaps) {
      for (const b of doc.blocks) {
        if (!b.days.includes(g.day)) continue;
        expect(
          g.startMin >= b.endMin || g.endMin <= b.startMin,
          `${g.window} ${g.startMin}-${g.endMin} overlaps ${b.name}`,
        ).toBe(true);
      }
    }
  });
});


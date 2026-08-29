import { describe, expect, it } from 'vitest';
import {
  AUDIT_ROWS,
  OTHER_WINDOW,
  auditNoteLine,
  auditNoteLines,
  auditStreaks,
  auditWeek,
  findPrevRow,
  fmtAuditDelta,
  fmtAuditRow,
  shortWeekId,
  topAuditRows,
  windowFor,
} from '../src/lib/audit';
import { matchSlot } from '../src/lib/streaks';
import { addDays, startOfISOWeek } from '../src/lib/week';
import type {
  AvailabilityWindow,
  CalEvent,
  SkeletonBlock,
  VaultTask,
} from '../src/lib/types';

/**
 * Phase 4 §5 — planned vs actual.
 *
 * `lib/audit.ts` is pure and takes its clock as an argument, so the whole
 * retrospective is arithmetic over a skeleton, a calendar and a time map — the
 * half-finished week and Sydney's 23-hour Sunday included.
 */

// A plain Monday-start week well clear of any DST transition.
const WEEK = startOfISOWeek(new Date(2026, 8, 2)); // Wed 2 Sep 2026 -> Mon 31 Aug
const MON = 0;
const TUE = 1;
const WED = 2;
const THU = 3;
const FRI = 4;

const at = (day: number, h: number, m = 0, weekStart = WEEK) => {
  const d = addDays(weekStart, day);
  d.setHours(h, m, 0, 0);
  return d;
};

const ev = (
  uid: string,
  day: number,
  fromH: number,
  toH: number,
  extra: Partial<CalEvent> = {},
): CalEvent => ({
  uid,
  title: uid,
  start: at(day, fromH),
  end: at(day, toH),
  allDay: false,
  ...extra,
});

const GYM: SkeletonBlock = {
  name: 'Gym',
  kind: 'gym',
  days: [MON, TUE, WED, THU, FRI],
  startMin: 6 * 60,
  endMin: 7 * 60,
};
const STREAM: SkeletonBlock = {
  name: 'Twitch Stream',
  kind: 'stream',
  days: [MON, TUE, THU, FRI],
  startMin: 18 * 60 + 30,
  endMin: 21 * 60 + 30,
};

const DEEP: AvailabilityWindow = {
  name: 'deep',
  days: [MON, TUE, WED, THU, FRI],
  startMin: 9 * 60,
  endMin: 12 * 60,
  minBlockMin: 60,
};
const ADMIN: AvailabilityWindow = {
  name: 'admin',
  days: [MON, TUE, WED, THU, FRI],
  startMin: 13 * 60,
  endMin: 15 * 60,
  minBlockMin: 30,
};

const task = (text: string, line = 0, done = false): VaultTask => ({
  text,
  done,
  file: 'Weekly/2026-W36.md',
  line,
});

const row = (audit: ReturnType<typeof auditWeek>, key: string) =>
  audit.rows.find((r) => r.key === key);

// ---------------------------------------------------------------------------
// The skeleton half — hours by block kind
// ---------------------------------------------------------------------------

describe('auditWeek — the skeleton half', () => {
  it('counts every slot as planned, and a matched event as kept', () => {
    // 5 gym slots × 1h; three of them actually happened.
    const events = [ev('a', MON, 6, 7), ev('b', WED, 6, 7), ev('c', FRI, 6, 7)];
    const a = auditWeek(WEEK, { skeleton: [GYM], windows: [], events });
    expect(row(a, 'kind:gym')).toMatchObject({
      label: 'Gym',
      plannedMin: 300,
      keptMin: 180,
      slots: 5,
      kept: 3,
    });
    expect(a.plannedMin).toBe(300);
    expect(a.keptMin).toBe(180);
  });

  it('is the same ±90 minute match the streak rail uses', () => {
    // One matcher, one answer — a slipped 07:30 gym is kept for both.
    const events = [ev('a', MON, 7, 8)];
    expect(matchSlot(WEEK, { day: MON, startMin: 6 * 60 }, events)?.uid).toBe('a');
    expect(row(auditWeek(WEEK, { skeleton: [GYM], windows: [], events }), 'kind:gym')!.kept)
      .toBe(1);
    // …and a 09:00 one is kept for neither.
    const late = [ev('a', MON, 9, 10)];
    expect(matchSlot(WEEK, { day: MON, startMin: 6 * 60 }, late)).toBeNull();
    expect(row(auditWeek(WEEK, { skeleton: [GYM], windows: [], events: late }), 'kind:gym')!.kept)
      .toBe(0);
  });

  it('credits the real event’s own hours, so a stream that ran long says so', () => {
    // 4 slots × 3h planned; Monday's stream ran 18:30 → 23:00 (matched at 18:00).
    const long = ev('a', MON, 18, 23);
    const a = auditWeek(WEEK, { skeleton: [STREAM], windows: [], events: [long] });
    expect(row(a, 'kind:stream')).toMatchObject({ plannedMin: 720, keptMin: 300, kept: 1 });
  });

  it('never lets one of this app’s own blocks stand in as evidence', () => {
    // An accepted deep-work session at 06:15 is planned time of its own; it is
    // not proof the gym happened, and counting it would inflate both halves.
    const mine = ev('s1', MON, 6, 7, { taskId: 'wd-1' });
    const a = auditWeek(WEEK, { skeleton: [GYM], windows: [DEEP], events: [mine] });
    expect(row(a, 'kind:gym')!.kept).toBe(0);
    expect(row(a, `window:${OTHER_WINDOW}`)!.plannedMin).toBe(60);
  });

  it('ignores all-day events and events from another week', () => {
    const holiday = ev('h', MON, 0, 24, { allDay: true });
    const nextWeek: CalEvent = {
      uid: 'n',
      title: 'Gym',
      start: at(MON, 6, 0, addDays(WEEK, 7)),
      end: at(MON, 7, 0, addDays(WEEK, 7)),
      allDay: false,
    };
    const a = auditWeek(WEEK, { skeleton: [GYM], windows: [], events: [holiday, nextWeek] });
    expect(row(a, 'kind:gym')!.kept).toBe(0);
  });

  it('merges two blocks that share a kind into one row', () => {
    const second: SkeletonBlock = { ...GYM, name: 'Evening Gym', days: [MON], startMin: 17 * 60, endMin: 18 * 60 };
    const a = auditWeek(WEEK, { skeleton: [GYM, second], windows: [], events: [] });
    expect(row(a, 'kind:gym')).toMatchObject({ slots: 6, plannedMin: 360 });
  });
});

// ---------------------------------------------------------------------------
// The accepted-proposal half — hours by window name
// ---------------------------------------------------------------------------

describe('auditWeek — the accepted-proposal half', () => {
  const session = (uid: string, day: number, fromH: number, toH: number, title: string) =>
    ev(uid, day, fromH, toH, { taskId: `id-${uid}`, title });

  it('groups accepted blocks by the window they landed in', () => {
    const events = [
      session('a', MON, 9, 11, 'Edit video A'),
      session('b', TUE, 13, 14, 'Inbox zero'),
    ];
    const a = auditWeek(WEEK, { skeleton: [], windows: [DEEP, ADMIN], events });
    expect(row(a, 'window:deep')).toMatchObject({ label: 'Deep', plannedMin: 120, slots: 1 });
    expect(row(a, 'window:admin')).toMatchObject({ label: 'Admin', plannedMin: 60, slots: 1 });
  });

  it('groups a block outside every window under “other”', () => {
    const events = [session('a', MON, 20, 21, 'Late one')];
    const a = auditWeek(WEEK, { skeleton: [], windows: [DEEP, ADMIN], events });
    expect(row(a, `window:${OTHER_WINDOW}`)).toMatchObject({ label: 'Other', plannedMin: 60 });
  });

  it('does not count a block whose task is still unchecked as kept', () => {
    // Exactly §4's signal: the time went by, the task didn't get ticked.
    const events = [
      session('a', MON, 9, 11, 'Edit video A'),
      session('b', TUE, 9, 10, 'Edit video B'),
    ];
    const tasks = [task('Edit video A 🆔 id-a', 1), task('Edit video B 🆔 id-b', 2, true)];
    const a = auditWeek(WEEK, { skeleton: [], windows: [DEEP], events, tasks });
    expect(row(a, 'window:deep')).toMatchObject({
      plannedMin: 180,
      keptMin: 60,
      slots: 2,
      kept: 1,
    });
  });

  it('takes an accepted block at face value when there are no tasks to check it against', () => {
    const events = [session('a', MON, 9, 11, 'Edit video A')];
    const a = auditWeek(WEEK, { skeleton: [], windows: [DEEP], events });
    expect(row(a, 'window:deep')).toMatchObject({ plannedMin: 120, keptMin: 120 });
  });

  it('leaves ordinary calendar events out of the planned column entirely', () => {
    // A dentist appointment isn't a plan this board made; it is neither
    // planned hours nor kept hours, only busy time (which lib/gaps.ts owns).
    const a = auditWeek(WEEK, { skeleton: [], windows: [DEEP], events: [ev('d', MON, 9, 10)] });
    expect(a.rows).toEqual([]);
    expect(a.plannedMin).toBe(0);
  });
});

describe('windowFor', () => {
  it('takes the first window that contains the start — the windows: order', () => {
    const wide: AvailabilityWindow = { ...ADMIN, name: 'wide', startMin: 0, endMin: 24 * 60 };
    expect(windowFor([DEEP, wide], MON, 10 * 60)?.name).toBe('deep');
    expect(windowFor([wide, DEEP], MON, 10 * 60)?.name).toBe('wide');
  });

  it('is half-open at the end, and day-aware', () => {
    expect(windowFor([DEEP], MON, 12 * 60)).toBeNull();
    expect(windowFor([DEEP], MON, 12 * 60 - 1)?.name).toBe('deep');
    expect(windowFor([DEEP], 5 /* Sat */, 10 * 60)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

describe('auditWeek — only elapsed time is audited', () => {
  it('leaves slots that have not happened yet out of both columns', () => {
    // Wednesday lunchtime: Mon/Tue/Wed gym have been and gone, Thu/Fri haven't.
    const a = auditWeek(
      WEEK,
      { skeleton: [GYM], windows: [], events: [ev('a', MON, 6, 7)] },
      { now: at(WED, 12) },
    );
    expect(row(a, 'kind:gym')).toMatchObject({ slots: 3, plannedMin: 180, kept: 1 });
  });

  it('counts a slot only once its end has passed, not its start', () => {
    const mid = auditWeek(WEEK, { skeleton: [GYM], windows: [], events: [] }, { now: at(MON, 6, 30) });
    expect(mid.rows).toEqual([]); // the 06:00–07:00 slot is still running
    const after = auditWeek(WEEK, { skeleton: [GYM], windows: [], events: [] }, { now: at(MON, 7) });
    expect(row(after, 'kind:gym')!.slots).toBe(1);
  });

  it('audits the whole week when no clock is handed over', () => {
    const a = auditWeek(WEEK, { skeleton: [GYM], windows: [], events: [] });
    expect(row(a, 'kind:gym')!.slots).toBe(5);
    // …and a clock at the very end of the week says the same thing.
    const end = auditWeek(WEEK, { skeleton: [GYM], windows: [], events: [] }, { now: addDays(WEEK, 7) });
    expect(end).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// DST — the hours have to survive a 23-hour day
// ---------------------------------------------------------------------------

describe('auditWeek across Sydney’s DST weekend', () => {
  // Sun 4 Oct 2026, 02:00 -> 03:00. The week starting Mon 28 Sep is 167 hours.
  const DST_WEEK = startOfISOWeek(new Date(2026, 9, 1));
  const SUN = 6;

  it('pins the transition, so this file is actually testing it', () => {
    const sun = addDays(DST_WEEK, SUN);
    expect(sun.getDate()).toBe(4);
    expect(sun.getMonth()).toBe(9);
    const midnight = new Date(sun);
    const nextMidnight = addDays(sun, 1);
    expect((nextMidnight.getTime() - midnight.getTime()) / 3_600_000).toBe(23);
  });

  it('reports the hours that were actually lived, not the ones on the clock face', () => {
    // A block written 01:00–04:00 on the short Sunday is three hours of wall
    // clock and two hours of life. The audit reports two.
    const overnight: SkeletonBlock = {
      name: 'Night shift',
      kind: 'night',
      days: [SUN],
      startMin: 60,
      endMin: 4 * 60,
    };
    const a = auditWeek(DST_WEEK, { skeleton: [overnight], windows: [], events: [] });
    expect(a.rows[0]).toMatchObject({ label: 'Night', plannedMin: 120, slots: 1 });
  });

  it('leaves an ordinary morning block on that day at its ordinary length', () => {
    const a = auditWeek(DST_WEEK, {
      skeleton: [{ ...GYM, days: [SUN] }],
      windows: [],
      events: [
        {
          uid: 'g',
          title: 'Gym',
          start: at(SUN, 6, 0, DST_WEEK),
          end: at(SUN, 7, 0, DST_WEEK),
          allDay: false,
        },
      ],
    });
    expect(a.rows[0]).toMatchObject({ plannedMin: 60, keptMin: 60, kept: 1 });
  });

  it('does not slide a Sunday event into Saturday’s column', () => {
    const sat = auditWeek(DST_WEEK, {
      skeleton: [{ ...GYM, kind: 'gym', days: [5] }],
      windows: [],
      events: [
        {
          uid: 'g',
          title: 'Gym',
          start: at(SUN, 6, 0, DST_WEEK),
          end: at(SUN, 7, 0, DST_WEEK),
          allDay: false,
        },
      ],
    });
    expect(sat.rows[0].kept).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ordering and the note lines
// ---------------------------------------------------------------------------

describe('the rows the Review flow shows', () => {
  const a = () =>
    auditWeek(WEEK, {
      skeleton: [GYM, STREAM],
      windows: [DEEP, ADMIN],
      events: [
        ev('s1', MON, 9, 11, { taskId: 'x1' }),
        ev('s2', TUE, 13, 14, { taskId: 'x2' }),
      ],
    });

  it('leads with the biggest commitment', () => {
    expect(a().rows.map((r) => r.key)).toEqual([
      'kind:stream', // 12h
      'kind:gym', // 5h
      'window:deep', // 2h
      'window:admin', // 1h
    ]);
  });

  it('is three or four rows, not a chart', () => {
    expect(AUDIT_ROWS).toBe(4);
    expect(topAuditRows(a())).toHaveLength(4);
    expect(topAuditRows(a(), 3)).toHaveLength(3);
    expect(topAuditRows(null)).toEqual([]);
  });

  it('drops a row with no planned hours rather than printing a zero', () => {
    const empty = auditWeek(WEEK, { skeleton: [], windows: [DEEP], events: [] });
    expect(empty.rows).toEqual([]);
  });
});

describe('the note lines', () => {
  const stream = { label: 'Stream', plannedMin: 720, keptMin: 540 };

  it('reads the way the plan wrote it', () => {
    expect(fmtAuditRow(stream)).toBe('Stream — 12h planned / 9h kept');
    expect(
      auditNoteLine(stream, { label: 'Stream', plannedMin: 720, keptMin: 720 }, '2026-W35'),
    ).toBe('- Audit: Stream — 12h planned / 9h kept — down 3h on W35');
  });

  it('compares kept against kept — behaviour, not intention', () => {
    // Planned halved, kept unchanged: nothing about the week's behaviour moved.
    const prev = { label: 'Stream', plannedMin: 360, keptMin: 540 };
    expect(fmtAuditDelta(stream, prev, '2026-W35')).toBe(' — level with W35');
    expect(fmtAuditDelta(stream, { ...prev, keptMin: 420 }, '2026-W35')).toBe(' — up 2h on W35');
  });

  it('says nothing when there is nothing to compare against', () => {
    expect(fmtAuditDelta(stream, null, '2026-W35')).toBe('');
    expect(fmtAuditDelta(stream, stream, null)).toBe('');
  });

  it('shortens the week id for the tail', () => {
    expect(shortWeekId('2026-W35')).toBe('W35');
    expect(shortWeekId(null)).toBe('');
  });

  it('matches last week’s row on the label, however it was cased', () => {
    const prev = [{ label: ' stream ', plannedMin: 720, keptMin: 600 }];
    expect(findPrevRow(stream, prev)?.keptMin).toBe(600);
    expect(findPrevRow({ label: 'Gym' }, prev)).toBeNull();
    expect(findPrevRow(stream, null)).toBeNull();
  });

  it('formats at most AUDIT_ROWS lines, in row order', () => {
    const audit = auditWeek(WEEK, {
      skeleton: [GYM, STREAM],
      windows: [],
      events: [ev('a', MON, 6, 7)],
    });
    expect(auditNoteLines(audit, [{ label: 'Gym', plannedMin: 300, keptMin: 0 }], '2026-W35')).toEqual([
      '- Audit: Stream — 12h planned / 0h kept',
      '- Audit: Gym — 5h planned / 1h kept — up 1h on W35',
    ]);
    expect(auditNoteLines(null, null, null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 QA — one event, one slot
// ---------------------------------------------------------------------------

describe('auditWeek — an event can only be kept once', () => {
  // The shipped skeleton puts these an hour apart and the match window is
  // ninety minutes wide: `Grocery Run` sun 14:00–15:00, `Meal Prep` sun
  // 15:00–17:00. Before `claimSlots`, one "Groceries + batch cook" event was
  // credited to both, so three hours of Sunday were written into the weekly
  // note as six — and Phase 5 persists that figure into frontmatter.
  const SUN = 6;
  const GROCERY: SkeletonBlock = {
    name: 'Grocery Run',
    kind: 'errand',
    days: [SUN],
    startMin: 14 * 60,
    endMin: 15 * 60,
  };
  const MEAL: SkeletonBlock = {
    name: 'Meal Prep',
    kind: 'meal-prep',
    days: [SUN],
    startMin: 15 * 60,
    endMin: 17 * 60,
  };

  it('does not credit one Sunday event to both adjacent slots', () => {
    const shop = ev('shop', SUN, 14, 17); // 14:00–17:00, three real hours
    const a = auditWeek(WEEK, {
      skeleton: [GROCERY, MEAL],
      windows: [],
      events: [shop],
    });
    const kept = a.rows.reduce((n, r) => n + r.keptMin, 0);
    expect(kept).toBe(180);

    // It goes to the slot it actually looks like it kept — the one it starts on.
    expect(row(a, 'kind:errand')?.keptMin).toBe(180);
    expect(row(a, 'kind:meal-prep')?.keptMin).toBe(0);
  });

  it('still credits both when there are two real events', () => {
    const a = auditWeek(WEEK, {
      skeleton: [GROCERY, MEAL],
      windows: [],
      events: [ev('shop', SUN, 14, 15), ev('cook', SUN, 15, 17)],
    });
    expect(row(a, 'kind:errand')?.keptMin).toBe(60);
    expect(row(a, 'kind:meal-prep')?.keptMin).toBe(120);
    expect(a.rows.reduce((n, r) => n + r.keptMin, 0)).toBe(180);
  });

  it('does not depend on the order the calendar arrived in', () => {
    const shop = ev('shop', SUN, 14, 15);
    const cook = ev('cook', SUN, 15, 17);
    const one = auditWeek(WEEK, {
      skeleton: [GROCERY, MEAL],
      windows: [],
      events: [shop, cook],
    });
    const two = auditWeek(WEEK, {
      skeleton: [GROCERY, MEAL],
      windows: [],
      events: [cook, shop],
    });
    expect(one.rows.map((r) => [r.key, r.keptMin])).toEqual(
      two.rows.map((r) => [r.key, r.keptMin]),
    );
  });
});

describe('auditStreaks — the `streaks:` map in the note (Phase 5 §2)', () => {
  const a = () =>
    auditWeek(WEEK, {
      skeleton: [GYM, STREAM],
      windows: [DEEP, ADMIN],
      events: [
        ev('g1', MON, 6, 7),
        ev('s1', MON, 9, 11, { taskId: 'x1' }),
      ],
    });

  it('is the habits only — an accepted proposal is not a streak', () => {
    expect(auditStreaks(a()).map((s) => s.name).sort()).toEqual(['gym', 'stream']);
  });

  it('carries the audit’s own counts, so the note cannot disagree with the rail', () => {
    const rows = a().rows.filter((r) => r.group === 'kind');
    expect(auditStreaks(a())).toEqual(
      rows.map((r) => ({ name: r.name, kept: r.kept, slots: r.slots })),
    );
  });

  it('has nothing to say about a week with no skeleton in it', () => {
    expect(auditStreaks(auditWeek(WEEK, { skeleton: [], windows: [], events: [] }))).toEqual([]);
    expect(auditStreaks(null)).toEqual([]);
  });
});

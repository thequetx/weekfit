import { describe, expect, it } from 'vitest';
import {
  MAX_SESSIONS,
  MIN_SESSION_MINUTES,
  computeGaps,
  fitTasks,
  placeItems,
  splitAcross,
} from '../src/lib/gaps';
import type { Gap, PlaceItem, Proposal } from '../src/lib/gaps';
import { parseTaskLine } from '../src/lib/duration';
import {
  DEPENDS_ON_RE,
  TASK_ID_LENGTH,
  TASK_ID_RE,
  newTaskId,
  parseDependsOn,
  parseTaskId,
  stripTaskIdFields,
  withTaskId,
} from '../src/lib/taskid';
import { sessionGroup } from '../src/lib/replan';
import { addDays, startOfISOWeek } from '../src/lib/week';
import type { AvailabilityWindow, CalEvent, DurationMap, VaultTask } from '../src/lib/types';

/**
 * Phase 4 §3 — multi-session tasks.
 *
 * Two halves, both pure: the **splitting rule** (documented at length in
 * lib/gaps.ts and asserted here clause by clause), and the **link** the
 * sessions share — Obsidian Tasks' own `🆔`, not a private field.
 */

// A plain Monday-start week well clear of any DST transition.
const WEEK = startOfISOWeek(new Date(2026, 8, 2)); // Wed 2 Sep 2026 -> Mon 31 Aug
const MON = 0;
const TUE = 1;
const WED = 2;
const THU = 3;
const FRI = 4;

const win = (
  name: string,
  days: number[],
  startMin: number,
  endMin: number,
  minBlockMin = 0,
): AvailabilityWindow => ({ name, days, startMin, endMin, minBlockMin });

const task = (
  text: string,
  line = 0,
  done = false,
  file = 'Weekly/2026-W36.md',
): VaultTask => ({ text, done, file, line });

const DURATIONS: DurationMap = {
  defaultMinutes: 60,
  byKind: { content: 90, admin: 30, deep: 120 },
};

/** Sessions as `day@start+minutes`, which is the whole shape of a proposal in
 *  one string and reads like the plan does. */
const shape = (ps: Proposal[]) =>
  ps.map((p) => `${p.day}@${p.startMin}+${p.minutes}`);

const item = (over: Partial<PlaceItem> = {}): PlaceItem => ({
  key: 'k',
  file: 'Weekly/2026-W36.md',
  line: 0,
  text: 'Edit video A',
  title: 'Edit video A',
  minutes: 240,
  wanted: null,
  kind: 'fit',
  ...over,
});

// ---------------------------------------------------------------------------
// The link: 🆔 / ⛔
// ---------------------------------------------------------------------------

describe('the Obsidian Tasks id fields', () => {
  it('reads a 🆔 off a task line', () => {
    expect(parseTaskId('- [ ] Edit video A 🆔 dg1st4')).toBe('dg1st4');
    expect(parseTaskId('Edit video A 🆔dg1st4')).toBe('dg1st4');
    expect(parseTaskId('Edit video A')).toBeNull();
  });

  it('reads ⛔ dependsOn, including the comma-separated form', () => {
    expect(parseDependsOn('Do this ⛔ dg1st4')).toEqual(['dg1st4']);
    expect(parseDependsOn('Do this ⛔ dg1st4,abc123')).toEqual(['dg1st4', 'abc123']);
    expect(parseDependsOn('Do this ⛔ dg1st4, abc123')).toEqual(['dg1st4', 'abc123']);
    expect(parseDependsOn('Do this')).toEqual([]);
  });

  it('does not let ⛔ eat the rest of the title', () => {
    // Ids join with commas, never bare spaces — a looser class would swallow
    // every following word, and the block would end up titled "Do this".
    expect(parseDependsOn('⛔ dg1st4 Edit the video')).toEqual(['dg1st4']);
    expect(stripTaskIdFields('⛔ dg1st4 Edit the video')).toBe('Edit the video');
  });

  it('strips both fields out of a display title', () => {
    expect(stripTaskIdFields('Edit video A 🆔 dg1st4')).toBe('Edit video A');
    expect(stripTaskIdFields('Edit video A ⛔ abc123 🆔 dg1st4')).toBe('Edit video A');
    expect(stripTaskIdFields('Edit video A')).toBe('Edit video A');
  });

  it('keeps the id out of the title the estimate parser produces', () => {
    // Which is also the title the Google event is created with — an id leaking
    // into an event summary is the failure this guards.
    expect(parseTaskLine('Edit video A ~4h 🆔 dg1st4').title).toBe('Edit video A');
    expect(parseTaskLine('Edit video A [est:: 90m] 🆔 dg1st4').title).toBe('Edit video A');
  });

  it('adds an id only when the line has none', () => {
    expect(withTaskId('- [ ] Edit video A', 'dg1st4')).toBe('- [ ] Edit video A 🆔 dg1st4');
    // An existing id always wins — something else in the vault may ⛔ it.
    expect(withTaskId('- [ ] Edit video A 🆔 keepme', 'dg1st4')).toBe(
      '- [ ] Edit video A 🆔 keepme',
    );
    expect(withTaskId('- [ ] Trailing space   ', 'dg1st4')).toBe(
      '- [ ] Trailing space 🆔 dg1st4',
    );
  });

  it('generates ids the standard would accept, and round-trips them', () => {
    let n = 0;
    const rand = () => ((n = (n * 7 + 3) % 61), n / 61); // deterministic
    const id = newTaskId(rand);
    expect(id).toHaveLength(TASK_ID_LENGTH);
    expect(id).toMatch(/^[A-Za-z0-9]+$/);
    expect(parseTaskId(withTaskId('- [ ] Task', id))).toBe(id);
    // Ten thousand real ones, no malformed output.
    for (let i = 0; i < 10_000; i++) expect(newTaskId()).toMatch(/^[A-Za-z0-9]{6}$/);
  });

  it('has regexes that survive being reused (no lastIndex surprises)', () => {
    // Both are non-global on purpose; a /g regex kept in module scope carries
    // lastIndex between calls and silently misses every other match.
    expect(TASK_ID_RE.global).toBe(false);
    expect(DEPENDS_ON_RE.global).toBe(false);
    for (let i = 0; i < 3; i++) expect(parseTaskId('a 🆔 xyz')).toBe('xyz');
  });
});

describe('sessionGroup', () => {
  const ev = (uid: string, taskId?: string): CalEvent => ({
    uid,
    title: uid,
    start: new Date(),
    end: new Date(),
    allDay: false,
    taskId,
  });

  it('gathers every block sharing a task id', () => {
    const all = [ev('a', 'x1'), ev('b', 'x1'), ev('c', 'x2'), ev('d')];
    expect(sessionGroup(all, all[0]).map((e) => e.uid)).toEqual(['a', 'b']);
  });

  it('leaves an unlinked event alone', () => {
    const all = [ev('a', 'x1'), ev('d')];
    expect(sessionGroup(all, all[1]).map((e) => e.uid)).toEqual(['d']);
  });
});

// ---------------------------------------------------------------------------
// The splitting rule
// ---------------------------------------------------------------------------

describe('splitting — the rule, clause by clause', () => {
  /** Four 2-hour deep-work mornings, Mon–Thu. */
  const mornings = (days = [MON, TUE, WED, THU], minBlock = 30) =>
    computeGaps(WEEK, [], [], [win('deep', days, 9 * 60, 11 * 60, minBlock)]);

  it('rule 1 — a task that fits whole is never split', () => {
    const gaps = mornings();
    const { proposals } = placeItems([item({ minutes: 120 })], gaps);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].session).toBeUndefined();
    expect(proposals[0].sessions).toBeUndefined();
    expect(shape(proposals)).toEqual(['0@540+120']);
  });

  it('rule 2 — sessions are taken in the same front-loaded order as a whole fit', () => {
    const { proposals } = placeItems([item({ minutes: 240 })], mornings());
    // Two 2-hour mornings, Monday then Tuesday. Not Wednesday and Thursday,
    // and not the roomiest-first order a best-fit packer would choose.
    expect(shape(proposals)).toEqual(['0@540+120', '1@540+120']);
    expect(proposals.map((p) => [p.session, p.sessions])).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('rule 3 — later sessions prefer the window the first one landed in', () => {
    // `content` (Tue–Thu afternoons) and `admin` (every day, earlier). The tag
    // sends session one into content; sessions two and three follow it there
    // rather than taking the earlier admin slots they'd otherwise win.
    const gaps = computeGaps(
      WEEK,
      [],
      [],
      [
        win('admin', [MON, TUE, WED, THU, FRI], 8 * 60, 10 * 60),
        win('content', [TUE, WED, THU], 13 * 60, 15 * 60),
      ],
    );
    const { proposals } = placeItems(
      [item({ minutes: 360, wanted: 'content' })],
      gaps,
    );
    expect(proposals.map((p) => p.window)).toEqual(['content', 'content', 'content']);
    expect(shape(proposals)).toEqual(['1@780+120', '2@780+120', '3@780+120']);
  });

  it('rule 3 — but leaves the window when the hours cannot be covered inside it', () => {
    const gaps = computeGaps(
      WEEK,
      [],
      [],
      [
        win('content', [TUE], 13 * 60, 15 * 60), // one 2h content slot
        win('deep', [WED, THU], 9 * 60, 11 * 60),
      ],
    );
    const { proposals } = placeItems(
      [item({ minutes: 360, wanted: 'content' })],
      gaps,
    );
    expect(proposals.map((p) => p.window)).toEqual(['content', 'deep', 'deep']);
  });

  it('rule 4 — at most one session per day', () => {
    // Lunch splits both days into two 2-hour gaps. A 4-hour task could be two
    // sittings on Monday alone; it takes Monday *once* and moves to Tuesday.
    const gaps = computeGaps(
      WEEK,
      [],
      [
        { uid: 'l1', title: 'Lunch', start: at(MON, 11), end: at(MON, 12), allDay: false },
        { uid: 'l2', title: 'Lunch', start: at(TUE, 11), end: at(TUE, 12), allDay: false },
      ],
      [win('deep', [MON, TUE], 9 * 60, 14 * 60)],
    );
    expect(gaps.filter((g) => g.day === MON)).toHaveLength(2);
    const { proposals } = placeItems([item({ minutes: 240 })], gaps);
    expect(proposals.map((p) => p.day)).toEqual([MON, TUE]);
  });

  it('rule 5 — never a fragment: no session under an hour', () => {
    const { proposals } = placeItems([item({ minutes: 240 })], mornings());
    for (const p of proposals) expect(p.minutes).toBeGreaterThanOrEqual(MIN_SESSION_MINUTES);
  });

  it("rule 5 — nor under a window's own min_block", () => {
    // Three 90-minute mornings in a window that says 90 is the least worth
    // interrupting for. 4h can't be covered by 90+90+60, because 60 < 90 —
    // and 90+90 is only 3h, so the task doesn't fit at all.
    const gaps = computeGaps(
      WEEK,
      [],
      [],
      [win('deep', [MON, TUE, WED], 9 * 60, 10 * 60 + 30, 90)],
    );
    const { proposals, unplaced } = placeItems([item({ minutes: 240 })], gaps);
    expect(proposals).toEqual([]);
    expect(unplaced[0].reason).toBe('no-gap');
    // The same gaps take a 3-hour task in two 90s.
    const three = placeItems([item({ minutes: 180 })], gaps);
    expect(shape(three.proposals)).toEqual(['0@540+90', '1@540+90']);
  });

  it('rule 6 — uneven hours front-load rather than averaging', () => {
    // A 3h Monday and a 2h Tuesday, for 5h of work: 3 + 2, not 2.5 + 2.5.
    const gaps = computeGaps(
      WEEK,
      [],
      [],
      [win('deep', [MON], 9 * 60, 12 * 60), win('deep2', [TUE], 9 * 60, 11 * 60)],
    );
    const { proposals } = placeItems([item({ minutes: 300 })], gaps);
    expect(proposals.map((p) => p.minutes)).toEqual([180, 120]);
  });

  it('rule 6 — the tail shave: never leaves a remainder too small to be a session', () => {
    // 3.5h across a 3h Monday and a 2.5h Tuesday. Taking all 3 of Monday's
    // hours would leave a 30-minute tail, which is exactly the fragment the
    // rule forbids, so Monday gives 2.5h and Tuesday takes a full hour.
    const gaps = computeGaps(
      WEEK,
      [],
      [],
      [
        win('deep', [MON], 9 * 60, 12 * 60),
        win('deep2', [TUE], 9 * 60, 11 * 60 + 30),
      ],
    );
    const { proposals } = placeItems([item({ minutes: 210 })], gaps);
    expect(proposals.map((p) => p.minutes)).toEqual([150, 60]);
    expect(proposals.map((p) => p.minutes).reduce((a, b) => a + b, 0)).toBe(210);
  });

  it('rule 6 — every session lands on the 30-minute lattice', () => {
    // A gap of an odd length (an event ended at 09:17) can't produce a session
    // that starts the board drawing half-pixels.
    const gaps = computeGaps(
      WEEK,
      [],
      [
        {
          uid: 'ran-over',
          title: 'Ran over',
          start: at(MON, 9),
          end: at(MON, 9, 17),
          allDay: false,
        },
      ],
      [win('deep', [MON, TUE], 9 * 60, 12 * 60)],
    );
    const { proposals } = placeItems([item({ minutes: 240 })], gaps);
    for (const p of proposals) expect(p.minutes % 30).toBe(0);
    expect(proposals.map((p) => p.minutes).reduce((a, b) => a + b, 0)).toBe(240);
  });

  it('rule 7 — refuses to spread a task over more than MAX_SESSIONS sittings', () => {
    // Five 1-hour mornings, five hours of work. One hour per day would need
    // five sittings; four is the limit, so it doesn't fit.
    const gaps = computeGaps(
      WEEK,
      [],
      [],
      [win('deep', [MON, TUE, WED, THU, FRI], 9 * 60, 10 * 60)],
    );
    const { proposals, unplaced } = placeItems([item({ minutes: 300 })], gaps);
    expect(proposals).toEqual([]);
    expect(unplaced).toEqual([
      { key: 'k', title: 'Edit video A', minutes: 300, reason: 'too-many-sessions' },
    ]);
    // Four of those hours do fit, in exactly MAX_SESSIONS.
    const four = placeItems([item({ minutes: 240 })], gaps);
    expect(four.proposals).toHaveLength(MAX_SESSIONS);
  });

  it('rule 8 — all or nothing: a partially-coverable task gets no ghosts at all', () => {
    // Two hours of window against four hours of work. Proposing the two and
    // saying nothing about the rest would be the board quietly under-planning.
    const gaps = computeGaps(WEEK, [], [], [win('deep', [MON], 9 * 60, 11 * 60)]);
    const { proposals, unplaced } = placeItems([item({ minutes: 240 })], gaps);
    expect(proposals).toEqual([]);
    expect(unplaced).toHaveLength(1);
  });

  it('rule 8 — a failed split leaves the gap board untouched for the next task', () => {
    // The 4h task can't be covered; the 2h one behind it must still get the
    // Monday morning the failed trial walked over.
    const gaps = computeGaps(WEEK, [], [], [win('deep', [MON], 9 * 60, 11 * 60)]);
    const { proposals, unplaced } = placeItems(
      [item({ key: 'big', minutes: 240 }), item({ key: 'small', minutes: 120 })],
      gaps,
    );
    expect(unplaced.map((u) => u.key)).toEqual(['big']);
    expect(shape(proposals)).toEqual(['0@540+120']);
  });

  it('an indivisible task — 90m with only 60m gaps — is reported, not fragmented', () => {
    // 90 can only split as 60 + 30, and 30 is below the minimum session. The
    // honest answer is "won't fit", not a half-hour fragment on Tuesday.
    const gaps = computeGaps(
      WEEK,
      [],
      [],
      [win('deep', [MON, TUE, WED], 9 * 60, 10 * 60)],
    );
    const { proposals, unplaced } = placeItems([item({ minutes: 90 })], gaps);
    expect(proposals).toEqual([]);
    expect(unplaced[0].reason).toBe('no-gap');
  });

  it('is deterministic and never mutates the gaps it was given', () => {
    const gaps = mornings();
    const before = JSON.stringify(gaps);
    const a = placeItems([item({ minutes: 240 })], gaps);
    const b = placeItems([item({ minutes: 240 })], gaps);
    expect(JSON.stringify(gaps)).toBe(before);
    expect(shape(a.proposals)).toEqual(shape(b.proposals));
  });

  it('splitAcross reports which failure it was', () => {
    const one = computeGaps(WEEK, [], [], [win('deep', [MON], 9 * 60, 10 * 60)]);
    expect(splitAcross(one as Gap[], 240, null)).toEqual({
      ok: false,
      reason: 'no-gap',
    });
    const five = computeGaps(
      WEEK,
      [],
      [],
      [win('deep', [MON, TUE, WED, THU, FRI], 9 * 60, 10 * 60)],
    );
    expect(splitAcross(five as Gap[], 300, null)).toMatchObject({
      ok: false,
      reason: 'too-many-sessions',
    });
  });
});

// ---------------------------------------------------------------------------
// Sessions on the board
// ---------------------------------------------------------------------------

describe('sessions as proposals', () => {
  const gaps = () =>
    computeGaps(WEEK, [], [], [win('deep', [MON, TUE, WED, THU], 9 * 60, 11 * 60)]);

  it('every session of one task shares a groupKey and carries n/N', () => {
    const { proposals } = fitTasks([task('Edit video A ~4h')], gaps(), DURATIONS);
    expect(proposals).toHaveLength(2);
    expect(new Set(proposals.map((p) => p.groupKey)).size).toBe(1);
    expect(proposals[0].groupKey).toBe('Weekly/2026-W36.md:0');
    // Ghost keys stay unique — two ghosts with the same React key would
    // collapse into one block on the board.
    expect(new Set(proposals.map((p) => p.key)).size).toBe(2);
    expect(proposals.map((p) => `${p.session}/${p.sessions}`)).toEqual(['1/2', '2/2']);
  });

  it('carries the task line’s existing 🆔 onto every session', () => {
    const { proposals } = fitTasks(
      [task('Edit video A ~4h 🆔 dg1st4')],
      gaps(),
      DURATIONS,
    );
    expect(proposals.map((p) => p.taskId)).toEqual(['dg1st4', 'dg1st4']);
    // …and the id never reaches the title, which is the event summary.
    expect(proposals.map((p) => p.title)).toEqual(['Edit video A', 'Edit video A']);
  });

  it('leaves taskId unset when the line has no id yet — accepting is what writes one', () => {
    const { proposals } = fitTasks([task('Edit video A ~4h')], gaps(), DURATIONS);
    expect(proposals.every((p) => p.taskId === undefined)).toBe(true);
  });

  it('mixes split and unsplit tasks in one fit, in the rail’s own order', () => {
    const { proposals } = fitTasks(
      [task('Edit video A ~4h', 0), task('Book dentist ~1h', 1)],
      gaps(),
      DURATIONS,
    );
    expect(proposals.map((p) => p.title)).toEqual([
      'Edit video A',
      'Edit video A',
      'Book dentist',
    ]);
    // The dentist takes what the split left behind, not a day of its own.
    expect(shape(proposals)).toEqual(['0@540+120', '1@540+120', '2@540+60']);
  });
});

const at = (day: number, h: number, m = 0, weekStart = WEEK) => {
  const d = addDays(weekStart, day);
  d.setHours(h, m, 0, 0);
  return d;
};

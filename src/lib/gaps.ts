// The open-gap engine — Phase 4 §2, the headline feature.
//
// `blocks:` says what already happens. `windows:` says when work *could* go.
// Subtract the blocks and the real calendar from the windows and what's left is
// a candidate slot. That's the whole idea, and it is deliberately deterministic
// arithmetic over a yaml file and a calendar — no clock, no IO, no network, no
// LLM (Phase 4, "Explicitly not doing").
//
// **Suggest, never move.** Nothing in this file writes anywhere. It returns
// intervals and proposals; the Planner renders them as ghosts and only an
// explicit Accept turns one into a calendar event.
//
// Purity is the point: everything below is a function of its arguments, the
// clock included (`opts.now` is passed in, never read). That is what makes the
// DST week, the all-day event and the fully-booked week testable at all.

import type {
  AvailabilityWindow,
  CalEvent,
  DurationMap,
  SkeletonBlock,
  VaultTask,
} from './types';
import { dayIndex, minutesOfDay } from './week';
import {
  DEFAULT_DURATIONS,
  SNAP_MINUTES,
  parseTaskLine,
  resolveTaskDuration,
  snapToGrid,
  taskKind,
} from './duration';
import { parseTaskId } from './taskid';
import { DAY_PLANNER_RE, isPlaced } from './source';

/** Title comparison key: the display title, lowercased, whitespace collapsed.
 *  Both sides go through `parseTaskLine`, so a `~90m` estimate or a `🆔` on the
 *  task can't stop it matching the event it produced — the event was titled
 *  with exactly that stripped string. */
export function titleKey(text: string): string {
  return parseTaskLine(String(text ?? ''))
    // A scheduled task carries a Day Planner range in its *title* — source.ts
    // leaves it there deliberately, because that is where Day Planner and a human
    // reader both expect it. But the calendar event this app created is titled
    // without it, so once the app scheduled something it could no longer match
    // its own event: the task stayed in Unscheduled and Fit this week would
    // happily propose it a second time. Compare the work, not when it was put.
    .title.replace(DAY_PLANNER_RE, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The sessions of one task that are still on the calendar and still in the
 * future.
 *
 * Two callers, one question. `lib/replan.ts` (which re-exports this) uses it
 * for §3's "ticking the task marks the remaining sessions done"; `fitTasks`
 * below uses it to leave already-booked work alone. Past sessions are excluded
 * from both: they are the record of what was planned — §5's audit wants them,
 * and a task whose only blocks have been and gone is §4's to re-propose, not
 * something to quietly double-book.
 */
export function futureSessions(
  events: CalEvent[],
  task: VaultTask,
  now: Date,
): CalEvent[] {
  const id = parseTaskId(task.text);
  const key = titleKey(task.text);
  return events.filter((ev) => {
    if (ev.allDay) return false;
    if (ev.end.getTime() <= now.getTime()) return false;
    return id && ev.taskId ? ev.taskId === id : titleKey(ev.title) === key;
  });
}

export const DAY_MINUTES = 24 * 60;

/** Default `min_block` for a window that doesn't name one — half an hour, the
 *  same lattice a dropped task snaps to. */
export const DEFAULT_MIN_BLOCK = 30;

/** How far a drop is allowed to be pulled to reach a gap. Beyond this the drop
 *  is left exactly where Tyler put it: snapping across half a day would be the
 *  board moving things on its own, which is the one thing it must not do. */
export const SNAP_REACH_MINUTES = 90;

export interface Interval {
  startMin: number;
  endMin: number;
}

/** A free interval inside one availability window on one day of the week. */
export interface Gap {
  day: number; // 0 = Monday ... 6 = Sunday, within the rendered week
  startMin: number;
  endMin: number;
  minutes: number;
  window: string; // the window's name
  windowIndex: number; // its index in `windows:` — the deterministic tie-break
  minBlockMin: number;
}

export interface GapOptions {
  /** The caller's clock. Supplied, never read here. When given, gaps that have
   *  already passed are dropped and the one containing `now` is trimmed —
   *  proposing Monday morning on Wednesday helps nobody. Omit it (or pass null)
   *  for a week that isn't the current one, and the whole week is offered. */
  now?: Date | null;
  /** Whether an all-day event blocks its whole day. Default true: an all-day
   *  entry is usually leave, a holiday or a trip, and quietly proposing four
   *  hours of deep work inside one is worse than losing a day of candidates.
   *  The knob exists so a vault full of informational all-day markers has a
   *  one-line escape. */
  allDayIsBusy?: boolean;
}

// ---------------------------------------------------------------------------
// Busy time
// ---------------------------------------------------------------------------

function pushBusy(days: Interval[][], di: number, a: number, b: number): void {
  if (!Number.isFinite(di) || di < 0 || di > 6) return;
  const startMin = Math.min(Math.max(a, 0), DAY_MINUTES);
  const endMin = Math.min(Math.max(b, 0), DAY_MINUTES);
  if (endMin > startMin) days[di].push({ startMin, endMin });
}

/** Overlapping and touching intervals collapsed into one, ascending. Events
 *  overlap constantly (a stream inside a "work" block, two things double
 *  booked); without this the subtraction below would emit negative slivers. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list
    .slice()
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, iv.endMin);
    } else {
      out.push({ startMin: iv.startMin, endMin: iv.endMin });
    }
  }
  return out;
}

/**
 * Everything already spoken for, as merged wall-clock intervals per day column.
 *
 * All the day maths goes through `dayIndex` / `minutesOfDay` — calendar fields
 * and a rounded day count, never raw millisecond division — because Sydney's
 * 23- and 25-hour days would otherwise slide an event into the wrong column
 * (see test/dst.test.ts). An event that starts before the week or ends after it
 * contributes only the days that land inside it.
 */
export function busyByDay(
  weekStart: Date,
  skeleton: SkeletonBlock[],
  events: CalEvent[],
  allDayIsBusy = true,
): Interval[][] {
  const days: Interval[][] = Array.from({ length: 7 }, () => []);

  for (const b of skeleton) {
    for (const di of b.days) pushBusy(days, di, b.startMin, b.endMin);
  }

  for (const ev of events) {
    const startDay = dayIndex(ev.start, weekStart);

    if (ev.allDay) {
      if (!allDayIsBusy) continue;
      // Both the Google and the .ics readers give an all-day event an
      // *exclusive* end (midnight of the day after), so the last day it
      // actually covers is one back — and a one-day event lands on itself.
      const lastDay = Math.max(startDay, dayIndex(ev.end, weekStart) - 1);
      for (let d = Math.max(startDay, 0); d <= Math.min(lastDay, 6); d++) {
        pushBusy(days, d, 0, DAY_MINUTES);
      }
      continue;
    }

    const endDay = dayIndex(ev.end, weekStart);
    const startAt = minutesOfDay(ev.start);
    const endAt = minutesOfDay(ev.end);

    if (endDay <= startDay) {
      // Same day — or an end before its start, which pushBusy discards.
      pushBusy(days, startDay, startAt, endAt);
    } else {
      // Runs past midnight: the tail of the first day, whole days in between,
      // and the head of the last. Ending exactly at midnight yields a
      // zero-length head, which pushBusy also discards.
      pushBusy(days, startDay, startAt, DAY_MINUTES);
      for (let d = Math.max(startDay + 1, 0); d <= Math.min(endDay - 1, 6); d++) {
        pushBusy(days, d, 0, DAY_MINUTES);
      }
      pushBusy(days, endDay, 0, endAt);
    }
  }

  return days.map(mergeIntervals);
}

/** `window` minus `busy` (which must already be merged and ascending). */
export function freeWithin(window: Interval, busy: Interval[]): Interval[] {
  const out: Interval[] = [];
  let cursor = window.startMin;
  for (const b of busy) {
    if (b.endMin <= cursor) continue;
    if (b.startMin >= window.endMin) break;
    if (b.startMin > cursor) out.push({ startMin: cursor, endMin: b.startMin });
    cursor = b.endMin;
    if (cursor >= window.endMin) break;
  }
  if (cursor < window.endMin) out.push({ startMin: cursor, endMin: window.endMin });
  return out;
}

// ---------------------------------------------------------------------------
// The ranking
// ---------------------------------------------------------------------------

/**
 * **The ranking rule.** Gaps come back in chronological order — earlier day
 * first, then earlier in the day, then the order the window is written in
 * `windows:`.
 *
 * Why chronological and not, say, biggest-first or best-fit: the ranked list is
 * read as "the next time you could actually do something", and a board whose
 * top suggestion is Friday because Friday happens to have the roomiest
 * afternoon is a board Tyler has to argue with. Front-loading the week is also
 * the behaviour that makes §4 (replan undone) meaningful — work that slips has
 * somewhere left to slip to.
 *
 * Window *fit* is deliberately not in this comparator: whether a `content`
 * window beats an `admin` one depends on the task, so it lives in `fitTasks`
 * where a task is actually in hand.
 *
 * `(day, startMin, windowIndex)` is unique — two gaps from the same window on
 * the same day can't share a start — so the order never depends on the sort
 * being stable, and never on the iteration order of an object's keys.
 */
export function compareGaps(a: Gap, b: Gap): number {
  return (
    a.day - b.day ||
    a.startMin - b.startMin ||
    a.windowIndex - b.windowIndex ||
    a.endMin - b.endMin
  );
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * `(skeleton blocks, real events, windows) → ranked free intervals`.
 *
 * A gap is never inside a skeleton block or a real event: the windows are the
 * only source of candidate time and every busy interval is subtracted from them
 * before anything is emitted. A gap shorter than its window's `min_block` is
 * dropped — not shown, and not counted as free time, because a footer that
 * counts unusable slivers as availability is a footer that lies.
 */
export function computeGaps(
  weekStart: Date,
  skeleton: SkeletonBlock[],
  events: CalEvent[],
  windows: AvailabilityWindow[],
  opts: GapOptions = {},
): Gap[] {
  if (!windows.length) return [];

  const busy = busyByDay(weekStart, skeleton, events, opts.allDayIsBusy !== false);

  // The clock, if the caller handed one over. `nowDay` outside 0..6 means the
  // week isn't the current one: before it, nothing is stale; after it,
  // everything is.
  const now = opts.now ?? null;
  const nowDay = now ? dayIndex(now, weekStart) : null;
  const nowMin = now ? minutesOfDay(now) : 0;

  const gaps: Gap[] = [];
  windows.forEach((w, windowIndex) => {
    const minBlock = Math.max(0, w.minBlockMin || 0);
    if (w.endMin <= w.startMin) return; // a window that spans nothing
    for (const day of w.days) {
      if (day < 0 || day > 6) continue;
      if (nowDay != null && day < nowDay) continue;
      for (const iv of freeWithin(
        { startMin: w.startMin, endMin: w.endMin },
        busy[day],
      )) {
        let startMin = iv.startMin;
        if (nowDay != null && day === nowDay) {
          // Round the "now" edge up to the grid lattice, so a proposal never
          // starts at 14:07.
          startMin = Math.max(startMin, Math.ceil(nowMin / SNAP_MINUTES) * SNAP_MINUTES);
        }
        const minutes = iv.endMin - startMin;
        if (minutes < Math.max(minBlock, 1)) continue;
        gaps.push({
          day,
          startMin,
          endMin: iv.endMin,
          minutes,
          window: w.name,
          windowIndex,
          minBlockMin: minBlock,
        });
      }
    }
  });

  return gaps.sort(compareGaps);
}

/**
 * Free minutes across the week, for the rail footer's "… / 14h free" half.
 *
 * Returns **null** when no windows are configured. That is not the same as
 * zero: an unconfigured time map means "unknown", and rendering `0h free`
 * beside any committed hours at all would paint every week crimson.
 *
 * Overlapping windows are unioned per day rather than summed, so declaring a
 * `deep` and a `content` window over the same Saturday morning doesn't invent
 * four hours that don't exist.
 */
export function freeMinutes(
  windows: AvailabilityWindow[],
  gaps: Gap[],
): number | null {
  if (!windows.length) return null;
  const byDay: Interval[][] = Array.from({ length: 7 }, () => []);
  for (const g of gaps) byDay[g.day].push({ startMin: g.startMin, endMin: g.endMin });
  return byDay.reduce(
    (sum, day) =>
      sum + mergeIntervals(day).reduce((s, iv) => s + (iv.endMin - iv.startMin), 0),
    0,
  );
}

// ---------------------------------------------------------------------------
// Placement — still only a proposal
// ---------------------------------------------------------------------------

/** Where a proposal came from. Both kinds are ghosts; the label is what lets
 *  the rail say "replan" instead of "fit" and what makes the replan tally in
 *  the weekly note possible (Phase 4 §4). */
export type ProposalKind = 'fit' | 'replan';

/** One proposed placement. A ghost on the board until Tyler accepts it; this
 *  object never reaches Google. */
export interface Proposal {
  /** Unique per ghost. `${file}:${line}` for a single block, plus `#n` for the
   *  nth session of a split one. */
  key: string;
  /** Shared by every session of one task — the handle for "accept the group",
   *  "dismiss the group", and the rail's "this task has a ghost" dot. */
  groupKey: string;
  kind: ProposalKind;
  file: string;
  line: number;
  text: string; // the raw task line
  title: string; // display title, estimate and 🆔/⛔ stripped
  minutes: number;
  day: number;
  startMin: number;
  endMin: number;
  window: string;
  /** The task's Obsidian Tasks `🆔`, when the line already carries one. Absent
   *  means "not written down yet"; accepting the group is what writes it. */
  taskId?: string;
  /** 1-based session index and total, for the `2/3` badge. Both absent on a
   *  task that fits in one sitting — one block is not "1/1". */
  session?: number;
  sessions?: number;
  /** Replan only: the passed block this proposal is a second attempt at. */
  sourceUid?: string;
  /** Set when a *drag* has put this ghost on top of a skeleton block or a real
   *  event (`proposalConflict`). Never set by the engine, which only ever
   *  places into gaps — this is the one thing a hand-drop can do that fitting
   *  can't, and the board says so rather than accepting it silently. */
  conflict?: ProposalConflict;
}

/** Why a task got no ghost. Said out loud rather than silently dropped — "it
 *  doesn't fit" is the useful half of the answer, and the two reasons want
 *  different responses (make a window bigger vs. break the task up yourself). */
export type UnplacedReason = 'no-gap' | 'too-many-sessions';

export interface Unplaced {
  key: string;
  title: string;
  minutes: number;
  reason: UnplacedReason;
}

export interface FitResult {
  proposals: Proposal[];
  /** Tasks with no gap big enough anywhere in the week, or that would need
   *  more sessions than a week's plan should carry. */
  unplaced: Unplaced[];
}

// --- the splitting rule ----------------------------------------------------
//
// **Phase 4 §3.** A task whose estimate is bigger than every remaining gap is
// split across several sittings — `Edit video A ~4h` → 2h Tue + 1h Wed + 1h Thu
// — instead of coming back as "won't fit". The rule is deterministic and, more
// to the point, defensible; an optimiser whose output nobody can predict is a
// board Tyler argues with rather than plans in.
//
//  1. **A task that fits whole is never split.** One block beats three. The
//     split only runs once no single remaining gap can hold the whole estimate.
//
//  2. **Sessions are taken in the same preference order as a whole placement**
//     — a window whose name matches a `#tag` on the task first, then earliest
//     day, then earliest start, then the window's index in `windows:`. So a
//     split job front-loads the week exactly like an unsplit one.
//
//  3. **Sessions after the first prefer the window the first one landed in.**
//     Four hours of editing scattered across `deep`, `admin` and `errands`
//     isn't a plan, it's a shape. Same window is a preference, not a rule: if
//     the hours can only be covered by leaving it, they are.
//
//  4. **At most one session per day.** A task is being split because it doesn't
//     fit in one sitting; two sittings on the same day is one sitting with an
//     interruption, and the whole reason a *week*-shaped board shows this
//     better than a day-first one is that the sessions land on different days.
//
//  5. **No session shorter than `MIN_SESSION_MINUTES` (60), or than the
//     window's own `min_block` if that is larger.** This is the "don't propose
//     a 15-minute fragment" rule. A window that says `min_block: 90` doesn't
//     get a 60-minute session either — it already said what it's worth
//     interrupting for.
//
//  6. **Uneven hours are front-loaded, never averaged** — 5h across gaps of 3h
//     and 2h is 3h + 2h, not 2.5h + 2.5h. Averaging invents a session length
//     that no gap asked for and then has to round it anyway. The one adjustment
//     is the **tail shave**: if taking everything a gap offers would leave a
//     remainder too short to be a session of its own, the current session gives
//     the remainder just enough to stand up (3.5h across a 3h gap becomes
//     2.5h + 1h, not 3h + 0.5h). If shaving would push the current session
//     itself under the minimum, the split fails rather than emitting a fragment.
//
//  7. **At most `MAX_SESSIONS` (4) sessions.** Past four sittings the thing on
//     the line isn't a task, it's a project, and the honest answer is "this
//     doesn't fit this week" rather than a week wallpapered with one job.
//
//  8. **All or nothing.** A task that can't be fully covered gets no ghosts at
//     all. Proposing 2 hours of a 4-hour job and saying nothing about the other
//     2 would be a board that quietly under-plans — the same failure as
//     silently dropping the task, only harder to notice.

/** Shortest sitting worth proposing as one session of a bigger task. */
export const MIN_SESSION_MINUTES = 60;

/** Most sittings a single task may be spread across in one week. */
export const MAX_SESSIONS = 4;

/** One item to place — a task from the rail, or a passed block being replanned
 *  (Phase 4 §4). `fitTasks` and `replanFit` both reduce to this, so the
 *  splitting rule above is one implementation used by both. */
export interface PlaceItem {
  key: string;
  file: string;
  line: number;
  text: string;
  title: string;
  minutes: number;
  /** Window name this item prefers, lowercased — from a `#tag` on the task. */
  wanted: string | null;
  kind: ProposalKind;
  taskId?: string;
  sourceUid?: string;
}

/** A gap with the minutes still unspoken for. Gaps are retired by zeroing
 *  `minutes` rather than being spliced out, so an index stays an index across a
 *  trial split — see `splitAcross`. */
type Remaining = Gap;

function floorToSnap(minutes: number): number {
  return Math.floor(minutes / SNAP_MINUTES) * SNAP_MINUTES;
}

/** The floor for one session inside this gap: the global minimum, or the
 *  window's own `min_block` when it asked for something longer. */
function sessionFloor(g: Gap): number {
  return Math.max(MIN_SESSION_MINUTES, g.minBlockMin || 0);
}

/** Best remaining gap that can hold `minutes`, in the order documented on
 *  `fitTasks`. `skipDays` enforces one-session-per-day during a split. */
function pickGap(
  remaining: Remaining[],
  minutes: number,
  wanted: string | null,
  skipDays?: Set<number>,
): number {
  let bestAt = -1;
  let best: Gap | null = null;
  for (let i = 0; i < remaining.length; i++) {
    const g = remaining[i];
    if (g.minutes < minutes) continue;
    if (skipDays && skipDays.has(g.day)) continue;
    if (best && !beatsFor(g, best, wanted)) continue;
    best = g;
    bestAt = i;
  }
  return bestAt;
}

/** Take `minutes` off the front of a gap. A remainder too short for its own
 *  window retires the gap outright — it was never proposable. */
function consume(g: Remaining, minutes: number): void {
  const rest = g.endMin - (g.startMin + minutes);
  if (rest >= Math.max(g.minBlockMin, 1)) {
    g.startMin += minutes;
    g.minutes = rest;
  } else {
    g.minutes = 0; // retired; `pickGap` skips it from here on
  }
}

interface Session {
  gapAt: number;
  day: number;
  startMin: number;
  minutes: number;
  window: string;
}

/**
 * Spread `minutes` across several gaps under the rule documented above.
 * Returns the sessions in chronological order of being taken, or null when the
 * hours can't be covered inside `MAX_SESSIONS` one-per-day sittings.
 *
 * Runs against a copy of `remaining` so a failed split leaves the gap board
 * exactly as it found it; the caller copies the trial back only on success.
 */
export type SplitResult =
  | { ok: true; sessions: Session[]; remaining: Remaining[] }
  | { ok: false; reason: UnplacedReason };

export function splitAcross(
  remaining: Remaining[],
  minutes: number,
  wanted: string | null,
): SplitResult {
  const trial = remaining.map((g) => ({ ...g }));
  const sessions: Session[] = [];
  const usedDays = new Set<number>();
  let left = minutes;
  // Rule 3: after the first session the task prefers to stay in the window it
  // started in. `wanted` (the task's own `#tag`) picks the first one.
  let prefer = wanted;

  while (left > 0) {
    // Rule 7 — past four sittings it isn't a task any more.
    if (sessions.length >= MAX_SESSIONS) return { ok: false, reason: 'too-many-sessions' };
    const at = pickGap(trial, MIN_SESSION_MINUTES, prefer, usedDays);
    if (at === -1) return { ok: false, reason: 'no-gap' };
    const g = trial[at];
    const floor = sessionFloor(g); // rule 5
    if (g.minutes < floor) return { ok: false, reason: 'no-gap' };

    let take = Math.min(left, floorToSnap(g.minutes));
    // Rule 6, the tail shave: never leave a remainder too small to be a
    // session of its own.
    const tail = left - take;
    if (tail > 0 && tail < MIN_SESSION_MINUTES) take = left - MIN_SESSION_MINUTES;
    if (take < floor) return { ok: false, reason: 'no-gap' };

    sessions.push({
      gapAt: at,
      day: g.day,
      startMin: g.startMin,
      minutes: take,
      window: g.window,
    });
    usedDays.add(g.day); // rule 4
    if (prefer == null) prefer = g.window.toLowerCase();
    consume(g, take);
    left -= take;
  }

  // A single session means the whole thing fitted in one gap after all, which
  // `placeItems` already tried — reached only when a caller splits directly.
  return sessions.length
    ? { ok: true, sessions, remaining: trial }
    : { ok: false, reason: 'no-gap' };
}

/**
 * Place a list of sized items into the gaps. Whole first, split second, and
 * nothing at all if neither works.
 *
 * Items are placed in the order they were handed over — the rail's order, which
 * is the weekly note's own line order. Tyler's list is his priority order, and
 * a packer that reshuffled it (largest-first, tightest-fit) would plan a
 * different week than the one he wrote down. Deliberately not clever.
 *
 * Placement is greedy and non-backtracking: an earlier item can take the slot a
 * later one wanted. That's visible on the board and fixable by dragging a
 * ghost, which beats an optimiser whose output nobody can predict.
 */
export function placeItems(items: PlaceItem[], gaps: Gap[]): FitResult {
  // Mutable copies — a placement consumes the front of its gap and leaves the
  // remainder for the next item. `gaps` itself is never touched.
  let remaining: Remaining[] = gaps.map((g) => ({ ...g }));
  const proposals: Proposal[] = [];
  const unplaced: Unplaced[] = [];

  for (const item of items) {
    const base = {
      groupKey: item.key,
      kind: item.kind,
      file: item.file,
      line: item.line,
      text: item.text,
      title: item.title,
      taskId: item.taskId,
      sourceUid: item.sourceUid,
    };

    // Rule 1 — one block beats three.
    const at = pickGap(remaining, item.minutes, item.wanted);
    if (at !== -1) {
      const g = remaining[at];
      proposals.push({
        ...base,
        key: item.key,
        minutes: item.minutes,
        day: g.day,
        startMin: g.startMin,
        endMin: g.startMin + item.minutes,
        window: g.window,
      });
      consume(g, item.minutes);
      continue;
    }

    const split = splitAcross(remaining, item.minutes, item.wanted);
    if (!split.ok) {
      // Which of the two failures it was decides what Tyler can do about it:
      // "no gap is big enough for even one more session" wants a wider window,
      // "it would take more than four sittings" wants a smaller task.
      unplaced.push({
        key: item.key,
        title: item.title,
        minutes: item.minutes,
        reason: split.reason,
      });
      continue;
    }

    const total = split.sessions.length;
    split.sessions.forEach((s, i) => {
      proposals.push({
        ...base,
        key: `${item.key}#${i + 1}`,
        minutes: s.minutes,
        day: s.day,
        startMin: s.startMin,
        endMin: s.startMin + s.minutes,
        window: s.window,
        session: i + 1,
        sessions: total,
      });
    });
    remaining = split.remaining; // rule 8 — applied only now the split held
  }

  return { proposals, unplaced };
}

/** A window-name lookup shaped for `taskKind`, which wants a Record. */
function windowNames(gaps: Gap[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of gaps) out[g.window.toLowerCase()] = 0;
  return out;
}

/**
 * "Fit this week": proposed placements for every unscheduled task that has a
 * size — which, thanks to §1's rung A, is every task.
 *
 * **The placement rule**, in order:
 *   1. a gap whose window name matches a `#tag` on the task (`#content` → the
 *      `content` window). That's what a time map is *for*; ignoring it would
 *      make `windows:` decorative.
 *   2. earliest day, then earliest start — the same front-loading as
 *      `compareGaps`.
 *   3. the window's index in `windows:`, so two windows covering the same hour
 *      resolve the same way on every run.
 *
 * A task too big for any one gap is split across several rather than reported
 * as "won't fit" — see the splitting rule above.
 *
 * **Unscheduled, not merely unchecked.** Given `opts.events` and `opts.now`, a
 * task that already has a block ahead of it on the calendar is skipped: it has
 * been fitted and accepted, and a second Fit on Tuesday proposing the Sunday
 * job all over again is how one task ends up booked twice. Without them the old
 * behaviour stands — every unchecked task is a candidate — which is what the
 * pure-arithmetic tests want.
 */
export function fitTasks(
  tasks: VaultTask[],
  gaps: Gap[],
  durations: DurationMap = DEFAULT_DURATIONS,
  opts: { events?: CalEvent[]; now?: Date | null } = {},
): FitResult {
  const names = windowNames(gaps);
  const items: PlaceItem[] = [];
  const { events, now } = opts;
  for (const t of tasks) {
    if (t.done) continue;
    if (events && now && futureSessions(events, t, now).length > 0) continue;
    // A Day Planner range on the line means the work already has a slot — whether
    // this app put it there or the Weekfit plugin did. It is the one scheduling
    // signal both tools share, and unlike an event it needs no calendar at all.
    if (isPlaced(t.text)) continue;
    const est = resolveTaskDuration(t.text, durations);
    items.push({
      key: `${t.file}:${t.line}`,
      file: t.file,
      line: t.line,
      text: t.text,
      title: est.title,
      minutes: snapToGrid(est.minutes),
      wanted: taskKind(t.text, names),
      kind: 'fit',
      taskId: parseTaskId(t.text) ?? undefined,
    });
  }
  return placeItems(items, gaps);
}

/** Does `a` beat `b` as a home for a task tagged `wanted`? See `fitTasks`. */
function beatsFor(a: Gap, b: Gap, wanted: string | null): boolean {
  const am = wanted != null && a.window.toLowerCase() === wanted ? 0 : 1;
  const bm = wanted != null && b.window.toLowerCase() === wanted ? 0 : 1;
  if (am !== bm) return am < bm;
  if (a.day !== b.day) return a.day < b.day;
  if (a.startMin !== b.startMin) return a.startMin < b.startMin;
  return a.windowIndex < b.windowIndex;
}

/** The window names a set of gaps covers — needed by `replanFit`, which has to
 *  resolve a task's `#tag` against the same vocabulary `fitTasks` uses. */
export function gapWindowNames(gaps: Gap[]): Record<string, number> {
  return windowNames(gaps);
}

/**
 * Where a drag should land: the nearest gap on `day` big enough to hold
 * `minutes`, and the start inside it closest to where the drop actually
 * happened. Null when nothing on that day fits — the caller then leaves the
 * drop exactly where it was, because refusing it, or flinging it to another
 * day, would both be the board deciding.
 */
export function snapToGap(
  gaps: Gap[],
  day: number,
  startMin: number,
  minutes: number,
  reach = SNAP_REACH_MINUTES,
): { gap: Gap; startMin: number } | null {
  let best: { gap: Gap; startMin: number; dist: number } | null = null;
  for (const g of gaps) {
    if (g.day !== day || g.minutes < minutes) continue;
    const latest = g.endMin - minutes;
    // Snap to the 30-minute lattice, then clamp — a gap's own edge (an event
    // that ended at 09:17) wins over the lattice, since it's a real boundary.
    const lattice = Math.round(startMin / SNAP_MINUTES) * SNAP_MINUTES;
    const at = Math.min(Math.max(lattice, g.startMin), latest);
    const dist = Math.abs(at - startMin);
    if (dist > reach) continue;
    if (
      !best ||
      dist < best.dist ||
      (dist === best.dist &&
        (g.startMin < best.gap.startMin ||
          (g.startMin === best.gap.startMin && g.windowIndex < best.gap.windowIndex)))
    ) {
      best = { gap: g, startMin: at, dist };
    }
  }
  return best ? { gap: best.gap, startMin: best.startMin } : null;
}

/** Does any gap on the board have room for a task of this size? Drives the
 *  "a gap too small doesn't highlight" half of the drag. */
export function gapFits(gap: Gap, minutes: number): boolean {
  return gap.minutes >= minutes;
}

/** What a dragged ghost has landed on top of. */
export interface ProposalConflict {
  /** A recurring `blocks:` slot, or a real event already on the calendar. */
  kind: 'skeleton' | 'event';
  /** The block's name / the event's title — what the ghost says out loud. */
  title: string;
}

/** The minutes of `day` that `ev` covers, or null if it doesn't reach that
 *  column. The same day arithmetic as `busyByDay`, kept apart because this one
 *  has to hand back which event it was. */
function eventSpanOn(weekStart: Date, ev: CalEvent, day: number): Interval | null {
  if (ev.allDay) return null;
  const startDay = dayIndex(ev.start, weekStart);
  const endDay = dayIndex(ev.end, weekStart);
  if (day < startDay || day > endDay) return null;
  const startMin = day === startDay ? minutesOfDay(ev.start) : 0;
  const endMin = day === endDay ? minutesOfDay(ev.end) : DAY_MINUTES;
  return endMin > startMin ? { startMin, endMin } : null;
}

/**
 * What a proposal at `day` `startMin`–`endMin` would sit on top of, or null
 * when the slot is clear. Skeleton blocks are reported ahead of events: a ghost
 * inside Friday's stream is the more surprising of the two, and it is the one
 * that used to reach the calendar unremarked.
 *
 * **Why the drop still stands.** `snapToGap` returning null means nothing on
 * that day has room, and the ghost is then left exactly where it was dropped —
 * refusing the drag, or flinging it to another day, would both be the board
 * deciding. But accepting from there writes a real event inside a skeleton
 * block with nothing anywhere saying so. So the drop is kept and the clash is
 * *shown* — named on the ghost and in its tooltip — until Tyler moves it or
 * accepts it on purpose. Suggest, never move, in both directions.
 */
export function proposalConflict(
  weekStart: Date,
  day: number,
  startMin: number,
  endMin: number,
  skeleton: SkeletonBlock[],
  events: CalEvent[],
): ProposalConflict | null {
  const hits = (a: number, b: number) => startMin < b && endMin > a;

  for (const b of skeleton) {
    if (!b.days.includes(day)) continue;
    if (hits(b.startMin, b.endMin)) return { kind: 'skeleton', title: b.name };
  }
  for (const ev of events) {
    const span = eventSpanOn(weekStart, ev, day);
    if (span && hits(span.startMin, span.endMin)) {
      return { kind: 'event', title: ev.title };
    }
  }
  return null;
}

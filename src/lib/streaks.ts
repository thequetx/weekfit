import type { CalEvent, SkeletonBlock } from './types';
import { addDays, dayIndex } from './week';

export interface Streak {
  kind: string;
  label: string;
  done: number;
  target: number;
}

/**
 * How far a real event may sit from the slot it is supposed to be keeping and
 * still count as having kept it. Ninety minutes: a gym session pushed to 07:30
 * is still that morning's gym, one at 09:00 is a different thing.
 *
 * **This is the project's only planned-slot matcher.** `computeStreaks` and
 * `lib/audit.ts` both go through `matchSlot` below rather than each carrying
 * their own idea of "near enough" — two matchers that disagreed would make
 * `GYM 3/5` and `gym 5h planned / 3h kept` tell different stories about the
 * same week.
 */
export const NEAR_MS = 90 * 60 * 1000;

export function titleize(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** One planned occurrence of a skeleton block: which column of the week, and
 *  where in the day it sits. */
export interface PlannedSlot {
  day: number; // 0 = Monday ... 6 = Sunday
  startMin: number;
  endMin: number;
}

/** The instant `minute` falls on, on day `day` of the rendered week. Built from
 *  calendar fields (`addDays` + `setHours`), never millisecond arithmetic, so
 *  Sydney's 23- and 25-hour Sundays don't slide a slot into the wrong hour. */
export function slotInstant(weekStart: Date, day: number, minute: number): Date {
  const d = addDays(weekStart, day);
  d.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return d;
}

export interface MatchOptions {
  /**
   * Refuse blocks this app placed itself (an accepted proposal — anything
   * carrying a `taskId`) as evidence for a slot.
   *
   * **Only the audit wants this.** `lib/audit.ts` counts accepted blocks as
   * planned time of their own, so letting a deep-work session at 06:15 also
   * stand in as evidence of the gym would count the same hour on both sides of
   * the retrospective. Streaks have no such second column: a gym session that
   * happened is a gym session that happened, and `Gym 4/5` because one of the
   * five was booked through the Planner is just a wrong number.
   */
  skipAppBlocks?: boolean;
}

/** Milliseconds between `slot` and `e`'s start, or null when `e` can't be a
 *  candidate for it at all. The one place the candidacy rule is written. */
function slotDistance(
  weekStart: Date,
  slot: { day: number; startMin: number },
  e: CalEvent,
  opts: MatchOptions,
): number | null {
  if (e.allDay) return null;
  if (opts.skipAppBlocks && e.taskId) return null;
  if (dayIndex(e.start, weekStart) !== slot.day) return null;
  const at = slotInstant(weekStart, slot.day, slot.startMin).getTime();
  const dist = Math.abs(e.start.getTime() - at);
  return dist > NEAR_MS ? null : dist;
}

/**
 * **The matcher.** The real calendar event that kept `slot`, or null.
 *
 * A candidate must be on the same day column, not all-day, and start within
 * `NEAR_MS` of the slot. Ties go to the closest start, then to the lower uid,
 * so the answer never depends on the order the calendar happened to arrive in.
 *
 * This asks about **one** slot in isolation, which is all a streak needs. When
 * a whole set of slots is being scored at once — the audit, adding up hours —
 * use `claimSlots` instead: two adjacent slots asked separately will both
 * happily claim the same event.
 */
export function matchSlot(
  weekStart: Date,
  slot: { day: number; startMin: number },
  events: CalEvent[],
  opts: MatchOptions = {},
): CalEvent | null {
  let best: CalEvent | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const e of events) {
    const dist = slotDistance(weekStart, slot, e, opts);
    if (dist == null) continue;
    if (dist < bestDist || (dist === bestDist && best !== null && e.uid < best.uid)) {
      best = e;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * `matchSlot` over a whole set of slots, with **one event claimable by at most
 * one slot** — returned parallel to `slots`, null where nothing kept it.
 *
 * Why this exists: `NEAR_MS` is ninety minutes and the shipped skeleton has
 * `Grocery Run` sun 14:00–15:00 sixty minutes ahead of `Meal Prep` sun
 * 15:00–17:00. One real "Groceries + batch cook" event 14:00–17:00 is within
 * reach of both, and asking each slot on its own reports its three hours twice
 * — 180 real minutes read as 360 kept, in a number that Phase 5 persists into
 * frontmatter for a 52-week history table.
 *
 * **Nearest slot wins.** Every (slot, event) pair inside `NEAR_MS` is taken in
 * order of distance and assigned greedily, so the event goes to the slot it
 * actually looks like it kept — the grocery run above, which it starts exactly
 * on. Ties break on the lower uid and then on the slot's position in the list,
 * the same stable order `matchSlot` uses, so the answer never depends on the
 * order the calendar arrived in.
 */
export function claimSlots(
  weekStart: Date,
  slots: { day: number; startMin: number }[],
  events: CalEvent[],
  opts: MatchOptions = {},
): (CalEvent | null)[] {
  const pairs: { slot: number; event: number; dist: number; uid: string }[] = [];
  slots.forEach((slot, si) => {
    events.forEach((e, ei) => {
      const dist = slotDistance(weekStart, slot, e, opts);
      if (dist == null) return;
      pairs.push({ slot: si, event: ei, dist, uid: e.uid });
    });
  });
  pairs.sort(
    (a, b) =>
      a.dist - b.dist ||
      (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0) ||
      a.slot - b.slot,
  );

  const out: (CalEvent | null)[] = slots.map(() => null);
  const claimed = new Set<number>();
  for (const p of pairs) {
    if (out[p.slot] || claimed.has(p.event)) continue;
    out[p.slot] = events[p.event];
    claimed.add(p.event);
  }
  return out;
}

/** Every slot a skeleton puts in the rendered week, in the order the blocks are
 *  written. Shared with `lib/audit.ts` so "how many gym slots are there this
 *  week" has exactly one answer. */
export function skeletonSlots(skeleton: SkeletonBlock[]): (PlannedSlot & {
  kind: string;
})[] {
  const out: (PlannedSlot & { kind: string })[] = [];
  for (const b of skeleton) {
    for (const day of b.days) {
      if (day < 0 || day > 6) continue;
      out.push({ kind: b.kind, day, startMin: b.startMin, endMin: b.endMin });
    }
  }
  return out;
}

/** Per-kind "N of M" progress: how many of this week's skeleton slots for a
 *  recurring kind have a matching calendar event (see `matchSlot`).
 *
 *  Every real event counts, including one the Planner booked: a streak is a
 *  count of things that happened, and how the block got onto the calendar is
 *  the audit's question, not this one. */
export function computeStreaks(
  weekStart: Date,
  events: CalEvent[],
  skeleton: SkeletonBlock[],
): Streak[] {
  const byKind = new Map<string, PlannedSlot[]>();
  for (const slot of skeletonSlots(skeleton)) {
    const slots = byKind.get(slot.kind) ?? [];
    slots.push(slot);
    byKind.set(slot.kind, slots);
  }

  const streaks: Streak[] = [];
  for (const [kind, slots] of byKind) {
    if (slots.length < 2) continue; // 1-a-week things aren't a streak
    let done = 0;
    for (const slot of slots) {
      if (matchSlot(weekStart, slot, events)) done += 1;
    }
    streaks.push({ kind, label: titleize(kind), done, target: slots.length });
  }
  return streaks.sort((a, b) => b.target - a.target);
}

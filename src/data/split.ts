/**
 * Splitting a block you already placed, on purpose.
 *
 * Fitting splits automatically when a task is too big for any single gap.
 * This is the other case: it *does* fit, but you don't want to do it in one
 * sitting. Press Split on a block, choose how many sittings, and the pieces
 * come back as ghosts — nothing is written until they're accepted, exactly
 * like "Fit this week".
 *
 * Two rules shape the result, both chosen deliberately:
 *
 *  - **The first sitting keeps the slot you gave it**, just shorter. You put
 *    that block at 2pm Wednesday for a reason, and an engine that quietly
 *    relocates it is answering a question you didn't ask.
 *  - **Sittings are equal**, snapped to the grid's lattice. Predictable, needs
 *    no extra input, and any ghost can be dragged before it's accepted anyway.
 */
import { computeGaps, placeItems } from '../lib/gaps';
import type { Gap, PlaceItem, Proposal, Unplaced } from '../lib/gaps';
import { MAX_SESSIONS, MIN_SESSION_MINUTES } from '../lib/gaps';
import { snapToGrid, taskKind } from '../lib/duration';
import { parseTaskMeta } from '../lib/taskmeta';
import type { CalEvent, VaultTask } from '../lib/types';
import type { WeekSnapshot, WeekfitSettings } from './contract';

/** The block being split: where it currently sits, and the line behind it. */
export interface SplitTarget {
  uid: string;
  task: VaultTask;
  day: number;
  startMin: number;
  endMin: number;
}

export interface SplitPlan {
  /** Every sitting, the kept first one included, as ghosts sharing a
   *  `groupKey` — so accepting the group writes them all as children through
   *  the existing multi-session path. */
  proposals: Proposal[];
  /** Sittings the week had no room for. Empty on a plan worth offering. */
  unplaced: Unplaced[];
  sessions: number;
  /** The block these ghosts replace, so the grid can stop drawing it while
   *  the split is pending — a ghost sitting on top of the block it is about
   *  to become reads as two commitments. */
  replacing: string;
}

/** How many sittings a block of `minutes` could be cut into at all. Anything
 *  shorter than two hours cannot become two hour-long sittings, which is why
 *  the Split control does not appear on a short block. */
export function maxSittingsFor(minutes: number): number {
  return Math.max(1, Math.min(MAX_SESSIONS, Math.floor(minutes / MIN_SESSION_MINUTES)));
}

export function canSplit(minutes: number): boolean {
  return maxSittingsFor(minutes) >= 2;
}

/**
 * Gaps as they would be with the block's own footprint shortened to its first
 * sitting — the rest of its old time is free again and the remaining sittings
 * may legitimately land there. Computing gaps against the week as it stands
 * would treat the block's own hours as busy and push every sitting elsewhere.
 */
function gapsWithBlockShortened(
  snapshot: WeekSnapshot,
  settings: WeekfitSettings,
  target: SplitTarget,
  firstEndMin: number,
  now: Date,
): Gap[] {
  const scheduled: CalEvent[] = snapshot.scheduled.map((ev) => {
    if (ev.uid !== target.uid) return ev;
    const end = new Date(ev.start);
    end.setHours(0, 0, 0, 0);
    end.setMinutes(firstEndMin);
    return { ...ev, end };
  });
  return computeGaps(snapshot.weekStart, settings.blocks, scheduled, settings.windows, { now });
}

/**
 * Plan a split into exactly `sessions` sittings, or return `null` if the block
 * is too short for that many.
 */
export function planSplit(
  snapshot: WeekSnapshot,
  settings: WeekfitSettings,
  now: Date,
  target: SplitTarget,
  sessions: number,
): SplitPlan | null {
  const total = target.endMin - target.startMin;
  if (sessions < 2 || sessions > maxSittingsFor(total)) return null;

  const per = Math.max(MIN_SESSION_MINUTES, snapToGrid(Math.floor(total / sessions)));
  const firstEnd = target.startMin + per;

  const gaps = gapsWithBlockShortened(snapshot, settings, target, firstEnd, now);
  const groupKey = `${target.task.file}:${target.task.line}`;
  const title = parseTaskMeta(target.task.text).title;
  const wanted = taskKind(target.task.text, windowNamesOf(gaps));

  // The remaining sittings, placed by the same engine everything else uses.
  const items: PlaceItem[] = [];
  for (let i = 1; i < sessions; i++) {
    items.push({
      key: `${groupKey}#split${i}`,
      file: target.task.file,
      line: target.task.line,
      text: target.task.text,
      title,
      minutes: per,
      wanted,
      kind: 'fit',
    });
  }

  const placed = placeItems(items, gaps);

  // `placeItems` splits an item further when no single gap can hold it, so a
  // request for three sittings can come back as four. Number the group by what
  // actually happened rather than by what was asked for — the ghosts are on
  // screen before anything is written, so "you asked for 3, here are 4" is
  // visible rather than surprising, and a badge reading 2/3 on a set of four
  // would just be wrong.
  const actual = 1 + placed.proposals.length;

  // The kept slot, first in the group, exactly where the user put it.
  const first: Proposal = {
    key: `${groupKey}#split0`,
    groupKey,
    kind: 'fit',
    file: target.task.file,
    line: target.task.line,
    text: target.task.text,
    title,
    minutes: per,
    day: target.day,
    startMin: target.startMin,
    endMin: firstEnd,
    window: 'kept',
    session: 1,
    sessions: actual,
  };

  // Re-key the engine's proposals into one group, numbered after the kept one.
  const rest = placed.proposals.map((p, i) => ({
    ...p,
    key: `${groupKey}#split${i + 1}`,
    groupKey,
    session: i + 2,
    sessions: actual,
  }));

  return {
    proposals: [first, ...rest],
    unplaced: placed.unplaced,
    sessions: actual,
    replacing: target.uid,
  };
}

/**
 * The fewest sittings that actually fit — what the menu's "Fit" option asks
 * for. Tries two first and stops at the first count the week has room for, so
 * the answer is the least disruptive one available rather than the largest.
 */
export function planSplitAuto(
  snapshot: WeekSnapshot,
  settings: WeekfitSettings,
  now: Date,
  target: SplitTarget,
): SplitPlan | null {
  const max = maxSittingsFor(target.endMin - target.startMin);
  let lastTried: SplitPlan | null = null;
  for (let n = 2; n <= max; n++) {
    const plan = planSplit(snapshot, settings, now, target, n);
    if (!plan) continue;
    lastTried = plan;
    if (plan.unplaced.length === 0) return plan;
  }
  // Nothing fitted cleanly — hand back the last attempt so the view can say
  // what wouldn't go, rather than silently doing nothing.
  return lastTried;
}

/** `placeItems` matches a task's `#tag` against the window names present in
 *  the gaps; this is the same vocabulary lookup `fitTasks` does internally. */
function windowNamesOf(gaps: Gap[]): Record<string, number> {
  const names: Record<string, number> = {};
  for (const g of gaps) {
    const key = g.window.toLowerCase();
    if (!(key in names)) names[key] = g.windowIndex;
  }
  return names;
}

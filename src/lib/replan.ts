// Replan undone — Phase 4 §4.
//
// A block whose time has been and gone, on a task that is still unchecked, is
// the plan admitting it didn't happen. The board says so ("3 blocks passed —
// replan?") and offers new gaps for them through §2's engine, with the same
// accept/dismiss flow. It **never** moves anything: exactly as in `lib/gaps.ts`,
// everything here returns objects, and only an explicit click in Planner.tsx
// turns one into a calendar event.
//
// Pure — the clock is handed in (`opts.now`), never read. That's what makes
// "passed" testable at all, and what lets both Sydney DST weeks be pinned in
// test/replan.test.ts.

import { DEFAULT_DURATIONS, parseTaskLine, snapToGrid, taskKind } from './duration';
import { gapWindowNames, placeItems, titleKey } from './gaps';
import type { FitResult, Gap, PlaceItem } from './gaps';
import { parseTaskId } from './taskid';
import type { CalEvent, DurationMap, VaultTask } from './types';
import { dayIndex, minutesOfDay } from './week';

/** A block can't be shorter than the grid's own quantum once it's re-proposed;
 *  a 6-minute leftover isn't hours worth replanning. */
const SNAP_FLOOR = 30;

/**
 * **What "passed" means here.**
 *
 * A block has passed when its **end instant is at or before `now`** — not its
 * start. A block that is running right now hasn't failed; it's the thing Tyler
 * is presumably doing. Only once the whole slot is behind him is there anything
 * to replan, and only then are its hours actually free to spend again.
 *
 * The comparison is on absolute epoch milliseconds (`end.getTime() <=
 * now.getTime()`), never on wall-clock fields. That is the DST-safe form: on
 * Sydney's 23-hour Sunday in October a wall-clock comparison has an hour that
 * doesn't exist, and on the 25-hour Sunday in April it has an hour that happens
 * twice. Instants have neither problem. (Which *column* a block belongs to is
 * still a calendar-field question, so that goes through `dayIndex` — the same
 * split of responsibilities as `busyByDay`.)
 *
 * There is deliberately no grace period. A block that ended a minute ago either
 * happened — tick it — or didn't, and a timer that decides which is a board
 * making the call on Tyler's behalf.
 */
export function hasPassed(end: Date, now: Date): boolean {
  return end.getTime() <= now.getTime();
}

/** A block whose time has gone and whose source task is still unchecked. */
export interface PassedBlock {
  uid: string;
  title: string;
  start: Date;
  end: Date;
  minutes: number;
  /** Column 0..6 in the rendered week. */
  day: number;
  startMin: number;
  /** The vault task this block was for, still open. */
  task: VaultTask;
  /** The task's Obsidian Tasks `🆔`, when it has one. */
  taskId?: string;
  /** How the block was matched back to its task — `id` is exact, `title` is the
   *  fallback for blocks created before the task had an id (a plain drag). */
  matchedBy: 'id' | 'title';
  /** 1-based session index and total, when the block is one sitting of a split
   *  task (Phase 4 §3). */
  session?: number;
  sessions?: number;
}

// `titleKey` and `futureSessions` live in lib/gaps.ts — "which blocks on the
// calendar belong to this task" is a question `fitTasks` has to ask too (it
// must not re-propose work already booked), and gaps.ts can't import this file
// without a cycle. Re-exported here because this is where they read from.
export { futureSessions, titleKey } from './gaps';

export interface PassedOptions {
  /** The caller's clock. Required — this is the whole question. */
  now: Date;
}

/**
 * Blocks in the rendered week that have passed with their task still open.
 *
 * Matching an event back to a task goes id-first, title-second:
 *   1. `extendedProperties.private.wdTaskId` on the event equals the task's
 *      `🆔` — exact, and what every block this app accepts carries.
 *   2. the event's title equals the task's display title. This is the fallback
 *      for a block made by dragging a task onto the grid before §3 existed, or
 *      one typed by hand to match. Without it, replanning would only ever see
 *      the blocks the app itself created, which is the smaller half of the week.
 *
 * All-day events are never candidates: a whole-day entry is leave or a trip,
 * not a work block that slipped.
 */
export function passedBlocks(
  weekStart: Date,
  events: CalEvent[],
  tasks: VaultTask[],
  opts: PassedOptions,
): PassedBlock[] {
  const open = tasks.filter((t) => !t.done);
  if (!open.length) return [];

  const byId = new Map<string, VaultTask>();
  const byTitle = new Map<string, VaultTask>();
  for (const t of open) {
    const id = parseTaskId(t.text);
    // First writer wins in both maps, so a duplicated title resolves to the
    // earliest line rather than depending on iteration order.
    if (id && !byId.has(id)) byId.set(id, t);
    const key = titleKey(t.text);
    if (key && !byTitle.has(key)) byTitle.set(key, t);
  }

  const out: PassedBlock[] = [];
  for (const ev of events) {
    if (ev.allDay) continue;
    const day = dayIndex(ev.start, weekStart);
    if (day < 0 || day > 6) continue;
    if (!hasPassed(ev.end, opts.now)) continue;

    let task: VaultTask | undefined;
    let matchedBy: 'id' | 'title' = 'id';
    if (ev.taskId) task = byId.get(ev.taskId);
    if (!task) {
      task = byTitle.get(titleKey(ev.title));
      matchedBy = 'title';
    }
    if (!task) continue;

    const minutes = Math.max(
      SNAP_FLOOR,
      Math.round((ev.end.getTime() - ev.start.getTime()) / 60000),
    );
    out.push({
      uid: ev.uid,
      title: ev.title,
      start: ev.start,
      end: ev.end,
      minutes,
      day,
      startMin: minutesOfDay(ev.start),
      task,
      taskId: ev.taskId ?? parseTaskId(task.text) ?? undefined,
      matchedBy,
      session: ev.session,
      sessions: ev.sessions,
    });
  }

  // Chronological — the oldest slip is the one that has been waiting longest,
  // and it reads as a list of what went wrong in order.
  out.sort((a, b) => a.start.getTime() - b.start.getTime() || (a.uid < b.uid ? -1 : 1));
  return out;
}

/**
 * Propose new homes for passed blocks, through §2's engine and §3's splitting.
 *
 * The hours re-proposed are the **block's** hours, not the task's estimate: the
 * question is "where does *this* slot go now", and a task whose estimate has
 * since changed shouldn't have the difference smuggled into a replan.
 *
 * Two blocks of the same task collapse to one proposal for their combined
 * hours — a task that slipped twice on Monday wants two hours back, not two
 * separate arguments about the same job. The combined hours then go through the
 * ordinary split rule, so they can land on different days.
 *
 * `gaps` should be the current week's gaps computed with the same `now`, which
 * `computeGaps` already trims to — so nothing here can propose a slot in the
 * past.
 */
export function replanFit(
  passed: PassedBlock[],
  gaps: Gap[],
  durations: DurationMap = DEFAULT_DURATIONS,
): FitResult {
  const names = gapWindowNames(gaps);
  const items = new Map<string, PlaceItem>();

  for (const p of passed) {
    const key = `replan:${p.task.file}:${p.task.line}`;
    const existing = items.get(key);
    if (existing) {
      existing.minutes += snapToGrid(p.minutes);
      continue;
    }
    items.set(key, {
      key,
      file: p.task.file,
      line: p.task.line,
      text: p.task.text,
      title: parseTaskLine(p.task.text).title,
      minutes: snapToGrid(p.minutes),
      wanted: taskKind(p.task.text, names),
      kind: 'replan',
      taskId: p.taskId,
      sourceUid: p.uid,
    });
  }

  return placeItems([...items.values()], gaps);
}

/**
 * Phase 4 §3's last clause — "deleting one session **offers** to re-fit its
 * hours elsewhere". This builds the offer; nothing is written until it's taken.
 *
 * The hours are the deleted block's, not the task's estimate: what was freed is
 * what's being re-placed.
 */
export function refitFreed(task: VaultTask, minutes: number, gaps: Gap[]): FitResult {
  const names = gapWindowNames(gaps);
  return placeItems(
    [
      {
        key: `replan:${task.file}:${task.line}`,
        file: task.file,
        line: task.line,
        text: task.text,
        title: parseTaskLine(task.text).title,
        minutes: snapToGrid(minutes),
        wanted: taskKind(task.text, names),
        kind: 'replan',
        taskId: parseTaskId(task.text) ?? undefined,
      },
    ],
    gaps,
  );
}

/** Rail label — "3 blocks passed — replan?". Singular when it's one, because
 *  "1 blocks" is the kind of thing that makes a board feel unattended. */
export function passedLabel(n: number): string {
  return `${n} block${n === 1 ? '' : 's'} passed — replan?`;
}

/**
 * §3's "you ticked this — remove the rest?" offer, refreshed against the
 * calendar as it stands now: the same offer with its uids re-read, or null once
 * nothing is left to remove.
 *
 * The rail keeps this offer in state across vault pushes, and the events behind
 * it can go in the meantime — deleted in Google, or by an earlier click on this
 * very button. Acting on the stale set 404s and surfaces as "Could not delete
 * the event", which reads like the app is broken rather than like the offer
 * expired.
 */
export function refreshSessionOffer<T extends { uids: string[] }>(
  offer: T | null,
  live: CalEvent[],
): T | null {
  if (!offer) return null;
  const uids = live.map((e) => e.uid);
  return uids.length ? { ...offer, uids } : null;
}

/** Every block on the calendar belonging to one task — the group that a linked
 *  block's "delete all N" acts on. */
export function sessionGroup(events: CalEvent[], ev: CalEvent): CalEvent[] {
  if (!ev.taskId) return [ev];
  return events.filter((e) => e.taskId === ev.taskId);
}

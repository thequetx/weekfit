import { parseTaskMeta, priorityRank, type TaskMeta } from '../lib/taskmeta';
import type { VaultTask } from '../lib/types';

/**
 * What order tasks get to pick a slot in.
 *
 * Both placement strategies consume their input array in order and take the
 * best remaining gap for each task as they go — so whatever is first in the
 * list gets first pick of the week. Until this existed that order was
 * *whatever order the lines happened to sit in the note*, which meant a task
 * due Thursday could lose Thursday's only free morning to the task written
 * above it and land on Friday, a day after it was due, with Thursday still
 * empty. A planner that schedules work past its own deadline while the
 * deadline day sits free is failing at the one job it has.
 *
 * `lib/taskmeta.ts` already ships a `compareMeta`, and this is deliberately
 * **not** it: that one is priority-then-due, which is the right order for
 * *reading* a list — the rail shows you what matters most. Choosing a slot is
 * a different question. A deadline is a constraint and a priority is a
 * preference, so something low-priority due tomorrow has to beat something
 * high-priority due next month. Reversing the two keys is the whole idea.
 */

/** Due date first (soonest, undated last), then priority. 0 on a real tie. */
export function compareForFit(a: TaskMeta, b: TaskMeta): number {
  const ad = a.dates.due?.date ?? null;
  const bd = b.dates.due?.date ?? null;
  // ISO dates, so string order is date order. An overdue task carries a date
  // earlier than everything else and leads, which is what you want.
  if (ad && bd && ad !== bd) return ad < bd ? -1 : 1;
  // A date is a commitment; its absence is not "due in the year 3000", but it
  // does mean nothing is lost by scheduling it around the things that are.
  if (ad && !bd) return -1;
  if (bd && !ad) return 1;
  return priorityRank(a) - priorityRank(b);
}

/**
 * Anything with a task line behind it, ordered for placement. Never mutates
 * the caller's array.
 *
 * Generic because "replan passed" chooses slots too, from `PassedBlock`s that
 * carry their own `VaultTask` — a deadline that mattered when the work was
 * first planned still matters when it's being re-planned, and the two paths
 * disagreeing would be its own bug.
 *
 * Meta is parsed once per item rather than inside the comparator, which would
 * re-parse the same line O(n log n) times. `sort` is stable, so items that tie
 * on both keys keep the order they had in the note — the author's own
 * sequencing is the last word, not an arbitrary one.
 */
export function orderByFit<T>(items: T[], lineOf: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, meta: parseTaskMeta(lineOf(item)) }))
    .sort((a, b) => compareForFit(a.meta, b.meta) || a.index - b.index)
    .map((entry) => entry.item);
}

/** `orderByFit` for a plain task list — the "Fit this week" path. */
export function orderForFit(tasks: VaultTask[]): VaultTask[] {
  return orderByFit(tasks, (t) => t.text);
}

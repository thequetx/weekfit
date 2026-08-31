// Fit orchestration — Phase 2A. A thin seam over `src/lib/`'s already-tested
// engine: nothing here reimplements scheduling, it only assembles the engine's
// inputs from a `WeekSnapshot` and hands back the shape the view wants.
//
// Pure: no Obsidian, no IPC, no clock read internally — `now` is a parameter,
// exactly like every `lib/` function it calls.

import { computeGaps, fitTasks, freeMinutes, futureSessions } from '../lib/gaps';
import type { PlaceItem } from '../lib/gaps';
import { placeSpread } from './spread';
import { resolveTaskDuration, taskKind } from '../lib/duration';
import { parseTaskId } from '../lib/taskid';
import type { Proposal } from '../lib/gaps';
import { committedMinutes, snapToGrid } from '../lib/duration';
import { passedBlocks, replanFit } from '../lib/replan';
import { gapWindowNames } from '../lib/gaps';
import type { Gap } from '../lib/gaps';
import type { CalEvent } from '../lib/types';
import { isRailTask } from './sessions';
import { orderByFit, orderForFit } from './fitorder';
import type { VaultTask } from '../lib/types';
import type { Capacity, FitState, WeekfitSettings, WeekSnapshot } from './contract';

/**
 * Everything unscheduled: `snapshot.tasks` plus `snapshot.thisweek`, minus
 * done, minus anything already carrying a Day Planner range. **Same rule the
 * rail (`IntentionsRail.tsx`) uses** — deliberately not reinvented here, so
 * the rail's list and the fit engine's input never quietly diverge.
 */
function unscheduledTasks(snapshot: WeekSnapshot): VaultTask[] {
  return [...snapshot.tasks, ...snapshot.thisweek].filter((t) =>
    isRailTask(t, snapshot.scheduledLines),
  );
}

/**
 * "Fit this week": gaps, proposed placements, and the capacity line — all
 * ghosts, nothing written. `computeFit` is called fresh every time the button
 * is pressed; it never caches anything across calls.
 */
export function computeFit(
  snapshot: WeekSnapshot,
  settings: WeekfitSettings,
  now: Date,
): FitState {
  const gaps = computeGaps(
    snapshot.weekStart,
    settings.blocks,
    snapshot.scheduled,
    settings.windows,
    { now },
  );

  // Ordered before either strategy sees it: both take the best remaining gap
  // for each task in turn, so this list *is* the priority order. Sorting the
  // input rather than the engine keeps `lib/` untouched.
  const unscheduled = orderForFit(unscheduledTasks(snapshot));

  const { proposals, unplaced } =
    settings.fitStrategy === 'earliest'
      ? fitTasks(unscheduled, gaps, settings.durations, { events: snapshot.scheduled, now })
      : placeSpread(
          buildItems(unscheduled, gaps, settings.durations, snapshot.scheduled, now),
          gaps,
        );

  const committedMin = committedMinutes(unscheduled, settings.durations);
  const freeMin = freeMinutes(settings.windows, gaps);
  // `freeMin === null` means no window is configured at all — "no opinion",
  // not "zero free". Falling back to `committedMin` here makes the
  // subtraction zero out rather than blaming the whole committed total on a
  // week with no time map at all.
  const overBy = Math.max(0, committedMin - (freeMin ?? committedMin));

  const capacity: Capacity = { committedMin, freeMin, overBy };

  return { gaps, proposals, unplaced, capacity };
}

/**
 * Phase 4 §4 — "the feature that makes it useful on Wednesday, not just
 * Sunday." A block whose time has passed with its task still open gets
 * offered a new slot, through the same gap engine and the same splitting
 * rule `computeFit` uses — so the view can render replan ghosts with exactly
 * the machinery it already has for fit ghosts (`FitState`, `proposalGroups`,
 * `GhostBlock`).
 *
 * **Matched against `snapshot.scheduledLines`, not `snapshot.tasks` /
 * `thisweek`.** A scheduled block in this plugin *is* a vault line —
 * `scheduled[i]` and `scheduledLines[i]` are the same line, kept in lockstep
 * by `VaultRepo.readWeek` — so the line behind a passed block already carries
 * its own done-state directly. `passedBlocks` (ported from week-dashboard,
 * where a block was a separate Google event) falls back to matching by
 * *title* whenever no `🆔` is present, which this plugin's Day Planner lines
 * never carry — so handing over the exact 1:1 population removes the one
 * source of ambiguity that lookup has: a same-titled sibling session
 * resolving to the wrong line's done-state. It cannot remove the other one —
 * see the caveat on `sessionGroup`-shaped collisions in the write path.
 */
export function computeReplan(
  snapshot: WeekSnapshot,
  settings: WeekfitSettings,
  now: Date,
): FitState {
  const gaps = computeGaps(
    snapshot.weekStart,
    settings.blocks,
    snapshot.scheduled,
    settings.windows,
    { now },
  );

  // `passedBlocks` matches an event back to its task by title (or by `🆔`,
  // which nothing in this Obsidian-only port ever stamps), and here the event
  // is *derived from* the task line: `scheduledEvents` strips the
  // `HH:MM - HH:MM` to make the title, while `parseTaskMeta` deliberately
  // leaves the range in place, since it is not one of the Tasks standard's
  // fields. The two sides are reconciled inside `titleKey` (lib/gaps.ts),
  // which strips a leading range before comparing — so the real lines go in
  // as they are, and the proposals come back carrying the exact text the
  // writer will verify against.
  const passed = passedBlocks(
    snapshot.weekStart,
    snapshot.scheduled,
    snapshot.scheduledLines,
    { now },
  );

  // Same deadline-first order as "Fit this week" — `replanFit` places from an
  // insertion-ordered Map, so this list is its priority order too. A due date
  // that mattered when the work was first planned still matters now.
  const { proposals, unplaced } = replanFit(
    orderByFit(passed, (b) => b.task.text),
    gaps,
    settings.durations,
  );

  // The hours actually being re-proposed — each passed session's own
  // duration, snapped the same way `replanFit` snaps it internally, so this
  // total agrees with what the engine actually tried to place regardless of
  // how many tasks those sessions collapsed into.
  const committedMin = passed.reduce((sum, p) => sum + snapToGrid(p.minutes), 0);
  const freeMin = freeMinutes(settings.windows, gaps);
  const overBy = Math.max(0, committedMin - (freeMin ?? committedMin));

  const capacity: Capacity = { committedMin, freeMin, overBy };

  return { gaps, proposals, unplaced, capacity };
}

/**
 * Proposals keyed by `groupKey` — the handle both accept-one and accept-all
 * work on, and what tells the rail "this task has N/M sessions" as one unit
 * rather than N separate ghosts.
 */
export function proposalGroups(proposals: Proposal[]): Map<string, Proposal[]> {
  const map = new Map<string, Proposal[]>();
  for (const p of proposals) {
    const list = map.get(p.groupKey);
    if (list) list.push(p);
    else map.set(p.groupKey, [p]);
  }
  return map;
}

/**
 * The same `PlaceItem` construction `fitTasks` does internally, lifted out so
 * the spread pass can feed the engine identical input. Deliberately a mirror
 * rather than a variation: if the two ever disagree about what a task's size,
 * window or id is, the two strategies stop being comparable.
 */
function buildItems(
  tasks: VaultTask[],
  gaps: Gap[],
  durations: WeekfitSettings['durations'],
  events: CalEvent[],
  now: Date,
): PlaceItem[] {
  const names = gapWindowNames(gaps);
  const items: PlaceItem[] = [];
  for (const t of tasks) {
    if (t.done) continue;
    // Already booked later in the week — leave it alone, same as `fitTasks`.
    if (futureSessions(events, t, now).length > 0) continue;
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
  return items;
}

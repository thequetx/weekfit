// Fit orchestration — Phase 2A. A thin seam over `src/lib/`'s already-tested
// engine: nothing here reimplements scheduling, it only assembles the engine's
// inputs from a `WeekSnapshot` and hands back the shape the view wants.
//
// Pure: no Obsidian, no IPC, no clock read internally — `now` is a parameter,
// exactly like every `lib/` function it calls.

import { computeGaps, fitTasks, freeMinutes } from '../lib/gaps';
import type { Proposal } from '../lib/gaps';
import { committedMinutes, snapToGrid } from '../lib/duration';
import { passedBlocks, replanFit } from '../lib/replan';
import { applyPlacement, hasPlacement } from './dayplanner';
import type { VaultTask } from '../lib/types';
import type { Capacity, FitState, WeekfitSettings, WeekSnapshot } from './contract';

/**
 * Everything unscheduled: `snapshot.tasks` plus `snapshot.thisweek`, minus
 * done, minus anything already carrying a Day Planner range. **Same rule the
 * rail (`IntentionsRail.tsx`) uses** — deliberately not reinvented here, so
 * the rail's list and the fit engine's input never quietly diverge.
 */
function unscheduledTasks(snapshot: WeekSnapshot): VaultTask[] {
  return [...snapshot.tasks, ...snapshot.thisweek].filter(
    (t) => !t.done && !hasPlacement(t.text),
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

  const unscheduled = unscheduledTasks(snapshot);

  const { proposals, unplaced } = fitTasks(unscheduled, gaps, settings.durations, {
    events: snapshot.scheduled,
    now,
  });

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
  // which nothing in this Obsidian-only port ever stamps). In the desktop app
  // those titles agreed: the event lived in Google with a clean summary while
  // the task line carried no range. Here the event is *derived from* the task
  // line — `scheduledEvents` strips the `HH:MM - HH:MM` to make the title,
  // while `parseTaskMeta` deliberately leaves the range in place (it is not
  // one of the Tasks standard's fields). So `- [ ] 09:00 - 10:00 Fix badge
  // alpha` has the display title `09:00 - 10:00 Fix badge alpha`, never
  // matches the event's `Fix badge alpha`, and replan silently found nothing
  // at all.
  //
  // Match on the line with its range stripped, then put the real text back:
  // the writer refuses any edit whose expected text does not match the file
  // byte-for-byte, so a proposal carrying the de-ranged line would be refused
  // as `line-changed` on every accept.
  const matchable = snapshot.scheduledLines.map((t) => ({
    ...t,
    text: applyPlacement(t.text, { range: null, scheduledDate: null }),
  }));

  const passed = passedBlocks(snapshot.weekStart, snapshot.scheduled, matchable, { now });

  const { proposals: raw, unplaced } = replanFit(passed, gaps, settings.durations);

  const realText = new Map(snapshot.scheduledLines.map((t) => [`${t.file}:${t.line}`, t.text]));
  const proposals = raw.map((p) => {
    const actual = realText.get(`${p.file}:${p.line}`);
    return actual == null ? p : { ...p, text: actual };
  });

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

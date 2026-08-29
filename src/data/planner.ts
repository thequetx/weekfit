// Fit orchestration — Phase 2A. A thin seam over `src/lib/`'s already-tested
// engine: nothing here reimplements scheduling, it only assembles the engine's
// inputs from a `WeekSnapshot` and hands back the shape the view wants.
//
// Pure: no Obsidian, no IPC, no clock read internally — `now` is a parameter,
// exactly like every `lib/` function it calls.

import { computeGaps, fitTasks, freeMinutes } from '../lib/gaps';
import type { Proposal } from '../lib/gaps';
import { committedMinutes } from '../lib/duration';
import { hasPlacement } from './dayplanner';
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

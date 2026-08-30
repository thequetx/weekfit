// The backlog: unscheduled work, sized and sorted the same way the rail
// already does it, but drawn from wherever the plugin's caller decides to
// point it (Phase — this round — the configured task-sweep folders, not just
// the current week's `## Tasks`) rather than one week's snapshot.
//
// Pure, no Obsidian import, same discipline `lib/` holds itself to — this
// file is the seam `BacklogRoot.tsx` renders and `BacklogView.tsx` mounts,
// and it has to be testable without a vault.

import type { DurationMap, VaultTask } from '../lib/types';
import type { WeekfitSettings } from './contract';
import { hasPlacement } from './dayplanner';
import { isUnscheduled } from './sessions';
import { compareMeta, parseTaskMeta } from '../lib/taskmeta';
import type { TaskMeta } from '../lib/taskmeta';
import { resolveTaskDuration } from '../lib/duration';
import type { TaskDuration } from '../lib/duration';

export interface BacklogItem {
  task: VaultTask;
  meta: TaskMeta;
  est: TaskDuration;
}

/**
 * "Backlog" = not done, and not already carrying a Day Planner range — the
 * same definition `IntentionsRail` uses for "unscheduled", because a task
 * already placed on the grid doesn't also need a seat here asking to be
 * placed.
 *
 * **Never call `DAY_PLANNER_RE.test()` on `task.text` directly** — it's the
 * whole raw line (checkbox prefix included), and that regex is `^`-anchored
 * against a line's *body*. `hasPlacement` (`src/data/dayplanner.ts`) already
 * strips the prefix before asking; getting this wrong shipped a real bug once
 * (a task the grid had already scheduled kept reappearing in the rail), which
 * is exactly why this file goes through `hasPlacement` and nowhere near the
 * raw regex itself.
 *
 * Sized by the same duration ladder the rail and the gap engine use
 * (`resolveTaskDuration`, rung: explicit estimate on the line, then a
 * `#tag` default from `settings.durations.byKind`, then the global
 * fallback), and sorted the same way the rail sorts — most urgent priority
 * first, then soonest due date (`compareMeta`).
 */
export function collectBacklog(
  tasks: VaultTask[],
  settings: WeekfitSettings,
  /** The week's scheduled lines, so a task split across sittings — which by
   *  design carries no time on its own line — is not listed as backlog. The
   *  backlog can be swept from folders the current week knows nothing about,
   *  so this is optional and defaults to "no sittings known". */
  scheduledLines: VaultTask[] = [],
): BacklogItem[] {
  return tasks
    .filter((t) => isUnscheduled(t, scheduledLines, hasPlacement))
    .map((t) => ({
      task: t,
      meta: parseTaskMeta(t.text),
      est: resolveTaskDuration(t.text, settings.durations as DurationMap),
    }))
    .sort((a, b) => compareMeta(a.meta, b.meta));
}

// ---------------------------------------------------------------------------
// buildCaptureLine — the capture modal's one piece of text logic
// ---------------------------------------------------------------------------

/** A line that already looks like an open checkbox item — deliberately the
 *  narrow, literal shape ("- [ ] ", unchecked, one space each side of the
 *  box) rather than anything more permissive: this only exists to stop a
 *  double prefix, not to normalise whatever the user typed. */
const OPEN_CHECKBOX_PREFIX = '- [ ] ';

/**
 * Turn what the user typed into `CaptureModal` into the line that gets
 * appended under `## Tasks` — or `null` for "write nothing".
 *
 * Kept here, in this round's one pure/no-Obsidian module, rather than inside
 * `CaptureModal.ts` itself, so it stays testable without an Obsidian runtime
 * (the `obsidian` package ships no runtime build at all — every test that
 * needs the real `Modal`/`Setting`/`Notice` classes has to `vi.mock` them
 * first, and this logic has nothing to do with any of the three).
 *
 * Deliberately does none of what natural-language capture parsing would:
 * no date guess, no duration guess, no metadata added. The text is written
 * exactly as typed, `- [ ] ` in front and nothing else — that parsing is a
 * separate, later feature, and a half version of it here would be the wrong
 * thing in the wrong place.
 *
 * - Trailing whitespace is trimmed; leading whitespace is left alone (typed
 *   is typed).
 * - A submission that's empty once trimmed writes nothing (`null`) — a
 *   silent no-op, same as pressing Escape.
 * - A line that already starts with the literal `- [ ] ` isn't prefixed
 *   again.
 */
export function buildCaptureLine(raw: string): string | null {
  const trimmed = String(raw ?? '').replace(/\s+$/, '');
  if (trimmed === '') return null;
  return trimmed.startsWith(OPEN_CHECKBOX_PREFIX) ? trimmed : `${OPEN_CHECKBOX_PREFIX}${trimmed}`;
}

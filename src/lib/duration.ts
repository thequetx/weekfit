// How long a task takes — Phase 4 §1, "a ladder, not a field".
//
// Obsidian Tasks will never have a duration field (issue #2502 and #1649 both
// closed "not planned"), so there is no standard to defer to and whatever is
// chosen here is bespoke by necessity. Three rungs, cheapest first:
//
//   A  default by kind    `durations:` in week-skeleton.yaml, keyed off the
//                         `#tag`s already written on task lines, global
//                         fallback 60m (the behaviour before Phase 4)
//   B  `~90m` / `~1.5h`   one regex, stripped from the display title
//   C  `[est:: 90m]`      the Dataview inline-field flavour
//
// Precedence, top wins:   B or C  >  A  >  60m
//
// Everything here is pure — no DOM, no IPC — because Phase 4 §2's `lib/gaps.ts`
// has to call it and Phase 3 §3 wants that testable.
//
// Phase 5 §1 moved rungs B and C's *reading* into `lib/taskmeta.ts`, the one
// parser for a task line: it strips the Tasks standard's fields and `wd:est` in
// a single pass, so two strippers can't fight over the same title. What stays
// here is the ladder — which rung wins, what a task costs when none of them
// fire, and how the answer is worded on screen.

import type { DurationMap, VaultTask } from './types';
import { EST_FIELD, parseTaskMeta } from './taskmeta';
import type { EstimateField, EstimateFlavour } from './taskmeta';

// Phase 5 §1 folded rungs B and C into `lib/taskmeta.ts`, so one parser reads
// the whole line — the Obsidian Tasks standard's fields *and* ours — in a
// single pass rather than two that fight over the same title. These re-exports
// keep every existing import site working, and keep `wd:est` documented next to
// the ladder that consumes it.
export {
  EST_FIELD,
  MAX_ESTIMATE_MINUTES,
  MIN_ESTIMATE_MINUTES,
  parseDurationValue,
} from './taskmeta';
export type { EstimateField, EstimateFlavour } from './taskmeta';

/** Global fallback when nothing else says how long a task takes — exactly
 *  today's behaviour, so a plain `- [ ] Book dentist` still gets a size. */
export const FALLBACK_MINUTES = 60;

/** Grid quantum — a dropped task becomes a block snapped to this. */
export const SNAP_MINUTES = 30;

/** The old fixed-hour drop, kept as the `Shift` escape hatch in WeekGrid. */
export const FIXED_DROP_MINUTES = 60;

/** Drag payload carrying the resolved estimate from the rail to the grid,
 *  alongside the plain-text title. (`application/x-wd-event` is the sibling
 *  mime for moving an existing event.) */
export const EST_MIME = 'application/x-wd-est';

/** `#content`, `#work/admin`, `#meal-prep`. */
const TAG_RE = /(?:^|\s)#([A-Za-z0-9_\-/]+)/g;

export interface ParsedTask {
  /** Display title — every parsed field is stripped, a malformed one is left
   *  in place so the typo stays visible. */
  title: string;
  /** Namespaced field map. `wd:est` is the only key here; the standard's own
   *  fields ride on `parseTaskMeta`'s result, which this wraps. */
  fields: { 'wd:est'?: EstimateField };
}

export type DurationSource = 'override' | 'kind' | 'default';

export interface TaskDuration {
  title: string;
  minutes: number;
  source: DurationSource;
  /** The tag that matched a `durations:` key, when `source === 'kind'`. */
  kind?: string;
  /** Which override syntax won, when `source === 'override'`. */
  flavour?: EstimateFlavour;
}

/** Neutral map — the fallback and nothing else. */
export const DEFAULT_DURATIONS: DurationMap = {
  defaultMinutes: FALLBACK_MINUTES,
  byKind: {},
};

/**
 * Read the per-task override off a task line (rungs B and C), whichever
 * flavour the rest of the line uses. When both are present the named inline
 * field wins — it's the more deliberate of the two.
 *
 * A thin wrapper over `parseTaskMeta` since Phase 5 §1: the title it returns
 * now has the Tasks standard's fields stripped as well as the estimate, which
 * is exactly what the rail, the ghost block and the Google event summary all
 * wanted. `fields` stays `wd:est`-only — the rest of the line's metadata is on
 * `parseTaskMeta`'s richer result, for the callers that need it.
 */
export function parseTaskLine(text: string): ParsedTask {
  const meta = parseTaskMeta(text);
  return { title: meta.title, fields: meta.fields };
}

/**
 * Rung A: the first `#tag` on the line that names a `durations:` key. Nested
 * tags fall back to their last segment, so `#work/admin` finds `admin`.
 */
export function taskKind(text: string, byKind: Record<string, number>): string | null {
  for (const m of String(text ?? '').matchAll(TAG_RE)) {
    const tag = m[1].toLowerCase();
    if (tag in byKind) return tag;
    const leaf = tag.split('/').pop() ?? '';
    if (leaf && leaf in byKind) return leaf;
  }
  return null;
}

/**
 * The whole ladder in one call: per-task override (B or C) beats the kind
 * default (A) beats the 60m fallback. Always returns a size — that's the point
 * of rung A, and what unblocks Phase 4 §2.
 */
export function resolveTaskDuration(
  text: string,
  durations: DurationMap = DEFAULT_DURATIONS,
): TaskDuration {
  const parsed = parseTaskLine(text);
  const est = parsed.fields[EST_FIELD];
  if (est) {
    return {
      title: parsed.title,
      minutes: est.minutes,
      source: 'override',
      flavour: est.flavour,
    };
  }

  const byKind = durations.byKind ?? {};
  // Kind is read off the original line: an estimate never sits inside a tag,
  // and this keeps the lookup independent of the stripping above.
  const kind = taskKind(text, byKind);
  if (kind != null) {
    return { title: parsed.title, minutes: byKind[kind], source: 'kind', kind };
  }

  const fallback = durations.defaultMinutes ?? FALLBACK_MINUTES;
  return { title: parsed.title, minutes: fallback, source: 'default' };
}

/** A dropped task becomes a block on the grid's 30-minute lattice. */
export function snapToGrid(minutes: number, step = SNAP_MINUTES): number {
  if (!Number.isFinite(minutes)) return step;
  return Math.max(step, Math.round(minutes / step) * step);
}

/**
 * Total estimated minutes still on the plate — the committed half of the rail
 * footer. Done tasks don't count; they're no longer a commitment.
 *
 * **Counted as it would actually be booked**, i.e. snapped to the grid, because
 * that is the number the free half is being compared against. A `~45m` task is
 * placed as a 60-minute block by every path that books one (the drop handler
 * and the gap engine both call `snapToGrid`), so a footer that called it 45m
 * would quietly under-report the week by a quarter-hour per odd task — in the
 * one line whose whole job is making over-commitment visible.
 */
export function committedMinutes(
  tasks: VaultTask[],
  durations: DurationMap = DEFAULT_DURATIONS,
): number {
  return tasks.reduce(
    (sum, t) =>
      t.done ? sum : sum + snapToGrid(resolveTaskDuration(t.text, durations).minutes),
    0,
  );
}

/** Chip label: `30m`, `1h`, `1h 30m`. */
export function fmtEstimate(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest}m`;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

/** Footer label: `6.5h`, `14h` — one decimal, trailing `.0` dropped. */
export function fmtHours(minutes: number): string {
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

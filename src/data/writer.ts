// The only module in this plugin that writes to the vault. Every rule below
// is load-bearing — this is what turns a ghost into a real line in a note
// someone actually reads, and a mistake here corrupts it.
//
// Three non-negotiables, restated at the point they're enforced below:
//   1. `vault.process` (atomic read-modify-write), never `read` + `modify`.
//   2. Verify the target line is *still* what the snapshot said it was,
//      inside `process`, against the data `process` itself hands over — not
//      the snapshot, which may be seconds stale.
//   3. A group needing more than one sitting is refused whole. One line
//      cannot carry two time ranges, and splitting is Phase 4.
//
// `editPlacements` is the *one* place any of that happens. Accepting a
// proposal, re-timing a block already on the grid, and unscheduling one back
// to the rail are the same operation — write a range (or clear it) and,
// optionally, a scheduled date — with different arguments. `acceptProposals`
// is kept only because it has a shape `editPlacements` doesn't (a `Proposal`,
// day-of-week + minutes rather than a literal range; a `groupKey` to refuse
// multi-session splits by); it turns that shape into `PlacementEdit`s and
// hands them to `editPlacements`, which does the actual touching of files.

import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { Proposal } from '../lib/gaps';
import { dayPlannerRange } from '../lib/source';
import { addDays } from '../lib/week';
import { applyPlacement } from './dayplanner';
import type { PlacementEdit, WriteResult, WriteSkip } from './contract';

/** Local-time `YYYY-MM-DD` for day `day` (0 = Monday) of the week starting
 *  `weekStart` — the same construction `IntentionsRail`'s `todayIso` uses,
 *  kept local rather than UTC because that's what a task's own `📅`/`⏳` is
 *  compared against everywhere else in this codebase. */
export function isoDateFor(weekStart: Date, day: number): string {
  const d = addDays(weekStart, day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** Still shaped like a checkbox line. Checked independently of the text-equal
 *  test below — belt and braces — since an edit that somehow didn't come from
 *  a real checkbox line should never reach `applyPlacement`. */
const CHECKBOX_LINE_RE = /^\s*[-*]\s\[[ xX]\]\s/;

function groupByKey<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const list = map.get(key(item));
    if (list) list.push(item);
    else map.set(key(item), [item]);
  }
  return map;
}

/** `PlacementEdit` carries no id of its own — `file:line` is the natural one,
 *  and it's what every caller who doesn't need a fancier key (re-time,
 *  unschedule) will report skips against. */
function locationKey(e: { file: string; line: number }): string {
  return `${e.file}:${e.line}`;
}

// ---------------------------------------------------------------------------
// editPlacements — the one write path
// ---------------------------------------------------------------------------

/**
 * Apply a batch of placement edits — set a range, change one, or clear one
 * (unschedule) — to the vault. Never throws — a failure writing one file must
 * not lose the others, so every failure mode is either a `WriteSkip`
 * (expected, named) or an entry in `WriteResult.errors` (unexpected, still
 * reported, still not fatal to the rest of the batch).
 *
 * Every safety property lives here and nowhere else:
 *  - `vault.process` (atomic), never `read` + `modify`.
 *  - the target line is re-verified against `expectedText` *inside*
 *    `process`, against the data `process` itself hands over — a stale edit
 *    is skipped (`line-changed`), never guessed at.
 *  - still a checkbox, or skipped (`not-a-task`).
 *  - a missing file is skipped (`file-missing`), never created.
 *  - one `process` call per file, however many edits land in it.
 *  - only the target lines change; everything else round-trips through the
 *    same split/join, line-ending flavour included.
 */
export async function editPlacements(app: App, edits: PlacementEdit[]): Promise<WriteResult> {
  const skipped: WriteSkip[] = [];
  const errors: string[] = [];
  let written = 0;

  const byFile = groupByKey(edits, (e) => e.file);

  for (const [filePath, fileEdits] of byFile) {
    try {
      const file = app.vault.getAbstractFileByPath(filePath);

      if (!file || !(file instanceof TFile)) {
        for (const e of fileEdits) {
          skipped.push({ key: locationKey(e), title: e.title, reason: 'file-missing' });
        }
        continue;
      }

      const applied = new Set<string>();

      await app.vault.process(file, (data: string) => {
        // Detect the file's own line ending rather than assuming one, so a
        // CRLF note comes back CRLF and an LF note comes back LF.
        const eol = data.includes('\r\n') ? '\r\n' : '\n';
        const lines = data.split(eol);

        for (const e of fileEdits) {
          const key = locationKey(e);
          const current = lines[e.line];

          // The snapshot may be seconds old and the user may have edited in
          // between — guessing is not an option, so a changed line is
          // skipped rather than clobbered.
          if (current !== e.expectedText) {
            skipped.push({ key, title: e.title, reason: 'line-changed' });
            continue;
          }
          if (!CHECKBOX_LINE_RE.test(current)) {
            skipped.push({ key, title: e.title, reason: 'not-a-task' });
            continue;
          }

          lines[e.line] = applyPlacement(current, {
            range: e.range,
            scheduledDate: e.scheduledDate,
          });
          applied.add(key);
        }

        // Only the target lines changed above; everything else — including
        // whether the file ends on a trailing separator — round-trips via
        // this same split/join.
        return lines.join(eol);
      });

      written += applied.size;
    } catch (err) {
      errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { written, skipped, errors };
}

// ---------------------------------------------------------------------------
// acceptProposals — a `Proposal`-shaped caller of editPlacements
// ---------------------------------------------------------------------------

export interface AcceptProposalsOptions {
  /** True when `path`'s day-`day` slot is a daily note — its own filename
   *  already says which day it is, so the written line gets no `⏳`/
   *  `[scheduled::]` at all (Day Planner's native convention). */
  isDailyNoteFor: (path: string, day: number) => boolean;
  weekStart: Date;
}

/**
 * Turn accepted proposals into `PlacementEdit`s and delegate to
 * `editPlacements` for the actual write. The one thing that happens here and
 * nowhere else: refusing a group that needs more than one sitting, whole —
 * one line cannot carry two time ranges, and splitting is Phase 4.
 *
 * A `Proposal.key` is `${file}:${line}` for every proposal that survives that
 * filter (a split group's sessions carry a `#n` suffix, and are refused
 * before reaching here), which is also what `editPlacements` reports skips
 * against — so the mapping back from an edit's location to the proposal it
 * came from is only needed for the (rare, test-only) case of a caller who
 * hands over a `key` that doesn't already match its `file`/`line`. Kept
 * explicit rather than assumed, since silently trusting that coincidence is
 * exactly the kind of thing that quietly breaks later.
 */
export async function acceptProposals(
  app: App,
  proposals: Proposal[],
  opts: AcceptProposalsOptions,
): Promise<WriteResult> {
  const skipped: WriteSkip[] = [];

  // --- refuse any group that needs more than one sitting, whole -----------
  const byGroup = groupByKey(proposals, (p) => p.groupKey);
  const writable: Proposal[] = [];
  for (const [groupKey, group] of byGroup) {
    if (group.length > 1) {
      skipped.push({ key: groupKey, title: group[0].title, reason: 'needs-splitting' });
      continue;
    }
    writable.push(group[0]);
  }

  // --- build the edits, remembering each one's originating proposal --------
  const originOf = new Map<string, { key: string; title: string }[]>();
  const edits: PlacementEdit[] = writable.map((p) => {
    const loc = locationKey(p);
    const queue = originOf.get(loc) ?? [];
    queue.push({ key: p.key, title: p.title });
    originOf.set(loc, queue);

    return {
      file: p.file,
      line: p.line,
      expectedText: p.text,
      range: dayPlannerRange(p.startMin, p.endMin),
      scheduledDate: opts.isDailyNoteFor(p.file, p.day) ? null : isoDateFor(opts.weekStart, p.day),
      title: p.title,
    };
  });

  const result = await editPlacements(app, edits);

  // Skips from editPlacements are reported against `file:line`; translate
  // each one back to the proposal it came from (in the order the edits for
  // that location were queued, matching the order editPlacements processes
  // them in), so a caller of acceptProposals sees the same `key`/`title` it
  // always has.
  const remapped: WriteSkip[] = result.skipped.map((s) => {
    const queue = originOf.get(s.key);
    const origin = queue?.shift();
    return origin ? { ...s, key: origin.key, title: origin.title } : s;
  });

  return {
    written: result.written,
    skipped: [...skipped, ...remapped],
    errors: result.errors,
  };
}

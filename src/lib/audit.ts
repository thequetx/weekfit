// Planned vs actual — Phase 4 §5, the week retrospective.
//
// `lib/streaks.ts` already answers a narrow version of this question: how many
// of this week's gym slots have a real event against them (`GYM 3/5`). This
// generalises the same match from *counts of habits* to *hours by category* —
// what the week was set aside for, against what the calendar says actually
// happened, grouped by skeleton block kind and by availability window name.
//
// **It reports; it never changes the plan.** Nothing here writes anywhere, the
// same rule `lib/gaps.ts` and `lib/replan.ts` hold to. The numbers reach the
// weekly note only because `rollWeek` is handed the formatted lines by an
// explicit click in the Review flow.
//
// Pure, clock injected (`opts.now`, never read) — the precedent `computeGaps`
// set, and what makes the DST week and the half-finished week testable.
//
// **There is one matcher.** "Did a real event keep this slot?" is answered by
// lib/streaks.ts for both files. A second, subtly different ±90-minute rule
// living here would make the rail's `GYM 3/5` and the note's `Gym — 5h planned
// / 3h kept` disagree about the same Tuesday. This half goes through
// `claimSlots` rather than `matchSlot` because it adds *hours* up, and one
// event answering for two adjacent slots is a right answer twice over and a
// wrong total.

import { fmtHours } from './duration';
import { hasPassed, passedBlocks } from './replan';
import { claimSlots, skeletonSlots, slotInstant, titleize } from './streaks';
import type {
  AvailabilityWindow,
  CalEvent,
  SkeletonBlock,
  VaultTask,
} from './types';
import { dayIndex, minutesOfDay } from './week';

/** Three or four rows, not a chart (Phase 4 §5). Four is the ceiling: past that
 *  a Sunday reflection turns into a dashboard nobody reads. */
export const AUDIT_ROWS = 4;

/** Where accepted work that landed outside every configured window is grouped.
 *  Kept as its own row rather than dropped — hours spent are hours spent. */
export const OTHER_WINDOW = 'other';

/** Which half of the plan a row came from. `kind` rows are recurring skeleton
 *  blocks; `window` rows are the proposals accepted into a time map window. */
export type AuditGroup = 'kind' | 'window';

export interface AuditRow {
  key: string; // `kind:gym` / `window:deep` — stable, for React keys and sorts
  group: AuditGroup;
  name: string; // the raw kind or window name, lowercased
  label: string; // titleized, what the note and the rail print
  plannedMin: number;
  keptMin: number;
  slots: number; // planned occurrences
  kept: number; // occurrences with something real against them
}

export interface WeekAudit {
  rows: AuditRow[];
  plannedMin: number;
  keptMin: number;
}

export interface AuditInput {
  skeleton: SkeletonBlock[];
  windows: AvailabilityWindow[];
  events: CalEvent[];
  /** The week's open + done tasks. Without them an accepted block can only be
   *  taken at face value; with them, a block whose task is still unchecked is
   *  known not to have happened (the §4 signal) and doesn't count as kept. */
  tasks?: VaultTask[];
}

export interface AuditOptions {
  /** The caller's clock. Supplied, never read here. Only planned time that has
   *  already *elapsed* is audited — asking on Wednesday whether Friday's gym
   *  was kept would report a failure that hasn't had a chance to happen yet.
   *  Omit it (or pass null) for a week that is over and the whole week counts. */
  now?: Date | null;
}

/** A row as it survives a round trip through the weekly note — the label and
 *  the two numbers, which is all `## Review` records. */
export interface AuditSummary {
  label: string;
  plannedMin: number;
  keptMin: number;
}

/** Real elapsed minutes between two instants. Epoch arithmetic, never
 *  wall-clock fields: on Sydney's 23-hour Sunday 01:00→04:00 is three hours on
 *  a clock face and two hours of life, and this reports the two. */
function elapsedMinutes(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

/** The window a block landed in: the first one (in `windows:` order — the same
 *  deterministic tie-break `computeGaps` uses) whose day and hours contain the
 *  block's start. Null when it fell outside every window. */
export function windowFor(
  windows: AvailabilityWindow[],
  day: number,
  startMin: number,
): AvailabilityWindow | null {
  for (const w of windows) {
    if (!w.days.includes(day)) continue;
    if (startMin >= w.startMin && startMin < w.endMin) return w;
  }
  return null;
}

/**
 * The week's planned hours against its kept hours.
 *
 * **Planned** is the two things that put time on the board:
 *   - every skeleton slot in the week, grouped by the block's `kind`;
 *   - every block this app accepted from a proposal (an event carrying a
 *     `taskId`), grouped by the availability window it landed in.
 * Between them that is "skeleton + accepted proposals", and nothing is counted
 * twice: the skeleton half refuses app-placed blocks as evidence for a slot.
 *
 * **Kept** is what the real calendar says about that planned time:
 *   - a skeleton slot is kept when a real (non-app, non-all-day) event starts
 *     within ±90 minutes of it — the same rule behind `GYM 3/5`, but claimed
 *     exclusively (`claimSlots`), so no one event keeps two slots. The minutes
 *     credited are the *event's own*, so a stream that ran an hour long reads
 *     as more kept than planned, which is what happened.
 *   - an accepted block is kept unless it is one of §4's passed-and-undone
 *     blocks — its time went by with the task still unchecked, which is the
 *     plan itself admitting it didn't happen. Without `tasks` there is no such
 *     signal and an accepted block is taken at face value.
 *
 * Only *elapsed* planned time is audited: a slot counts once its end instant is
 * at or before `now`, using `hasPassed` so the comparison is on instants rather
 * than a wall clock that has a missing hour twice a year.
 */
export function auditWeek(
  weekStart: Date,
  input: AuditInput,
  opts: AuditOptions = {},
): WeekAudit {
  // No clock means "the week is over": everything inside it has elapsed.
  const clock = opts.now ?? slotInstant(weekStart, 7, 0);
  const { skeleton, windows, events, tasks } = input;

  const rows = new Map<string, AuditRow>();
  const row = (group: AuditGroup, name: string): AuditRow => {
    const key = `${group}:${name}`;
    let r = rows.get(key);
    if (!r) {
      r = {
        key,
        group,
        name,
        label: titleize(name),
        plannedMin: 0,
        keptMin: 0,
        slots: 0,
        kept: 0,
      };
      rows.set(key, r);
    }
    return r;
  };

  // --- the skeleton half.
  // Claimed as a set, not one slot at a time: `claimSlots` gives each real
  // event to at most one slot, so the shipped skeleton's adjacent `Grocery Run`
  // / `Meal Prep` pair can't both bank the same Sunday afternoon. Only elapsed
  // slots are in the running — a Friday slot must not claim Wednesday's event
  // out from under it on a Wednesday.
  const elapsed = skeletonSlots(skeleton)
    .map((slot) => ({ slot, end: slotInstant(weekStart, slot.day, slot.endMin) }))
    .filter(({ end }) => hasPassed(end, clock));
  const claims = claimSlots(
    weekStart,
    elapsed.map(({ slot }) => slot),
    events,
    { skipAppBlocks: true },
  );
  elapsed.forEach(({ slot, end }, i) => {
    const r = row('kind', slot.kind);
    r.plannedMin += elapsedMinutes(slotInstant(weekStart, slot.day, slot.startMin), end);
    r.slots += 1;
    const hit = claims[i];
    if (hit) {
      r.kept += 1;
      r.keptMin += elapsedMinutes(hit.start, hit.end);
    }
  });

  // --- the accepted-proposal half.
  // §4 already knows which blocks went by with their task still open; that is
  // exactly "planned, not kept", so it is reused rather than re-derived.
  const undone = new Set(
    tasks?.length
      ? passedBlocks(weekStart, events, tasks, { now: clock }).map((p) => p.uid)
      : [],
  );
  for (const ev of events) {
    if (ev.allDay || !ev.taskId) continue;
    if (!hasPassed(ev.end, clock)) continue;
    const day = dayIndex(ev.start, weekStart);
    if (day < 0 || day > 6) continue;
    const w = windowFor(windows, day, minutesOfDay(ev.start));
    const r = row('window', w ? w.name : OTHER_WINDOW);
    const minutes = elapsedMinutes(ev.start, ev.end);
    r.plannedMin += minutes;
    r.slots += 1;
    if (!undone.has(ev.uid)) {
      r.kept += 1;
      r.keptMin += minutes;
    }
  }

  const out = [...rows.values()].filter((r) => r.plannedMin > 0);
  // Biggest commitment first — the same "lead with what the week was mostly
  // for" ordering as the streak rail. `key` is the last tie-break so the order
  // never depends on Map iteration.
  out.sort(
    (a, b) => b.plannedMin - a.plannedMin || b.keptMin - a.keptMin ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  return {
    rows: out,
    plannedMin: out.reduce((s, r) => s + r.plannedMin, 0),
    keptMin: out.reduce((s, r) => s + r.keptMin, 0),
  };
}

/** The three or four rows the Review flow actually shows. */
export function topAuditRows(audit: WeekAudit | null, n = AUDIT_ROWS): AuditRow[] {
  return (audit?.rows ?? []).slice(0, Math.max(0, n));
}

/** "2026-W35" → "W35", for the "down 3h on W35" tail. */
export function shortWeekId(weekId: string | null | undefined): string {
  const m = String(weekId ?? '').match(/W\d{1,2}$/);
  return m ? m[0] : String(weekId ?? '');
}

/** Last week's numbers for the same row, matched on the label — which is all
 *  the weekly note records. Case- and space-insensitive, so a note hand-edited
 *  to `gym` still lines up with this week's `Gym`. */
export function findPrevRow(
  row: { label: string },
  prev: AuditSummary[] | null | undefined,
): AuditSummary | null {
  const key = row.label.trim().toLowerCase();
  return (prev ?? []).find((p) => p.label.trim().toLowerCase() === key) ?? null;
}

/** "Stream — 12h planned / 9h kept". */
export function fmtAuditRow(row: AuditSummary): string {
  return `${row.label} — ${fmtHours(row.plannedMin)} planned / ${fmtHours(row.keptMin)} kept`;
}

/**
 * The week-on-week tail: " — down 3h on W35", or "" when there's nothing to
 * compare with.
 *
 * The comparison is **kept against kept**. Planned hours are a decision, and a
 * decision that changed isn't news; kept hours are behaviour, which is the only
 * half a retrospective can act on. A difference that rounds to nothing at
 * `fmtHours`' own resolution reads as "level with", rather than pretending
 * eleven minutes is a trend.
 */
export function fmtAuditDelta(
  row: AuditSummary,
  prev: AuditSummary | null | undefined,
  prevWeekId: string | null | undefined,
): string {
  if (!prev || !prevWeekId) return '';
  const wk = shortWeekId(prevWeekId);
  const delta = row.keptMin - prev.keptMin;
  const shown = fmtHours(Math.abs(delta));
  if (shown === '0h') return ` — level with ${wk}`;
  return ` — ${delta > 0 ? 'up' : 'down'} ${shown} on ${wk}`;
}

/** One `## Review` line. The shape `electron/vault.cjs` matches on to replace
 *  the block on a second review — keep the two in step. */
export function auditNoteLine(
  row: AuditSummary,
  prev: AuditSummary | null,
  prevWeekId: string | null | undefined,
): string {
  return `- Audit: ${fmtAuditRow(row)}${fmtAuditDelta(row, prev, prevWeekId)}`;
}

/** One habit's kept-against-planned count, as the weekly note's `streaks:`
 *  frontmatter records it (Phase 5 §2). */
export interface StreakCount {
  name: string;
  kept: number;
  slots: number;
}

/**
 * The streak map the Review flow hands to `rollWeek`, for the note's
 * frontmatter and the `Weekly.base` history behind it.
 *
 * Only the **skeleton** rows: `gym: 4/5` is a habit, and a habit is what a
 * streak is. The `window` rows are this week's accepted proposals, which are a
 * different quantity every week and would make the property meaningless as a
 * column. The counts are the audit's own — the same ones behind the rail's
 * `GYM 3/5` — so the note can never disagree with what the rail showed.
 */
export function auditStreaks(audit: WeekAudit | null): StreakCount[] {
  return (audit?.rows ?? [])
    .filter((r) => r.group === 'kind' && r.slots > 0)
    .map((r) => ({ name: r.name, kept: r.kept, slots: r.slots }));
}

/** The lines the Review flow hands to `rollWeek`. Empty when the week has no
 *  elapsed planned time at all — an empty `## Review` beats a row of zeroes. */
export function auditNoteLines(
  audit: WeekAudit | null,
  prev: AuditSummary[] | null | undefined,
  prevWeekId: string | null | undefined,
  n = AUDIT_ROWS,
): string[] {
  return topAuditRows(audit, n).map((r) =>
    auditNoteLine(r, findPrevRow(r, prev), prevWeekId),
  );
}

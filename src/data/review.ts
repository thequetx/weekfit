// The weekly review and roll-forward — Phase 5's "what did the week actually
// keep, and what carries into the next one."
//
// `computeReview` is pure (a `WeekSnapshot` in, a `WeekReview` out, no
// Obsidian import) — same split `computeFit` in `planner.ts` already uses, and
// what makes this file testable without a runtime. `writeReview` and
// `rollForward` are the only impure things here, and they touch the vault
// exclusively through `writer.ts`'s exported primitives
// (`appendUnderHeading` / `removeLines` / `setFrontmatter`); `vault.process`
// itself lives nowhere in this file.
//
// **`hoursPlanned`/`hoursKept` are not `WeekAudit`'s totals.** `lib/audit.ts`
// answers "did a *real* event keep this slot" by matching a skeleton block or
// an accepted proposal against a separate calendar. This plugin has no such
// second calendar — `snapshot.scheduled` *is* the plan, synthesised from the
// vault's own Day Planner lines — so there is no independent signal for
// "actually happened" beyond the block's own task line being ticked done. A
// block that happened but was never ticked cannot be told apart from one that
// simply didn't; both count as not kept, which is the one honest answer
// available. `audit` (via `auditWeek`, ported verbatim) still runs, for the
// richer skeleton/window breakdown the note's `- Audit:` rows and the modal's
// category list show — the two numbers are complementary, not the same
// question asked twice.

import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import { auditNoteLines, auditWeek } from '../lib/audit';
import type { WeekAudit } from '../lib/audit';
import { isRecurring, taskTitle } from '../lib/taskmeta';
import { withDayPlannerRange } from '../lib/source';
import { applyPlacement } from './dayplanner';
import { futureSessions } from '../lib/gaps';
import { addDays } from '../lib/week';
import type { VaultTask } from '../lib/types';
import { appendUnderHeading, removeLines, setFrontmatter } from './writer';
import type { RemoveLineEdit } from './writer';
import type { WeekSnapshot, WeekfitSettings, WriteResult } from './contract';

export interface WeekReview {
  weekId: string;
  audit: WeekAudit | null;
  hoursPlanned: number;
  hoursKept: number;
  tasksTotal: number;
  tasksDone: number;
  intentionsTotal: number;
  intentionsDone: number;
  /**
   * The candidates to carry into next week: not done, not recurring, and
   * **not still scheduled in the future** — a task booked for Friday has not
   * failed on Tuesday, it simply has not come up yet.
   */
  unfinished: VaultTask[];
  /** Whether the reviewed week is actually over. Reviewing mid-week is fine,
   *  but it changes what rolling forward means, so the modal says so. */
  weekHasEnded: boolean;
}

/** Minutes as the hours a property should hold — one decimal, matching
 *  `lib/duration.ts`'s `fmtHours` resolution, so the frontmatter number and
 *  the note's printed hours never disagree. */
function hoursOf(minutes: number): number {
  return Math.round((minutes / 60) * 10) / 10;
}

/**
 * The week's arithmetic. Pure: everything it needs is already in `snapshot`
 * and `settings`; `now` is the caller's clock (never read from anywhere else),
 * the same discipline `auditWeek` itself holds to, so a mid-week review
 * doesn't grade Friday's gym slot before Friday has happened.
 */
export function computeReview(
  snapshot: WeekSnapshot,
  settings: WeekfitSettings,
  now: Date,
): WeekReview {
  // `scheduledLines` rides along so `auditWeek`'s undone-accepted-block check
  // (`passedBlocks`) has every task line this week could possibly reference —
  // harmless even though nothing in this Obsidian-only port ever stamps a
  // `taskId` on a scheduled event, which means that half of `auditWeek` never
  // fires here and `audit.rows` will only ever carry `kind` (skeleton) rows,
  // never `window` ones. That's a property of this port's data, not a bug in
  // `auditWeek` or in this call.
  const tasksForAudit: VaultTask[] = [
    ...snapshot.tasks,
    ...snapshot.thisweek,
    ...snapshot.scheduledLines,
  ];

  const audit = auditWeek(
    snapshot.weekStart,
    {
      skeleton: settings.blocks,
      windows: settings.windows,
      events: snapshot.scheduled,
      tasks: tasksForAudit,
    },
    { now },
  );

  // The literal total across every scheduled block this week: planned is
  // every block's own duration; kept is the subset whose task line is ticked
  // done. See the file header for why this, rather than `audit`'s totals, is
  // the number written to `hours_planned`/`hours_kept`.
  let plannedMin = 0;
  let keptMin = 0;
  snapshot.scheduled.forEach((ev, i) => {
    const minutes = Math.max(0, Math.round((ev.end.getTime() - ev.start.getTime()) / 60000));
    plannedMin += minutes;
    if (snapshot.scheduledLines[i]?.done) keptMin += minutes;
  });

  // Recurring lines (`🔁`) belong to the Tasks plugin, which regenerates its
  // own next instance — carrying one forward would duplicate it and fight
  // whatever `🏁` says should happen next. `intentions` never rolls: Phase 5
  // §2's definition is tasks and `#thisweek` lines only.
  //
  // And nothing that is **still going to happen**. Rolling a task booked for
  // Friday because the review was opened on Tuesday moves work that has not
  // failed — it has not even come up yet — and strips its placement on the
  // way out. "Carry forward what didn't happen" is not "carry forward what
  // hasn't happened yet".
  //
  // `futureSessions` is exactly that question, and `fitTasks` already uses it
  // to leave booked work alone. It matches an event to a task by title, so
  // the line needs its range stripped first: the event's title comes from
  // `scheduledEvents`, which removes the `HH:MM` range, while `parseTaskMeta`
  // deliberately keeps it in the task's display title. Same trap
  // `computeReplan` had to step around.
  const stillToCome = (t: VaultTask): boolean =>
    futureSessions(snapshot.scheduled, { ...t, text: applyPlacement(t.text, { range: null, scheduledDate: null }) }, now)
      .length > 0;

  const unfinished = [...snapshot.tasks, ...snapshot.thisweek].filter(
    (t) => !t.done && !isRecurring(t.text) && !stillToCome(t),
  );

  // Whether the week being reviewed is actually over. Reviewing mid-week is a
  // legitimate thing to do, but it changes what roll-forward means, and the
  // modal says so rather than letting the button look the same either way.
  const weekHasEnded = now.getTime() >= addDays(snapshot.weekStart, 7).getTime();

  return {
    weekId: snapshot.weekId,
    audit,
    hoursPlanned: hoursOf(plannedMin),
    hoursKept: hoursOf(keptMin),
    tasksTotal: snapshot.tasks.length,
    tasksDone: snapshot.tasks.filter((t) => t.done).length,
    intentionsTotal: snapshot.intentions.length,
    intentionsDone: snapshot.intentions.filter((t) => t.done).length,
    unfinished,
    weekHasEnded,
  };
}

// ---------------------------------------------------------------------------
// writeReview — the audit lines + frontmatter, idempotent
// ---------------------------------------------------------------------------

/** A markdown heading line: `#`-run, then the text. Mirrors `writer.ts`'s own
 *  (unexported) `HEADING_RE` — duplicated rather than imported, the same way
 *  `writer.ts` itself duplicates a small regex from `dayplanner.ts` rather
 *  than exporting an internal just for one other caller. */
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;

const AUDIT_LINE_PREFIX = '- Audit:';

/**
 * Every existing `- Audit:` line already sitting under `## Review` (or a
 * deeper `###`+ heading of the same name), by 0-indexed line number. This is
 * the read half of idempotence: `writeReview` removes whatever this finds
 * before appending the freshly computed rows, so reviewing the same week
 * twice replaces the block instead of stacking a second copy underneath it —
 * the same rule `electron/vault.cjs`'s `replaceAuditLines` holds for the
 * desktop app's own weekly note.
 */
function findExistingAuditLines(content: string, heading: string): { line: number; text: string }[] {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(eol);
  const target = heading.trim().toLowerCase();

  let headingIndex = -1;
  let level = 0;
  let sectionEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (!m) continue;
    if (headingIndex === -1) {
      if (m[2].trim().toLowerCase() === target) {
        headingIndex = i;
        level = m[1].length;
      }
      continue;
    }
    if (m[1].length <= level) {
      sectionEnd = i;
      break;
    }
  }
  if (headingIndex === -1) return [];

  const out: { line: number; text: string }[] = [];
  for (let i = headingIndex + 1; i < sectionEnd; i++) {
    if (lines[i].startsWith(AUDIT_LINE_PREFIX)) out.push({ line: i, text: lines[i] });
  }
  return out;
}

/**
 * Record the review: replace whatever `- Audit:` rows are already under the
 * week's `## Review` heading with the freshly computed ones (`auditNoteLines`
 * — `lib/audit.ts`'s own formatting, untouched here), then merge the
 * documented keys into frontmatter (`status`, `hours_planned`, `hours_kept`,
 * `tasks_total`, `tasks_done`, `intentions_total`, `intentions_done`,
 * `last_updated`) via `setFrontmatter`, which — like every write in this
 * plugin — leaves every other key exactly as it stood.
 *
 * **Idempotent.** A second run's own pre-scan finds the first run's rows
 * (`findExistingAuditLines`) and removes them (`removeLines`, which
 * re-verifies each line's text is still what was just read before touching
 * it — a hand-edit to that block between the two runs is left alone and
 * reported as a skip, never overwritten) before appending the recomputed set.
 * `setFrontmatter` is naturally idempotent the same way `processFrontMatter`
 * always is: it sets the same keys to the same values, not more of them.
 *
 * A week with nothing to say — `settings.blocks` is empty, or nothing has
 * elapsed yet — writes no audit lines at all (`auditNoteLines` already
 * returns `[]` for that), but the frontmatter still updates: `status:
 * reviewed` is true the moment the button is pressed, independent of whether
 * there was anything to report.
 */
export async function writeReview(
  app: App,
  snapshot: WeekSnapshot,
  review: WeekReview,
  settings: WeekfitSettings,
): Promise<WriteResult> {
  // `settings` isn't read here — every number `writeReview` writes is already
  // folded into `review` by `computeReview`. Kept as a parameter so this
  // function's signature mirrors `computeReview`'s and a future write (a
  // setting that changes *how* the review note is worded, say) doesn't need a
  // signature change to reach it.
  void settings;

  const file = snapshot.notePath;
  if (!file) {
    return { written: 0, skipped: [], errors: [`no weekly note for ${snapshot.weekId}`] };
  }

  // --- idempotence: clear out whatever a previous review already wrote -----
  let removeResult: WriteResult = { written: 0, skipped: [], errors: [] };
  const abstractFile = app.vault.getAbstractFileByPath(file);
  if (abstractFile instanceof TFile) {
    try {
      const raw = await app.vault.cachedRead(abstractFile);
      const existing = findExistingAuditLines(raw, 'Review');
      if (existing.length > 0) {
        const edits: RemoveLineEdit[] = existing.map((e) => ({
          file,
          line: e.line,
          expectedText: e.text,
          title: 'Audit',
        }));
        removeResult = await removeLines(app, edits);
      }
    } catch (err) {
      removeResult = {
        written: 0,
        skipped: [],
        errors: [`${file}: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  }

  // --- the fresh rows --------------------------------------------------
  // No previous week's numbers are threaded through here, so the "— down 3h
  // on W35" tail never appears yet; wiring that up needs a way to read last
  // week's own `- Audit:` rows back out, which nothing in this port does yet.
  const auditLines = auditNoteLines(review.audit, null, null);
  const appendResult = auditLines.length
    ? await appendUnderHeading(app, [{ file, heading: 'Review', lines: auditLines }])
    : { written: 0, skipped: [], errors: [] };

  // --- frontmatter -------------------------------------------------------
  const fmResult = await setFrontmatter(app, file, {
    status: 'reviewed',
    hours_planned: review.hoursPlanned,
    hours_kept: review.hoursKept,
    tasks_total: review.tasksTotal,
    tasks_done: review.tasksDone,
    intentions_total: review.intentionsTotal,
    intentions_done: review.intentionsDone,
    last_updated: isoLocalDate(new Date()),
  });

  return {
    written: removeResult.written + appendResult.written + fmResult.written,
    skipped: [...removeResult.skipped, ...appendResult.skipped, ...fmResult.skipped],
    errors: [...removeResult.errors, ...appendResult.errors, ...fmResult.errors],
  };
}

/** Local midnight `YYYY-MM-DD`, matching the format every other date field in
 *  this vault convention uses (`writer.ts`'s `isoDateFor`, the vault's own
 *  handoff-log `last_updated`). */
function isoLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// rollForward — carry the unfinished pool into next week
// ---------------------------------------------------------------------------

/** `[[(]scheduled::…[])]`, the same loose either-bracket shape `taskmeta.ts`'s
 *  own (unexported) `inlineRe` builds for every inline field, and the exact
 *  regex `src/data/dayplanner.ts`'s own (unexported) `SCHEDULED_CLEAR_INLINE`
 *  uses. Duplicated here for the same reason: neither file exports it, and
 *  this is the one other place that needs to clear rather than re-stamp it. */
const SCHEDULED_CLEAR_INLINE = /[[(]\s*(?:scheduled)\s*::\s*([^\])]*?)\s*[\])]/i;
/** `⏳ 2026-09-04` / `⌛ 2026-09-04`, trailing variation selector included —
 *  mirrors `dayplanner.ts`'s `SCHEDULED_CLEAR_EMOJI`. */
const SCHEDULED_CLEAR_EMOJI = /[⏳⌛]️?(?:\s*\d{4}-\d{2}-\d{2})?/u;

/** Remove a scheduled-date stamp, in either flavour — a placement in a week
 *  that has ended is meaningless, so rolling forward drops it rather than
 *  carrying a `⏳` that now points at the past. */
function clearScheduled(text: string): string {
  return String(text ?? '')
    .replace(SCHEDULED_CLEAR_INLINE, ' ')
    .replace(SCHEDULED_CLEAR_EMOJI, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/, '');
}

/** Leading whitespace + list marker + checkbox, mirroring `dayplanner.ts`'s
 *  own (unexported) `PREFIX_RE` exactly, for the same reason every other
 *  small regex in this pair of files is duplicated rather than exported. */
const PREFIX_RE = /^(\s*[-*]\s\[[ xX]\])(\s*)/;

/**
 * A task line, ready to carry into next week: the Day Planner range and the
 * scheduled date both stripped (a placement and a date in a week that's over
 * are both meaningless), everything else — the estimate, due date, priority,
 * tags, `🆔` — carried across byte-for-byte.
 */
function rollLineText(rawLine: string): string {
  const m = PREFIX_RE.exec(rawLine);
  const prefix = m ? m[0] : '';
  const body = m ? rawLine.slice(prefix.length) : rawLine;
  return prefix + clearScheduled(withDayPlannerRange(body, null));
}

/**
 * Carry `review.unfinished` into `targetNotePath`'s `## Tasks` section, then
 * remove them from wherever they came from.
 *
 * **Append first, remove second — always, and never the other way round.**
 * If the append fails (a bad path, a locked file, anything landing in
 * `WriteResult.errors`), nothing is removed: the tasks stay exactly where
 * `snapshot` found them, so a failed roll costs nothing. The reverse order
 * would risk deleting a user's tasks from this week's note while the copy
 * meant to replace them never landed — unrecoverable, whereas a duplicate
 * left behind by a *retried* roll (this week's copy plus a stray line that
 * `removeLines` skipped as `line-changed` because it changed underneath the
 * user between read and write) is trivially fixable by comparing the two
 * notes.
 *
 * One `appendUnderHeading` call carries every unfinished line in a single
 * edit (one `vault.process`/`create` on the target, whatever the count), and
 * `removeLines` groups the per-source-file removals the same way, so a
 * roll spanning the weekly note and several daily notes still costs at most
 * one write per file touched.
 */
export async function rollForward(
  app: App,
  snapshot: WeekSnapshot,
  review: WeekReview,
  targetNotePath: string,
  settings: WeekfitSettings,
): Promise<WriteResult> {
  // Not read here — see `writeReview`'s note on the same parameter. Kept for
  // signature symmetry with `computeReview`/`writeReview`.
  void settings;
  void snapshot; // `review.unfinished` already carries everything to roll

  const unfinished = review.unfinished;
  if (unfinished.length === 0) {
    return { written: 0, skipped: [], errors: [] };
  }

  const newLines = unfinished.map((t) => rollLineText(t.text));

  const appendResult = await appendUnderHeading(app, [
    { file: targetNotePath, heading: 'Tasks', lines: newLines },
  ]);

  if (appendResult.errors.length > 0) {
    // Nothing removed. The source notes are untouched — `removeLines` is
    // never called on this path.
    return { written: 0, skipped: [], errors: appendResult.errors };
  }

  const removeEdits: RemoveLineEdit[] = unfinished.map((t) => ({
    file: t.file,
    line: t.line,
    expectedText: t.text,
    title: taskTitle(t.text),
  }));

  const removeResult = await removeLines(app, removeEdits);

  return {
    written: removeResult.written,
    skipped: removeResult.skipped,
    errors: [...appendResult.errors, ...removeResult.errors],
  };
}

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
import { dayPlannerRange, DAY_PLANNER_RE } from '../lib/source';
import { addDays } from '../lib/week';
import { clearCompletion, parseTaskMeta, taskTitle, withCompletion } from '../lib/taskmeta';
import type { MetaFlavour } from '../lib/taskmeta';
import { applyPlacement, hasPlacement, splitTaskPrefix } from './dayplanner';
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
// rewriteVerifiedLines — the one write path
//
// Every public write below is this function plus a line transform. Adding a
// second copy of it is the mistake this section exists to prevent.
// ---------------------------------------------------------------------------

/** The minimum a verified line edit needs: where it is, and what it was when
 *  it was read. */
interface VerifiedEdit {
  file: string;
  line: number;
  expectedText: string;
  title: string;
}

/**
 * The one verified read-modify-write in this plugin.
 *
 * Every safety property lives here and nowhere else — atomic `vault.process`,
 * the target line re-checked against what was read, a refusal rather than a
 * guess when it moved, one write per file however many edits it carries, the
 * file's own line endings preserved, and never a throw. Callers supply only
 * the line transform.
 *
 * Extracted when a second kind of edit (ticking a task from the rail) arrived:
 * two copies of this loop is exactly how the checks drift apart, and the
 * property this codebase gates on is that there is only one of them.
 */
async function rewriteVerifiedLines<T extends VerifiedEdit>(
  app: App,
  edits: T[],
  transform: (current: string, edit: T) => string,
  /**
   * Absolute line indices this edit makes obsolete, if any. Collected across
   * the whole batch and spliced **descending** after every transform has run,
   * so a deletion can never shift a line another edit in the same batch is
   * still pointing at.
   */
  collectDeletions?: (edit: T, lines: string[]) => number[],
): Promise<WriteResult> {
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
      const doomed = new Set<number>();

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

          lines[e.line] = transform(current, e);
          for (const idx of collectDeletions?.(e, lines) ?? []) doomed.add(idx);
          applied.add(key);
        }

        // Descending, so removing one line can't move another still queued.
        for (const idx of [...doomed].sort((a, b) => b - a)) lines.splice(idx, 1);

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

/** Set, change or remove a Day Planner placement on a verified line. */
export async function editPlacements(app: App, edits: PlacementEdit[]): Promise<WriteResult> {
  return rewriteVerifiedLines(
    app,
    edits,
    (current, e) => applyPlacement(current, { range: e.range, scheduledDate: e.scheduledDate }),
    // A task is either one block or several sittings — never both. Giving a
    // line its own time makes any sittings written beneath it obsolete, so
    // they go with it. Without this, placing a split parent books the same
    // work three times: its own block plus every child still sitting there.
    // Clearing the parent's range (unschedule) takes the sittings too, for
    // the same reason — the plan for that task is being withdrawn either way.
    (e, lines) => childSessionLines(lines, e.line),
  );
}

/**
 * The indented sitting lines belonging to the task at `parentIndex`.
 *
 * Same structural rule as `replaceChildSessions` and `hasScheduledSessions`,
 * and deliberately just as narrow: a contiguous run starting immediately
 * below, indented deeper, each a checkbox line carrying a time range. It stops
 * at the first line that fails any of those, so a hand-written sub-task is
 * never swept up.
 */
function childSessionLines(lines: string[], parentIndex: number): number[] {
  const parent = lines[parentIndex];
  if (parent == null) return [];
  const parentIndent = leadingWidth(parent);
  const out: number[] = [];
  for (let i = parentIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!CHECKBOX_LINE_RE.test(line)) break;
    if (leadingWidth(line) <= parentIndent) break;
    if (!hasPlacement(line)) break;
    out.push(i);
  }
  return out;
}

function leadingWidth(text: string): number {
  const m = /^[ 	]*/.exec(text);
  return m ? m[0].length : 0;
}

/** The checkbox itself: leading whitespace, list marker, `[ ]` or `[x]`. */
const CHECKBOX_MARK_RE = /^(\s*[-*]\s*\[)([ xX])(\])/;

export interface TaskDoneEdit extends VerifiedEdit {
  /** Where the checkbox should end up. */
  done: boolean;
}

/**
 * Tick or untick a task from the rail, so the pane is not a read-only window
 * onto work you then have to go and edit by hand.
 *
 * Ticking stamps a completion date and unticking removes it — both via
 * `withCompletion` / `clearCompletion` in the ported `taskmeta.ts`, which
 * already match the line's own emoji-or-inline flavour. No date syntax is
 * invented here.
 */
export async function setTaskDone(app: App, edits: TaskDoneEdit[]): Promise<WriteResult> {
  const now = new Date();
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;

  return rewriteVerifiedLines(app, edits, (current, e) => {
    // Flip the box, then apply the completion field to the **body** only.
    //
    // `clearCompletion` (ported, and not ours to change) collapses any run of
    // two or more spaces to one — which includes a line's leading indentation.
    // Run against a whole line it de-indents it, and an indented line is
    // exactly what splitting writes for each sitting of a task, so ticking one
    // would silently break the parent/child structure. Splitting the prefix off
    // first is the same discipline `applyPlacement` already uses.
    const flipped = current.replace(CHECKBOX_MARK_RE, `$1${e.done ? 'x' : ' '}$3`);
    const { prefix, body } = splitTaskPrefix(flipped);
    return prefix + (e.done ? withCompletion(body, iso) : clearCompletion(body));
  });
}

export interface AcceptProposalsOptions {
  /** True when `path`'s day-`day` slot is a daily note — its own filename
   *  already says which day it is, so the written line gets no `⏳`/
   *  `[scheduled::]` at all (Day Planner's native convention). */
  isDailyNoteFor: (path: string, day: number) => boolean;
  weekStart: Date;
}

/** Leading whitespace + bullet + checkbox, captured separately so a child
 *  line can be built with the parent's own indentation and bullet character
 *  rather than a hard-coded one. Falls back to `-` with no indentation for a
 *  parent whose own prefix is somehow missing — `replaceChildSessions` still
 *  verifies `expectedText` before anything is written, so this only ever
 *  affects what a *rejected* write would have looked like. */
const PARENT_BULLET_RE = /^(\s*)([-*])\s\[[ xX]\]/;

function parentBullet(parentText: string): { indent: string; bullet: string } {
  const m = PARENT_BULLET_RE.exec(parentText);
  return m ? { indent: m[1], bullet: m[2] } : { indent: '', bullet: '-' };
}

/** One indented child line for `replaceChildSessions`: the parent's own
 *  indentation plus one level (four spaces, matching the fixed convention
 *  every fixture in this file and `test/writer.test.ts` uses), the parent's
 *  bullet, an unchecked checkbox, the range and title, and a scheduled date —
 *  a child in a weekly note needs its own day, since it can land on a
 *  different one than any sibling.
 *
 *  Built through `applyPlacement` rather than hand-assembled, so the range
 *  and the scheduled-date stamp go through the exact same regexes
 *  `editPlacements` already trusts for every other write in this file. A
 *  fresh child line carries no metadata of its own for `applyPlacement` to
 *  detect a flavour from — unlike every other call site here, which reuses
 *  the *target* line's own existing flavour — so when the parent is written
 *  in the Dataview `[scheduled:: ]` flavour, a same-flavoured (and
 *  immediately cleared) placeholder is seeded into the stub first. That
 *  makes `applyPlacement`'s own flavour detection land on `inline` using its
 *  real code path, rather than this file re-deriving the two written forms
 *  of a scheduled date next to the one `lib/taskmeta.ts` already owns. */
function childSessionLine(
  parentText: string,
  title: string,
  range: string,
  scheduledDate: string | null,
): string {
  const { indent, bullet } = parentBullet(parentText);
  const flavour: MetaFlavour = parseTaskMeta(parentText).flavour === 'inline' ? 'inline' : 'emoji';
  const seed = flavour === 'inline' ? ' [scheduled:: 0000-01-01]' : '';
  const stub = `${indent}    ${bullet} [ ] ${title}${seed}`;
  return applyPlacement(stub, { range, scheduledDate });
}

/**
 * Turn accepted proposals into writes, one group at a time. A group is every
 * proposal sharing a `groupKey` — one sitting for an ordinary task, several
 * for one `placeItems` had to split across the week (Phase 4 §3).
 *
 *  - **One sitting**: unchanged from before splitting existed — a single
 *    range (and, unless the target is today's daily note, a scheduled date)
 *    written straight onto the task's own line via `editPlacements`.
 *  - **Several sittings**: the parent line keeps its estimate and gets no
 *    range of its own — it is the task, not a sitting — and each session
 *    becomes an indented child line beneath it via `replaceChildSessions`.
 *    A parent that already carries a Day Planner range (a single-sitting
 *    task that slipped and is now being replanned across more than one
 *    sitting) has that range cleared first, exactly like an ordinary
 *    unschedule (`range: null, scheduledDate: null` — the existing `⏳`, if
 *    any, is left alone for the same reason unscheduling never touches it:
 *    there is no way to tell a hand-typed date from one this app wrote). A
 *    parent that never had a range skips that step entirely, which is also
 *    what keeps a first-time split byte-identical to before this existed.
 *
 * `Proposal.key` is `${file}:${line}` for a one-sitting group, and
 * `${file}:${line}#n` for the nth session of a split one — never the write
 * target directly, so skips from the underlying writers are always remapped
 * back to the *group's* key/title before being reported, the same discipline
 * the one-sitting path already followed before splitting existed.
 */
export async function acceptProposals(
  app: App,
  proposals: Proposal[],
  opts: AcceptProposalsOptions,
): Promise<WriteResult> {
  const byGroup = groupByKey(proposals, (p) => p.groupKey);
  const single: Proposal[] = [];
  const groups: { groupKey: string; sessions: Proposal[] }[] = [];

  for (const [groupKey, group] of byGroup) {
    if (group.length > 1) {
      groups.push({
        groupKey,
        sessions: [...group].sort((a, b) => (a.session ?? 0) - (b.session ?? 0)),
      });
    } else {
      single.push(group[0]);
    }
  }

  const skipped: WriteSkip[] = [];
  const errors: string[] = [];
  let written = 0;

  // --- one-sitting groups: exactly today's behaviour -----------------------
  const originOf = new Map<string, { key: string; title: string }[]>();
  const singleEdits: PlacementEdit[] = single.map((p) => {
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

  if (singleEdits.length) {
    const result = await editPlacements(app, singleEdits);
    written += result.written;
    errors.push(...result.errors);
    for (const s of result.skipped) {
      const queue = originOf.get(s.key);
      const origin = queue?.shift();
      skipped.push(origin ? { ...s, key: origin.key, title: origin.title } : s);
    }
  }

  // --- split groups: clear a stale range on the parent, then write sessions
  //     as children beneath it --------------------------------------------
  if (groups.length) {
    const parentTextOf = new Map(groups.map((g) => [g.groupKey, g.sessions[0].text]));
    const needsClear = groups.filter((g) => hasPlacement(parentTextOf.get(g.groupKey)!));

    // A group whose parent needed clearing and didn't survive it (the line
    // moved since the snapshot, or stopped being a checkbox) must not have
    // its children written on top of whatever is there now.
    const droppedGroupKeys = new Set<string>();

    if (needsClear.length) {
      const clearEdits: PlacementEdit[] = needsClear.map((g) => ({
        file: g.sessions[0].file,
        line: g.sessions[0].line,
        expectedText: g.sessions[0].text,
        range: null,
        scheduledDate: null,
        title: g.sessions[0].title,
      }));
      const clearResult = await editPlacements(app, clearEdits);
      errors.push(...clearResult.errors);

      const byLoc = new Map(needsClear.map((g) => [locationKey(g.sessions[0]), g]));
      for (const s of clearResult.skipped) {
        const g = byLoc.get(s.key);
        if (g) {
          droppedGroupKeys.add(g.groupKey);
          skipped.push({ key: g.groupKey, title: g.sessions[0].title, reason: s.reason });
        } else {
          skipped.push(s);
        }
      }
    }

    const survivors = groups.filter((g) => !droppedGroupKeys.has(g.groupKey));
    if (survivors.length) {
      const childEdits: ChildSessionsEdit[] = survivors.map((g) => {
        const parentText = parentTextOf.get(g.groupKey)!;
        const cleared = hasPlacement(parentText)
          ? applyPlacement(parentText, { range: null, scheduledDate: null })
          : parentText;
        return {
          file: g.sessions[0].file,
          line: g.sessions[0].line,
          expectedText: cleared,
          title: g.sessions[0].title,
          sessions: g.sessions.map((p) =>
            childSessionLine(
              parentText,
              p.title,
              dayPlannerRange(p.startMin, p.endMin),
              opts.isDailyNoteFor(p.file, p.day) ? null : isoDateFor(opts.weekStart, p.day),
            ),
          ),
        };
      });

      const childResult = await replaceChildSessions(app, childEdits);
      errors.push(...childResult.errors);

      const byLoc = new Map(survivors.map((g) => [locationKey(g.sessions[0]), g]));
      const skippedLocs = new Set(childResult.skipped.map((s) => s.key));
      for (const g of survivors) {
        if (!skippedLocs.has(locationKey(g.sessions[0]))) written += g.sessions.length;
      }
      for (const s of childResult.skipped) {
        const g = byLoc.get(s.key);
        skipped.push(g ? { key: g.groupKey, title: g.sessions[0].title, reason: s.reason } : s);
      }
    }
  }

  return { written, skipped, errors };
}

// ---------------------------------------------------------------------------
// appendUnderHeading — capture a line into a `##` section
// ---------------------------------------------------------------------------

export interface AppendEdit {
  file: string;
  /** Matched case-insensitively; `###`+ is tolerated as well as `##`. May be
   *  given with or without its own leading `#`s. */
  heading: string;
  lines: string[];
}

/** A markdown heading line: `#`-run, then the text. */
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;

/** `heading`'s own leading `#`s and surrounding whitespace stripped, case and
 *  the rest of the text left exactly as given — used when *writing* a new
 *  heading, where the caller's casing has to survive. */
function stripHeadingHashes(heading: string): string {
  return heading.replace(/^#{1,6}\s*/, '').trim();
}

/** `stripHeadingHashes`, lowercased — used only for *comparing* two headings,
 *  never for writing one back out. */
function normalizeHeading(heading: string): string {
  return stripHeadingHashes(heading).toLowerCase();
}

/**
 * Find `heading` in `lines` (case-insensitively, any `#` level, first match
 * wins) and the exclusive end of its section: the next line that is a
 * heading of the *same or higher* level (a deeper subheading is content, not
 * a boundary), or `lines.length` when this is the last section in the file.
 * `null` when the heading isn't present at all.
 */
function findSection(
  lines: string[],
  heading: string,
): { headingIndex: number; sectionEnd: number } | null {
  const target = normalizeHeading(heading);
  let headingIndex = -1;
  let level = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (!m) continue;

    if (headingIndex === -1) {
      if (normalizeHeading(m[2]) === target) {
        headingIndex = i;
        level = m[1].length;
      }
      continue;
    }

    if (m[1].length <= level) return { headingIndex, sectionEnd: i };
  }

  return headingIndex === -1 ? null : { headingIndex, sectionEnd: lines.length };
}

/**
 * Where new content belongs inside a section spanning `[start, end)`: right
 * after the section's last non-blank line, so a trailing blank that
 * separates it from whatever comes next (another heading, or the file's own
 * end-of-file newline) is never disturbed and never duplicated by a second
 * capture.
 *
 * A section with *no* content yet is the one special case: inserting right
 * after the heading's own blank line (rather than before it, which is what
 * the "last non-blank line" rule alone would do — there is no non-blank line
 * yet, so it would land right after the heading) keeps the
 * heading-blank-content spacing every other section already has.
 */
function insertionPoint(lines: string[], start: number, end: number): number {
  let lastContent = -1;
  for (let i = start; i < end; i++) {
    if (lines[i] !== '') lastContent = i;
  }
  if (lastContent >= 0) return lastContent + 1;
  return start < end && lines[start] === '' ? start + 1 : start;
}

/**
 * One edit's insertion against a `lines` array already split on `eol` —
 * shared by both `appendUnderHeading`'s missing-file path (built up from
 * `[]`) and its existing-file path (read inside `vault.process`).
 */
function applyAppend(lines: string[], heading: string, newLines: string[], eol: string): string[] {
  const section = findSection(lines, heading);

  if (!section) {
    // The heading itself is missing: create it at the end of the file rather
    // than refusing the capture. Any trailing blank(s) already there are
    // collapsed into the one blank a new heading needs before it (matching
    // the single blank this vault already uses between every pair of
    // headings), and the result always ends on its own trailing newline,
    // matching the convention every other section in this file follows.
    const out = [...lines];
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    if (out.length > 0) out.push('');
    out.push(`## ${stripHeadingHashes(heading)}`, '', ...newLines, '');
    return out;
  }

  const out = [...lines];
  const at = insertionPoint(out, section.headingIndex + 1, section.sectionEnd);
  out.splice(at, 0, ...newLines);
  return out;
}

/**
 * Insert `lines` at the end of each edit's `##` section (a deeper `###`+
 * heading with the same name is tolerated too) — never at the top, and never
 * shoved after the blank line that separates the section from whatever
 * follows it.
 *
 * Two creations happen here, and nowhere else in this file:
 *  - a **missing heading** is created at the end of the file rather than
 *    failing the capture — a capture that silently goes nowhere is worse
 *    than one that makes its own section.
 *  - a **missing file** is created with just that heading and these lines —
 *    the one place creation is allowed at all, because "capture to this
 *    week's note" has to work before that note exists.
 *
 * Everything else `editPlacements` enforces still applies: one
 * `process`/`create` call per file however many edits it carries, the file's
 * own line ending detected and preserved, nothing but the intended lines
 * changed, and a failure is reported (`WriteResult.errors`) rather than
 * thrown.
 */
export async function appendUnderHeading(app: App, edits: AppendEdit[]): Promise<WriteResult> {
  const skipped: WriteSkip[] = [];
  const errors: string[] = [];
  let written = 0;

  const byFile = groupByKey(edits, (e) => e.file);

  for (const [filePath, fileEdits] of byFile) {
    try {
      const file = app.vault.getAbstractFileByPath(filePath);

      if (!file || !(file instanceof TFile)) {
        const eol = '\n'; // nothing to detect from — the file doesn't exist yet
        let lines: string[] = [];
        for (const e of fileEdits) {
          lines = applyAppend(lines, e.heading, e.lines, eol);
        }
        await app.vault.create(filePath, lines.join(eol));
        written += fileEdits.length;
        continue;
      }

      await app.vault.process(file, (data: string) => {
        const eol = data.includes('\r\n') ? '\r\n' : '\n';
        let lines = data.split(eol);
        for (const e of fileEdits) {
          lines = applyAppend(lines, e.heading, e.lines, eol);
        }
        return lines.join(eol);
      });
      written += fileEdits.length;
    } catch (err) {
      errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { written, skipped, errors };
}

// ---------------------------------------------------------------------------
// removeLines — delete verified lines, bottom-up
// ---------------------------------------------------------------------------

export interface RemoveLineEdit {
  file: string;
  line: number;
  /** The line as it was when read; a changed line is skipped, never guessed
   *  at — same rule `editPlacements` verifies `expectedText` against. */
  expectedText: string;
  title: string;
}

/**
 * Delete verified lines from the vault. Same discipline as `editPlacements`
 * throughout: `vault.process` (atomic), the target line re-verified against
 * `expectedText` *inside* `process`, a missing file skipped rather than
 * created, one `process` call per file however many lines it carries, the
 * file's line ending detected and preserved, and nothing else in the file
 * reformatted.
 *
 * Deletes **bottom-up within each file** — highest line number first — so an
 * earlier deletion never shifts a later one's line number out from under it.
 * Getting this backwards would delete the wrong lines, which this codebase
 * treats as the worst possible failure a writer can produce. A line whose
 * text no longer matches is skipped as `line-changed`; the rest of that
 * file's edits still go ahead.
 */
export async function removeLines(app: App, edits: RemoveLineEdit[]): Promise<WriteResult> {
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

      // Highest line number first, so removing one never shifts another
      // still waiting to be verified/removed within this same file.
      const ordered = [...fileEdits].sort((a, b) => b.line - a.line);

      await app.vault.process(file, (data: string) => {
        const eol = data.includes('\r\n') ? '\r\n' : '\n';
        const lines = data.split(eol);

        for (const e of ordered) {
          const key = locationKey(e);
          const current = lines[e.line];

          if (current !== e.expectedText) {
            skipped.push({ key, title: e.title, reason: 'line-changed' });
            continue;
          }

          lines.splice(e.line, 1);
          written++;
        }

        return lines.join(eol);
      });
    } catch (err) {
      errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { written, skipped, errors };
}

// ---------------------------------------------------------------------------
// setFrontmatter — merge a patch into a note's frontmatter
// ---------------------------------------------------------------------------

/**
 * Merge `patch` into `file`'s frontmatter, leaving every other key untouched.
 * A file with no frontmatter gets one created.
 *
 * Delegates entirely to Obsidian's own `app.fileManager.processFrontMatter` —
 * the official atomic read-modify-write for frontmatter — rather than
 * hand-parsing YAML, which would eventually mangle a key some other tool
 * (`Weekly.base`, the Tasks plugin, Tyler himself) also reads or writes.
 *
 * A missing file is reported as a skip, never created — unlike
 * `appendUnderHeading`, there is no "capture" use case here that needs a note
 * to spring into existence just to hold frontmatter. Never throws: any
 * failure `processFrontMatter` raises (a YAML parse error, for instance)
 * lands in `WriteResult.errors`.
 */
export async function setFrontmatter(
  app: App,
  file: string,
  patch: Record<string, unknown>,
): Promise<WriteResult> {
  const skipped: WriteSkip[] = [];
  const errors: string[] = [];
  let written = 0;

  try {
    const f = app.vault.getAbstractFileByPath(file);

    if (!f || !(f instanceof TFile)) {
      skipped.push({ key: file, title: file, reason: 'file-missing' });
      return { written, skipped, errors };
    }

    await app.fileManager.processFrontMatter(f, (frontmatter: Record<string, unknown>) => {
      Object.assign(frontmatter, patch);
    });
    written = 1;
  } catch (err) {
    errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { written, skipped, errors };
}

// ---------------------------------------------------------------------------
// replaceChildSessions — split a task across sittings
// ---------------------------------------------------------------------------

export interface ChildSessionsEdit {
  file: string;
  /** The PARENT task line, 0-indexed. */
  line: number;
  /** The parent line as it was when read; verified before anything is
   *  touched, exactly like every other edit in this file. */
  expectedText: string;
  title: string;
  /** Full child lines, indentation included. `[]` clears any existing
   *  sessions and writes nothing back — how a split is undone. */
  sessions: string[];
}

/** Leading whitespace only — used to compare a candidate child's indentation
 *  against its parent's. */
const LEADING_WS_RE = /^(\s*)/;

/** Local re-derivation of `dayplanner.ts`'s own (unexported) checkbox-prefix
 *  split — same regex, so the body this file extracts a title from agrees
 *  exactly with what `applyPlacement` sees. Duplicated rather than exported
 *  from `dayplanner.ts`, which this file doesn't touch. */
const CHILD_PREFIX_RE = /^(\s*[-*]\s\[[ xX]\])(\s*)/;

function bodyOf(line: string): string {
  const m = CHILD_PREFIX_RE.exec(line);
  return m ? line.slice(m[0].length) : line;
}

/** Display title with the checkbox and any leading Day Planner range both
 *  stripped — what a parent line and one of its session children are
 *  compared by, so `~90m` on the parent and `⏳ 2026-09-01` on a child never
 *  make an otherwise-identical title look different. */
function sessionTitle(line: string): string {
  return taskTitle(bodyOf(line).replace(DAY_PLANNER_RE, ''));
}

function indentOf(line: string): number {
  return (LEADING_WS_RE.exec(line)?.[1] ?? '').length;
}

/**
 * Is `line` one of the parent's existing session children? Every condition
 * has to hold, and conservatively so — a hand-written indented sub-task under
 * a task must never be swept up and deleted just because it happens to sit
 * under a split parent:
 *  - indented **deeper** than the parent;
 *  - a checkbox line;
 *  - carries a leading Day Planner range — via `hasPlacement`, not a raw
 *    `DAY_PLANNER_RE.test` against the whole line. That regex is documented
 *    as body-only and anchored at `^`; testing it against a raw, prefixed
 *    line is exactly the bug `hasPlacement`'s own doc comment warns about,
 *    and it shipped once already.
 *  - its title matches the parent's.
 */
function isSessionChild(line: string, parentIndent: number, parentTitle: string): boolean {
  return (
    indentOf(line) > parentIndent &&
    CHECKBOX_LINE_RE.test(line) &&
    hasPlacement(line) &&
    sessionTitle(line) === parentTitle
  );
}

/**
 * Replace a task's split-across-sittings children in place: the parent line
 * (its `~90m` estimate, untouched) followed by one indented Day Planner line
 * per sitting. Re-fitting the same task calls this again with a new
 * `sessions` list — children are **replaced**, never appended to, so
 * re-fitting doesn't accumulate duplicates.
 *
 * Same discipline as `editPlacements` throughout: the parent is verified
 * against `expectedText` *inside* `process`, a stale parent is skipped whole
 * (`line-changed`) rather than guessed at, one `process` call per file
 * however many parents it carries, the file's line ending detected and
 * preserved, and only the parent's own children move — everything else,
 * including the parent line itself, round-trips byte-identical.
 *
 * Existing children are found *structurally*: the contiguous run
 * immediately below the parent that keeps satisfying `isSessionChild`. The
 * scan stops at the first line that doesn't — that line, and everything
 * after it, is left exactly where it is; `sessions` are spliced in *before*
 * it, never over it.
 */
export async function replaceChildSessions(
  app: App,
  edits: ChildSessionsEdit[],
): Promise<WriteResult> {
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

      // Bottom-up, same reason as `removeLines`: replacing one parent's
      // children changes how many lines follow it, which would shift a
      // lower-numbered parent still waiting its turn.
      const ordered = [...fileEdits].sort((a, b) => b.line - a.line);

      await app.vault.process(file, (data: string) => {
        const eol = data.includes('\r\n') ? '\r\n' : '\n';
        const lines = data.split(eol);

        for (const e of ordered) {
          const key = locationKey(e);
          const current = lines[e.line];

          if (current !== e.expectedText) {
            skipped.push({ key, title: e.title, reason: 'line-changed' });
            continue;
          }

          const parentIndent = indentOf(current);
          const parentTitle = sessionTitle(current);

          let end = e.line + 1;
          while (end < lines.length && isSessionChild(lines[end], parentIndent, parentTitle)) {
            end++;
          }

          lines.splice(e.line + 1, end - (e.line + 1), ...e.sessions);
          written++;
        }

        return lines.join(eol);
      });
    } catch (err) {
      errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { written, skipped, errors };
}

// ---------------------------------------------------------------------------
// createNote — the first-run seed
// ---------------------------------------------------------------------------

/**
 * Create a note that doesn't exist yet, making its parent folders on the way.
 *
 * Exists for the "Create this week's note" command, which is the answer to the
 * actual day-one wall: a vault that has never heard of this plugin has no
 * weekly note, so the view opens empty and quietly expects the user to build a
 * three-heading structure by hand before anything works.
 *
 * `vault.create` throws if the parent folder is missing, and on a fresh vault
 * `Weekly/` usually is — so the folders are made first. Refuses rather than
 * overwrites if the file already exists: this is a seed, never a reset, and
 * clobbering a week someone had already written would be unforgivable.
 */
export async function createNote(app: App, file: string, content: string): Promise<WriteResult> {
  const errors: string[] = [];
  try {
    if (app.vault.getAbstractFileByPath(file)) {
      errors.push(`${file} already exists`);
      return { written: 0, skipped: [], errors };
    }

    const slash = file.lastIndexOf('/');
    if (slash > 0) {
      const folder = file.slice(0, slash);
      if (!app.vault.getAbstractFileByPath(folder)) {
        try {
          await app.vault.createFolder(folder);
        } catch {
          // Another process may have made it between the check and the call,
          // which is success as far as this is concerned.
        }
      }
    }

    await app.vault.create(file, content);
    return { written: 1, skipped: [], errors };
  } catch (err) {
    errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    return { written: 0, skipped: [], errors };
  }
}

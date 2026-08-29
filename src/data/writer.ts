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
import { taskTitle } from '../lib/taskmeta';
import { applyPlacement, hasPlacement } from './dayplanner';
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

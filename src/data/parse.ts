// Pure parsing for weekly/daily note content — no Obsidian, no Date math beyond
// what the caller hands in, no I/O. Every function here takes plain strings (or
// a `Date` the caller already resolved) and returns plain data, which is what
// makes it testable with nothing but `node` — see test/parse.test.ts.
//
// `src/data/vaultRepo.ts` is the only caller: it does the Obsidian I/O (reading
// files, resolving note paths with `moment`) and hands the raw content here.

import { DAY_PLANNER_RE, formatSource } from '../lib/source';
import { parseTaskMeta, taskTitle } from '../lib/taskmeta';
import { dayIndex } from '../lib/week';
import type { CalEvent, VaultTask } from '../lib/types';

// ---------------------------------------------------------------------------
// Shared line-level helpers
// ---------------------------------------------------------------------------

/** Splits on both `\n` and `\r\n` so a note saved with CRLF line endings (some
 *  Windows editors, some sync tools) doesn't shift every line number by
 *  leaving a trailing `\r` on the text. */
function splitLines(content: string): string[] {
  return String(content ?? '').split(/\r\n|\n/);
}

/** A checklist line, any indentation. Captures the done marker and the body —
 *  everything after `- [ ] ` / `- [x] ` — so callers don't each re-derive it. */
const CHECKBOX_LINE_RE = /^\s*-\s\[([ xX])\]\s+(.*)$/;

function isFenceDelimiter(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

/** `true` at index `i` when line `i` is inside (or is) a fenced code block, so
 *  a stray `## heading`-looking comment or a `#thisweek`-looking string inside
 *  a code sample is never mistaken for the real thing. */
/**
 * Lines inside an HTML comment, which markdown renders as nothing and which a
 * reader therefore reasonably expects to *be* nothing.
 *
 * Commenting a task out is how people defer one without deleting it, and the
 * template Weekfit writes into a fresh weekly note puts its worked examples in
 * a comment for exactly that reason. Without this, a brand-new vault's very
 * first "Fit this week" would try to schedule the instructions — and anyone
 * who ever parked a task behind `<!-- -->` would find it still being planned.
 *
 * Same shape as `fenceMask`: the delimiter lines count as inside, and a
 * comment opened and closed on one line masks only that line. An unterminated
 * comment masks to end of file, which matches how a renderer treats it.
 */
function commentMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let inComment = false;
  for (const line of lines) {
    if (inComment) {
      mask.push(true);
      if (line.includes('-->')) inComment = false;
      continue;
    }
    const open = line.indexOf('<!--');
    if (open < 0) {
      mask.push(false);
      continue;
    }
    // Opened here. Closed on the same line means only this line is masked.
    mask.push(true);
    if (line.indexOf('-->', open + 4) < 0) inComment = true;
  }
  return mask;
}

/** Fenced code and HTML comments together — the two places a line that looks
 *  like a task is not one. */
function skipMask(lines: string[]): boolean[] {
  const fence = fenceMask(lines);
  const comment = commentMask(lines);
  return fence.map((f, i) => f || comment[i]);
}

function fenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let inFence = false;
  for (const line of lines) {
    if (isFenceDelimiter(line)) {
      mask.push(true); // the delimiter line itself is part of the fenced region
      inFence = !inFence;
      continue;
    }
    mask.push(inFence);
  }
  return mask;
}

// ---------------------------------------------------------------------------
// parseSections
// ---------------------------------------------------------------------------

export interface SectionRange {
  /** First line of the section's body (0-indexed), i.e. just after the
   *  heading line itself. */
  start: number;
  /** Last line of the section's body (0-indexed, inclusive) — the line before
   *  the next heading, or the note's last line. */
  end: number;
}

/** Level 2 through 6 headings — `## Tasks`, `### Tasks`, and so on. The weekly
 *  note convention is `##`, but callers are asked to tolerate `###` (a note
 *  hand-edited under a heading one level too deep shouldn't lose its tasks),
 *  so anything from `##` down is treated as a section boundary. A bare `#`
 *  (the note's title) is deliberately not a boundary — it would otherwise
 *  make the *whole file* one section. */
const HEADING_RE = /^\s{0,3}#{2,6}\s+(.+?)\s*$/;

/**
 * Line ranges for each `##`+ heading in `content`, keyed by the heading text
 * lowercased and trimmed (`"Intentions"` and `"intentions"` collide on
 * purpose — matching is meant to be case-insensitive one level up, in
 * `vaultRepo`).
 *
 * The first occurrence of a given heading text wins; a note with two
 * `## Tasks` sections (unusual, but not impossible) keeps the first one's
 * range rather than silently overwriting it.
 */
export function parseSections(content: string): Record<string, SectionRange> {
  const lines = splitLines(content);
  const fenced = skipMask(lines);
  const headings: { key: string; line: number }[] = [];

  lines.forEach((line, i) => {
    if (fenced[i]) return;
    const m = HEADING_RE.exec(line);
    if (m) headings.push({ key: m[1].trim().toLowerCase(), line: i });
  });

  const out: Record<string, SectionRange> = {};
  headings.forEach((h, idx) => {
    if (h.key in out) return; // first occurrence wins
    const start = h.line + 1;
    const end = idx + 1 < headings.length ? headings[idx + 1].line - 1 : lines.length - 1;
    out[h.key] = { start, end };
  });
  return out;
}

// ---------------------------------------------------------------------------
// parseTasksIn
// ---------------------------------------------------------------------------

/**
 * Checkbox lines in `content` between line `from` and `to` (0-indexed,
 * inclusive, clamped to the file's actual bounds). `text` is the raw line —
 * indentation and the `- [ ] ` prefix included — because that's what
 * `lib/taskmeta.ts` and everything built on it (`lib/duration.ts`,
 * `lib/gaps.ts`) expect: they strip the checkbox themselves.
 */
export function parseTasksIn(content: string, file: string, from: number, to: number): VaultTask[] {
  const lines = splitLines(content);
  // Masked over the *whole* document rather than the slice, so a fence or a
  // comment opened above `from` still counts as open inside it. Indices stay
  // document-absolute, which is what `VaultTask.line` means.
  const skip = skipMask(lines);
  const out: VaultTask[] = [];
  const start = Math.max(0, from);
  const end = Math.min(lines.length - 1, to);
  for (let i = start; i <= end; i++) {
    if (skip[i]) continue;
    const m = CHECKBOX_LINE_RE.exec(lines[i]);
    if (!m) continue;
    out.push({ text: lines[i], done: m[1].toLowerCase() === 'x', file, line: i });
  }
  return out;
}

// ---------------------------------------------------------------------------
// sweepTagged
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strips `[[wikilinks]]` (including a piped `[[Note|alias]]` or a heading
 *  link `[[Note#thisweek]]`) before the tag test runs, so a link that happens
 *  to end in something tag-shaped is never swept. */
function stripWikilinks(line: string): string {
  return line.replace(/\[\[[^\]]*\]\]/g, '');
}

/**
 * Checkbox lines anywhere in `content` carrying `#tag` (default caller passes
 * `"thisweek"`, no leading `#`). A tag is only a match at a word boundary —
 * `#thisweek` matches, `#thisweekend` doesn't — and never inside a fenced
 * code block or a `[[wikilink]]`.
 */
export function sweepTagged(content: string, file: string, tag: string): VaultTask[] {
  const lines = splitLines(content);
  const fenced = skipMask(lines);
  const tagRe = new RegExp(`#${escapeRegExp(tag)}(?![\\w/-])`, 'i');

  const out: VaultTask[] = [];
  lines.forEach((line, i) => {
    if (fenced[i]) return;
    const m = CHECKBOX_LINE_RE.exec(line);
    if (!m) return;
    if (!tagRe.test(stripWikilinks(line))) return;
    out.push({ text: line, done: m[1].toLowerCase() === 'x', file, line: i });
  });
  return out;
}

// ---------------------------------------------------------------------------
// scheduledEvents
// ---------------------------------------------------------------------------

export interface ScheduledEventsResult {
  events: CalEvent[];
  /**
   * The raw task line each event in `events` came from, index-aligned:
   * `events[i]` came from `lines[i]`. A line that never became an event
   * (undated, fenced, malformed, outside the week) is never pushed to either
   * array, so a skip never shifts the alignment between the two.
   */
  lines: VaultTask[];
  /** Timed lines (`HH:MM - HH:MM …`) that couldn't be placed on any day —
   *  no note date and no `⏳`/`[scheduled::]` field. Counted, not thrown. */
  unresolved: number;
}

/** `09:00` -> 540. Returns null for anything outside a real clock (so `24:00`
 *  and `23:60` are rejected without throwing) rather than wrapping. */
function parseClock(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  if (!Number.isInteger(mm) || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

/**
 * Day Planner (`HH:MM - HH:MM …`) lines in `content`, turned into `CalEvent`s
 * — the same shape `computeGaps`/`fitTasks` take for real calendar events, so
 * a commitment already written in the vault blocks a gap with no change to
 * the engine.
 *
 * Which day a line lands on, in order:
 *   1. `noteDate` — the note is a daily note, so its own date wins.
 *   2. a `⏳ 2026-09-04` / `[scheduled:: 2026-09-04]` field on the line.
 *   3. neither: the line is counted in `unresolved` and dropped.
 *
 * A line whose resolved day falls outside `weekStart`'s week (or whose time
 * range is malformed — `24:00`, `9:5`, an end before its start) is dropped
 * silently: it is not a parse failure, just not this week's event.
 */
export function scheduledEvents(
  content: string,
  file: string,
  noteDate: Date | null,
  weekStart: Date,
): ScheduledEventsResult {
  const lines = splitLines(content);
  const fenced = skipMask(lines);
  const events: CalEvent[] = [];
  const eventLines: VaultTask[] = [];
  let unresolved = 0;

  lines.forEach((line, i) => {
    if (fenced[i]) return;
    const cb = CHECKBOX_LINE_RE.exec(line);
    if (!cb) return;
    const body = cb[2];

    const dp = DAY_PLANNER_RE.exec(body);
    if (!dp) return; // not a Day Planner line at all — nothing to resolve

    const startMin = parseClock(dp[1]);
    const endMin = parseClock(dp[2]);
    if (startMin == null || endMin == null || endMin <= startMin) return; // malformed; ignore

    let day: Date | null = noteDate;
    if (!day) {
      const scheduled = parseTaskMeta(body).dates.scheduled?.date ?? null;
      if (scheduled) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(scheduled);
        if (m) day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      }
    }

    if (!day) {
      unresolved++;
      return;
    }

    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
    start.setMinutes(startMin);
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
    end.setMinutes(endMin);

    const di = dayIndex(start, weekStart);
    if (di < 0 || di > 6) return; // outside the rendered week

    const title = taskTitle(body.slice(dp[0].length));
    events.push({
      uid: `${file}:${i}`,
      title,
      start,
      end,
      allDay: false,
      source: formatSource(file, i),
    });
    eventLines.push({ text: line, done: cb[1].toLowerCase() === 'x', file, line: i });
  });

  return { events, lines: eventLines, unresolved };
}

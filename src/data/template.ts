/**
 * The weekly note Weekfit expects, as a string.
 *
 * This exists because of the actual day-one wall. A vault that has never heard
 * of this plugin has no weekly note, so the view opens empty and says "no
 * weekly note for this week yet" — which tells the user what is missing but
 * not that they now have to build a three-heading structure by hand before
 * anything works. One command that writes this file is the difference between
 * "install and start" and "install, read the README, then start".
 *
 * Pure: it returns text. Creating the file is the writer's job.
 */
import { isoWeekId, addDays, startOfISOWeek } from '../lib/week';

/** `YYYY-MM-DD`, local time — the calendar date, not an instant, matching how
 *  every other date in this codebase is written. */
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

export interface WeeklyNoteOptions {
  /** Include the commented example task lines. On by default for a first
   *  note — they're the fastest way to learn the syntax is optional — and off
   *  once the user plainly doesn't need telling. */
  withExamples?: boolean;
}

/**
 * The three `##` sections the parser reads, in the order the vault convention
 * fixes them, plus the frontmatter the dashboard and Obsidian Bases read.
 *
 * Deliberately **no instructional prose in the body**: the sections are parsed
 * by heading, and a note full of guidance is a note the user has to clean up
 * before it's theirs. The examples that do appear are HTML comments, so they
 * render as nothing and parse as nothing — a checkbox in the guidance would
 * otherwise show up as a real task in the rail on first run, which is exactly
 * the kind of thing that makes a tool feel like it doesn't respect your notes.
 */
export function weeklyNoteTemplate(weekStartIn: Date, opts: WeeklyNoteOptions = {}): string {
  const weekStart = startOfISOWeek(weekStartIn);
  const weekId = isoWeekId(weekStart);
  const range = `${iso(weekStart)}/${iso(addDays(weekStart, 6))}`;

  const examples = opts.withExamples === false ? '' : `<!--
Anything under ## Tasks becomes a task Weekfit can place. A plain line works:

  - [ ] Book dentist

...and it gets a size from the duration defaults for its #tag, or the global
fallback. Nothing here is required. If you do want to be specific, Weekfit
reads the Obsidian Tasks standard in either flavour, plus ~90m for a duration:

  - [ ] Edit the VOD ~90m 📅 2026-09-04 🔼 #content
  - [ ] Write newsletter [est:: 45m] [due:: 2026-09-03]

Tag a task #thisweek anywhere else in your vault and it shows up here too.
Delete this comment whenever you like.
-->

`;

  return `---
week: ${weekId}
range: ${range}
status: planning
---

## Intentions

## Tasks

${examples}## Review
`;
}

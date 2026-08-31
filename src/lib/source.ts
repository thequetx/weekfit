// Where a block came from — Phase 5 §5, "event ⇄ note links".
//
// Before this, scheduling a task threw its origin away: the Google event was a
// title string and nothing more, so the board could book work out of the vault
// but never say anything back to the line it booked. Three small pieces close
// that loop:
//
//   `<path>#L<line>`  the anchor stamped on the event (`wdSource`)
//   `obsidian://…`    the URI that opens that note at that line
//   `09:00 - 10:30 …` the Day Planner line written into the weekly note
//
// All pure — the IPC and `shell.openExternal` live at the edges.

/** A parsed `wdSource`. `line` is 0-indexed, matching `VaultTask.line`. */
export interface TaskSource {
  file: string;
  line: number;
}

/**
 * `Weekly/2026-W36.md#L12`.
 *
 * The line number is part of the anchor because a weekly note holds a dozen
 * near-identical `- [ ]` lines and the path alone can't tell them apart. It is
 * a *hint*, not an identity: lines move when a note is edited, so every reader
 * checks the line still looks like the task before writing to it.
 */
export function formatSource(file: string, line: number): string {
  return `${String(file).replace(/\\/g, '/')}#L${Math.max(0, Math.round(line))}`;
}

export function parseSource(source: string | undefined | null): TaskSource | null {
  if (!source) return null;
  const m = /^(.*?)#L(\d+)$/.exec(String(source));
  if (!m || !m[1]) return null;
  return { file: m[1], line: Number(m[2]) };
}

/**
 * `obsidian://open?vault=quetx&file=Weekly%2F2026-W36`.
 *
 * `encodeURIComponent` rather than `encodeURI`: the path separator has to
 * survive as `%2F` and vault paths contain spaces (`Claude Conversations/…`),
 * which `encodeURI` leaves as literal spaces and the handler then truncates at.
 *
 * The `.md` extension is dropped because Obsidian addresses notes by name, and
 * a trailing extension makes it miss on some vault configurations. There is no
 * line-anchor parameter in the `open` action — Obsidian's URI scheme has none —
 * so the note opens at the top; the line lives in the tooltip instead of
 * pretending to be a jump target.
 */
export function obsidianUri(vaultName: string, file: string): string {
  const noteName = String(file)
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '');
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(
    noteName,
  )}`;
}

/** `09:00`, from minutes since midnight. */
function hhmm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * The Day Planner plugin's line shape: `- [ ] 09:00 - 10:30 Fix badge alpha`.
 *
 * This is the nearest thing Obsidian has to an agreed timeblocking convention,
 * so writing it is what makes the week's plan legible **in the vault** — plain
 * text, queryable by Tasks, renderable by Day Planner — rather than existing
 * only inside Google and this app.
 *
 * It is a **placement, not an estimate**: `~90m` says how big a job is, this
 * says when it's happening. They coexist on one line, and `lib/taskmeta.ts`
 * leaves the time range alone (it is not one of the standard's fields), so a
 * round trip through the parser keeps it in the title rather than eating it.
 */
export function dayPlannerRange(startMin: number, endMin: number): string {
  return `${hhmm(startMin)} - ${hhmm(endMin)}`;
}

/** Matches a leading Day Planner range on a task line's *body*, so one can be
 *  replaced rather than stacked when a block is rescheduled. */
export const DAY_PLANNER_RE = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+/;

/**
 * Is this line's work already placed in the week?
 *
 * A leading Day Planner range is the one scheduling signal every tool here
 * shares: this app writes one when it schedules (Phase 5 §5), the Weekfit
 * plugin writes one from inside Obsidian, and a human can type one. Unlike a
 * calendar event it needs no calendar, and unlike a `wdTaskId` it survives
 * being retyped.
 *
 * It lives here, exported, because bug #30 was the engine and the rail
 * answering this question differently — `fitTasks` correctly refused to
 * propose placed work while the rail went on calling it unscheduled. One
 * predicate, both callers.
 */
export function isPlaced(text: string): boolean {
  // The vault hands over a task line with its list marker and checkbox already
  // stripped, so the range — if there is one — is at the front of this string.
  return DAY_PLANNER_RE.test(String(text ?? '').trimStart());
}

/**
 * Put `range` at the front of a task line's text, replacing any range already
 * there. Rescheduling the same task twice must not produce
 * `09:00 - 10:30 11:00 - 12:00 Fix badge alpha`.
 */
export function withDayPlannerRange(text: string, range: string | null): string {
  const body = String(text ?? '').replace(DAY_PLANNER_RE, '');
  return range ? `${range} ${body}` : body;
}

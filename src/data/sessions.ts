/**
 * "Is this task actually scheduled?" — including the case where its time lives
 * on child lines rather than on its own.
 *
 * Splitting writes a task's sittings as **indented children** beneath a parent
 * that deliberately keeps its estimate and gains no time range of its own. So
 * `hasPlacement(parent.text)` is false, and anything deciding "unscheduled"
 * from the parent line alone — the rail did, and so did the fit engine's input
 * — calls a fully scheduled task unscheduled. The rail then lists work that is
 * plainly on the grid beside it, which is a contradiction the user can see.
 *
 * Recognition is structural and deliberately narrow, matching
 * `replaceChildSessions` in `writer.ts`: a child is a scheduled line in the
 * same file, on the line immediately after the parent, indented deeper than
 * it. Children are always written as a contiguous run starting at parent + 1,
 * so the first one is enough to answer the question — and requiring deeper
 * indentation means an ordinary scheduled sibling underneath a task is never
 * mistaken for one of its sittings.
 */
import type { VaultTask } from '../lib/types';

/** Leading whitespace width, tabs counted as one. Only ever compared between
 *  two lines of the same file, so the unit does not matter. */
function indentOf(text: string): number {
  const m = /^[ \t]*/.exec(text);
  return m ? m[0].length : 0;
}

/**
 * Does `task` have its time on child lines?
 *
 * `scheduledLines` is `WeekSnapshot.scheduledLines` — the raw task lines behind
 * the week's scheduled blocks, so a line appearing there is by definition one
 * that carries a time range.
 */
export function hasScheduledSessions(task: VaultTask, scheduledLines: VaultTask[]): boolean {
  const parentIndent = indentOf(task.text);
  return scheduledLines.some(
    (child) =>
      child.file === task.file &&
      child.line === task.line + 1 &&
      indentOf(child.text) > parentIndent,
  );
}

/**
 * The single definition of "unscheduled", so the rail and the fit engine can
 * never disagree about it again — they had drifted, which is what surfaced
 * this whole problem.
 */
export function isUnscheduled(
  task: VaultTask,
  scheduledLines: VaultTask[],
  hasOwnPlacement: (text: string) => boolean,
): boolean {
  return !task.done && !hasOwnPlacement(task.text) && !hasScheduledSessions(task, scheduledLines);
}

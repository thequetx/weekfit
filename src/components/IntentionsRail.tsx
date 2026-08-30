import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { fmtEstimate, resolveTaskDuration } from '../lib/duration';
import type { TaskDuration } from '../lib/duration';
import { PRIORITY_EMOJI, compareMeta, fmtDue, isOverdue, parseTaskMeta } from '../lib/taskmeta';
import type { TaskMeta } from '../lib/taskmeta';
import { hasPlacement } from '../data/dayplanner';
import type { DurationMap, VaultTask } from '../lib/types';

/** Phase 2 seam — a proposed placement from "Fit this week". Never populated
 *  in Phase 1; kept here only so the prop shape doesn't have to change when
 *  Phase 2 wires ghosts in. */
export interface RailProposal {
  groupKey: string;
}

export interface IntentionsRailProps {
  /** `snapshot.tasks` concat `snapshot.thisweek` — the two sources the
   *  desktop app's rail always drew from one list. Filtering (done, already
   *  scheduled) and sorting happen in here, same as it did there. */
  tasks: VaultTask[];
  durations: DurationMap;
  /** Phase 2 seam: proposals to draw beside their task. Always `[]` in
   *  Phase 1 — nothing produces one yet. */
  proposals?: RailProposal[];
  /** Phase 2 seam: accept one proposal group. Never invoked in Phase 1 —
   *  there is no commit flow to invoke it. */
  onAccept?: (groupKey: string) => void;
  /**
   * The weekly note backing the week on screen, so a row swept from somewhere
   * else can say so. `null` when the week has no note yet — in which case
   * every row is from elsewhere and labelling them all would be noise.
   */
  weeklyNotePath?: string | null;
  /** Open the task's own line in its note. */
  onOpenTask?: (task: VaultTask) => void;
  /** Tick it. The rail is where an unscheduled task lives, so it should be
   *  where it can be finished. */
  onToggleDone?: (task: VaultTask) => void;
  /** Begin dragging a task onto the grid to place it by hand — the manual
   *  counterpart to "Fit this week". `minutes` is its resolved duration, which
   *  the grid needs to size the block it is about to draw. */
  onDragStart?: (task: VaultTask, minutes: number, e: ReactPointerEvent) => void;
  /** Right-click. The caller builds an Obsidian `Menu`; the rail only reports
   *  which row and where. */
  onContextMenu?: (task: VaultTask, e: ReactMouseEvent) => void;
}

/** Today, in the machine's local timezone, as `YYYY-MM-DD` — what a task's
 *  `📅` is compared against. Calendar date, not an instant, so this is
 *  deliberately not UTC. */
function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

const ESTIMATE_HINT: Record<TaskDuration['source'], string> = {
  override: 'estimate written on the task',
  kind: 'default for this kind of task',
  default: 'global fallback — no tag, no estimate',
};

interface RailRow {
  t: VaultTask;
  meta: TaskMeta;
  est: TaskDuration;
}

/**
 * The Phase 1 rail: the unscheduled task list, and nothing else.
 *
 * Ported from week-dashboard's `IntentionsRail.tsx` (864 lines) — of which
 * only the `TaskItem` row and the sort/filter logic around it survive here,
 * maybe a tenth of the original by line count. Everything else there was a
 * write path or a later-phase feature this plugin doesn't have yet: the
 * Backlog tab, "Fit this week" and its ghost panel, focus-session controls,
 * roll/review, streaks, the committed/free footer, the refit offer. All of
 * that reads or writes the vault, the calendar, or both — none of it belongs
 * in a read-only Phase 1.
 *
 * "Unscheduled" means: not done, and not already carrying a Day Planner
 * range — a line already placed on the grid doesn't need
 * to also sit in the rail asking to be placed.
 */
export function IntentionsRail({
  tasks,
  durations,
  weeklyNotePath = null,
  onOpenTask,
  onToggleDone,
  onDragStart,
  onContextMenu,
}: IntentionsRailProps) {
  const today = todayIso();

  const rows: RailRow[] = tasks
    .filter((t) => !t.done && !hasPlacement(t.text))
    .map((t) => ({
      t,
      meta: parseTaskMeta(t.text),
      est: resolveTaskDuration(t.text, durations),
    }))
    .sort((a, b) => compareMeta(a.meta, b.meta));

  return (
    <aside className="weekfit-rail">
      <h2 className="weekfit-rail__heading">Unscheduled</h2>
      {rows.length === 0 ? (
        <p className="weekfit-rail__empty">
          Nothing waiting — add a line under the weekly note's <code>## Tasks</code>, or tag one{' '}
          <code>#thisweek</code>.
        </p>
      ) : (
        <ul className="weekfit-rail__list">
          {rows.map(({ t, meta, est }) => {
            const due = meta.dates.due ?? null;
            const overdue = Boolean(due && isOverdue(meta, today));
            // A guess, not a statement: anything that didn't come from an
            // explicit estimate on the line itself. This is the plugin's
            // quiet adoption feature (Phase 1B §3) — the marker is what lets
            // the user tell "I said 90m" apart from "the plugin guessed 90m".
            const guessed = est.source !== 'override';
            // Where this task actually lives. Rail rows come from the weekly
            // note *and* from `#thisweek` lines swept out of other files, and
            // until you can act on a row that difference is invisible and
            // harmless. The moment ticking or scheduling one writes to a file,
            // it stops being harmless: the row has to say where it will write.
            const foreign = weeklyNotePath != null && t.file !== weeklyNotePath;
            const shortSource = t.file.replace(/\.md$/, '').split('/').slice(-2).join('/');

            return (
              <li
                key={`${t.file}:${t.line}`}
                className="weekfit-rail__item"
                onContextMenu={(e) => onContextMenu?.(t, e)}
              >
                <button
                  type="button"
                  className="weekfit-rail__check"
                  aria-label={`Mark "${meta.title}" done`}
                  title="Mark done"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onToggleDone?.(t)}
                />
                {meta.priority && (
                  <span
                    className={`weekfit-rail__pri weekfit-rail__pri--${meta.priority.level}`}
                    title={`${meta.priority.level} priority`}
                  >
                    {PRIORITY_EMOJI[meta.priority.level]}
                  </span>
                )}
                <span
                  className="weekfit-rail__title"
                  role="button"
                  tabIndex={0}
                  title={`${t.file}:${t.line + 1} — click to open, or drag onto the week`}
                  onPointerDown={(e) => onDragStart?.(t, est.minutes, e)}
                  onClick={() => onOpenTask?.(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenTask?.(t);
                    }
                  }}
                >
                  {meta.title}
                </span>
                {foreign && (
                  <span className="weekfit-rail__source" title={t.file}>
                    {shortSource}
                  </span>
                )}
                {due && (
                  <span
                    className={`weekfit-rail__due${overdue ? ' weekfit-rail__due--overdue' : ''}`}
                    title={`due ${due.date}${overdue ? ' — overdue' : ''}`}
                  >
                    {fmtDue(due.date)}
                  </span>
                )}
                <span
                  className={`weekfit-rail__est weekfit-rail__est--${est.source}`}
                  title={`${fmtEstimate(est.minutes)} — ${
                    est.kind ? `#${est.kind} ` : ''
                  }${ESTIMATE_HINT[est.source]}`}
                >
                  {guessed && (
                    <span className="weekfit-rail__est-guess" aria-hidden="true">
                      ≈
                    </span>
                  )}
                  {fmtEstimate(est.minutes)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

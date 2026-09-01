import { useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { PRIORITY_GLYPH, priorityLabel } from './priority';
import { fmtEstimate, resolveTaskDuration } from '../lib/duration';
import type { TaskDuration } from '../lib/duration';
import { compareMeta, fmtDue, isOverdue, parseTaskMeta } from '../lib/taskmeta';
import type { TaskMeta } from '../lib/taskmeta';
import { isRailTask } from '../data/sessions';
import type { CalEvent, DurationMap, VaultTask } from '../lib/types';
import { DAY_NAMES, fmtClock } from '../lib/week';

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
  /** The week's scheduled blocks, resolved to real times — the same array the
   *  grid draws. Used only to label a `scheduled` row with where it landed
   *  (`Tue 2pm`). Optional and defaulted so existing callers and tests need no
   *  change; without it, a scheduled row just says "scheduled". */
  scheduled?: CalEvent[];
  /**
   * The lines behind the week's scheduled blocks. Needed because a task split
   * across sittings carries no time on its own line — its children do — so
   * without this the rail lists work that is plainly on the grid beside it.
   */
    scheduledLines?: VaultTask[];
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
  /**
   * Edit one of the three fields the row already displays.
   *
   * These are deliberately not new buttons. The row is dense, and the due
   * chip, duration chip and priority glyph are already sitting there saying
   * what the values are — so they *become* the controls, which puts the
   * affordance exactly where the information is and adds no visual weight to
   * a resting row. Same division of labour as `onContextMenu`: the rail
   * reports which row and where, the caller opens an Obsidian `Menu`.
   */
  onSetDue?: (task: VaultTask, e: ReactMouseEvent) => void;
  onSetPriority?: (task: VaultTask, e: ReactMouseEvent) => void;
  onSetEstimate?: (task: VaultTask, e: ReactMouseEvent) => void;
}

// A rail row shows what a task is *called*. Two things routinely ride at the
// front of the raw line and are not part of the name:
//   - `#thisweek`, Weekfit's own "pull this into the week" marker
//   - a leading Day Planner range on a swept line that was already placed
// Both are stripped for display only — the line on disk is untouched.
const RAIL_TITLE_NOISE = /^(?:#thisweek\b|\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})\s*/i;

function railTitle(title: string): string {
  let t = title;
  // loop: a swept line can have both, in either order
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(RAIL_TITLE_NOISE, '');
  }
  return t.trim() || title; // never show an empty row
}

/**
 * One of three states for a rail row. `isRailTask` (data/sessions.ts) is the
 * single definition of "unscheduled" — the fit engine's candidate pool uses
 * the very same call (data/planner.ts), so deriving the rail's status from it
 * keeps the rail and the fitter from ever disagreeing about what still needs
 * placing. */
function railStatus(t: VaultTask, scheduledLines: VaultTask[]): RailStatus {
  if (t.done) return 'done';
  return isRailTask(t, scheduledLines) ? 'unscheduled' : 'scheduled';
}

/** "Tue 2pm" — the day-of-week and the block's start, in the grid's own clock
 *  format so the rail and the grid never disagree on how a time is written. */
function formatPlacement(ev: CalEvent): string {
  const dow = DAY_NAMES[(ev.start.getDay() + 6) % 7];
   return `${dow} ${fmtClock(ev.start)}`;
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
  default: 'global fallback — no tag, no estimate' };

type RailStatus = 'unscheduled' | 'scheduled' | 'done';

const STATUS_ORDER: Record<RailStatus, number> = { unscheduled: 0, scheduled: 1, done: 2 };

interface RailRow {
  t: VaultTask;
  meta: TaskMeta;
  est: TaskDuration;
  status: RailStatus;
  placement: string | null;
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
  scheduledLines = [],
  scheduled = [],
  weeklyNotePath = null,
  onOpenTask,
  onToggleDone,
  onDragStart,
  onContextMenu,
  onSetDue,
  onSetPriority,
  onSetEstimate }: IntentionsRailProps) {
  const today = todayIso();

// uid is `${file}:${line}` for a vault-line block — the same shape as a row's
// own `${t.file}:${t.line}`, so this Map turns "which row" into "which block".
  const blockByLine = new Map(scheduled.map((e) => [e.uid, e]));

  const rows: RailRow[] = tasks
    .map((t) => {
      const block = blockByLine.get(`${t.file}:${t.line}`);
      return {
        t,
        meta: parseTaskMeta(t.text),
        est: resolveTaskDuration(t.text, durations),
        status: railStatus(t, scheduledLines),
        placement: block ? formatPlacement(block) : null,
      };
    })
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || compareMeta(a.meta, b.meta),
    );

  // B4 — the header filter. Pure view state: nothing outside this component
  // cares which tab is showing. `'all'` shows every row; the other two keep
  // rows whose `status` matches the tab name.
  const [filter, setFilter] = useState<'all' | 'unscheduled' | 'scheduled'>('all');
  const shown = filter === 'all' ? rows : rows.filter((r) => r.status === filter);

  return (
    <aside className="weekfit-rail">
      <h2 className="weekfit-rail__heading">Tasks</h2>
      <div className="weekfit-rail__filter">
        <button
          type="button"
          className={`weekfit-rail__filter-btn${filter === 'all' ? ' weekfit-rail__filter-btn--active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All
        </button>
        <button
          type="button"
          className={`weekfit-rail__filter-btn${filter === 'unscheduled' ? ' weekfit-rail__filter-btn--active' : ''}`}
          onClick={() => setFilter('unscheduled')}
        >
          Unscheduled
        </button>
        <button
          type="button"
          className={`weekfit-rail__filter-btn${filter === 'scheduled' ? ' weekfit-rail__filter-btn--active' : ''}`}
          onClick={() => setFilter('scheduled')}
        >
          Scheduled
        </button>
      </div>
      {shown.length === 0 ? (
       <p className="weekfit-rail__empty">
          Nothing waiting — add a line under the weekly note's <code>## Tasks</code>, or tag one{' '}
          <code>#thisweek</code>.
        </p>
      ) : (
        <ul className="weekfit-rail__list">
          {shown.map(({ t, meta, est, status, placement }) => {
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
            // Only an unscheduled row can be dragged onto the grid — a scheduled
            // one is already placed (dragging it would write a second range),
            // and a done one has nothing to place. Click-to-open still works
            // for all three.
            const canDrag = status === 'unscheduled';

            return (
              <li
                key={`${t.file}:${t.line}`}
                className={`weekfit-rail__item weekfit-rail__item--${status}`}
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
                {/* Always rendered, so the control is in the same place on
                    every row. With no priority written it is a faint dot that
                    only shows on hover or keyboard focus — a resting row looks
                    exactly as it did before any of this existed. */}
                <button
                  type="button"
                  className={`weekfit-rail__pri weekfit-rail__pri--${
                    meta.priority?.level ?? 'unset'
                  }`}
                  title={
                    meta.priority
                      ? `${priorityLabel(meta.priority.level)} — click to change`
                      : 'Set priority'
                  }
                  aria-label={
                    meta.priority
                      ? `Priority: ${priorityLabel(meta.priority.level)}`
                      : `Set priority for "${meta.title}"`
                  }
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => onSetPriority?.(t, e)}
                >
                  {meta.priority ? PRIORITY_GLYPH[meta.priority.level] : '·'}
                </button>
                <span
                  className="weekfit-rail__title"
                  role="button"
                  tabIndex={0}
                  title={
                    canDrag
                      ? `${t.file}:${t.line + 1} — click to open, or drag onto the week`
                      : `${t.file}:${t.line + 1} — click to open`
                  }
                  onPointerDown={canDrag ? (e) => onDragStart?.(t, est.minutes, e) : undefined}
                  onClick={() => onOpenTask?.(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenTask?.(t);
                    }
                  }}
                >
                  {railTitle(meta.title)}
                </span>
                {foreign && (
                  <span className="weekfit-rail__source" title={t.file}>
                    {shortSource}
                  </span>
                )}
                {status === 'scheduled' && (
                  <span className="weekfit-rail__source" title="Where this landed on the week">
                    {placement ?? 'scheduled'}
                  </span>
                )}

                {/* Same again: with no due date this is a `+` that appears on
                    hover, so an undated row is not permanently louder than it
                    used to be for the sake of a control. */}
                <button
                  type="button"
                  className={`weekfit-rail__due${overdue ? ' weekfit-rail__due--overdue' : ''}${
                    due ? '' : ' weekfit-rail__due--unset'
                  }`}
                  title={
                    due
                      ? `Due ${due.date}${overdue ? ' — overdue' : ''}. Click to change.`
                      : 'Set a due date'
                  }
                  aria-label={
                    due
                      ? `Due ${due.date}${overdue ? ', overdue' : ''}`
                      : `Set a due date for "${meta.title}"`
                  }
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => onSetDue?.(t, e)}
                >
                  {due ? fmtDue(due.date) : '+'}
                </button>
                <button
                  type="button"
                  className={`weekfit-rail__est weekfit-rail__est--${est.source}`}
                  title={`${fmtEstimate(est.minutes)} — ${
                    est.kind ? `#${est.kind} ` : ''
                  }${ESTIMATE_HINT[est.source]}. Click to change.`}
                  aria-label={`Duration ${fmtEstimate(est.minutes)}${
                    guessed ? ' (estimated)' : ''
                  } for "${meta.title}"`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => onSetEstimate?.(t, e)}
                >
                  {guessed && (
                    <span className="weekfit-rail__est-guess" aria-hidden="true">
                      ≈
                    </span>
                  )}
                  {fmtEstimate(est.minutes)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

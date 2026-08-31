// The React tree WeekView mounts. Kept in its own file, with no Obsidian
// imports, so it can be rendered directly in a test (see
// test/WeekViewRoot.test.tsx) without needing an Obsidian runtime.

import { useRef, useState } from 'react';
import type { FitState, WeekSnapshot, WeekfitSettings, WriteResult } from '../data/contract';
import { fmtWeekRange } from '../lib/week';
import type { CalEvent, VaultTask } from '../lib/types';
import { icsUidOf } from '../data/icsCapture';
import { WeekGrid } from '../components/WeekGrid';
import { IntentionsRail } from '../components/IntentionsRail';
import { CapacityLine } from '../components/CapacityLine';
import { UnplacedList } from '../components/UnplacedList';
import { WriteResultNotice } from '../components/WriteResultNotice';

export interface WeekViewRootProps {
  /** The week to render, or `null` while the adapter is still reading it. */
  snapshot: WeekSnapshot | null;
  settings: WeekfitSettings;
  now: Date;
  onRefresh: () => void;
  // --- Phase 2C: week navigation -------------------------------------------
  /** Monday of the week being shown — not necessarily the current one. Every
   *  positional calculation in this tree keys off this (or `snapshot.weekStart`,
   *  which the caller keeps in step with it), never off `new Date()`. */
  weekStart: Date;
  isCurrentWeek: boolean;
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onToday: () => void;
  // --- Phase 2: "Fit this week" and the ghosts it produces ---------------
  /** `null` = "Fit this week" hasn't been pressed yet (or its ghosts were
   *  cleared). Non-null even when empty — an empty `proposals` array with a
   *  non-empty `unplaced` is a real, meaningful result. */
  fit: FitState | null;
  /** A fit is being computed right now — disables the button and shows a
   *  pending state, rather than inviting a second press mid-calculation. */
  fitting: boolean;
  /** The result of the most recent accept, or null before the first one. */
  lastWrite: WriteResult | null;
  onFit: () => void;
  onClearFit: () => void;
  onAccept: (groupKey: string) => void;
  onAcceptAll: () => void;
  onDismiss: (groupKey: string) => void;
  onMoveProposal: (groupKey: string, day: number, startMin: number) => void;
  onToggleGaps: () => void;
  /** Seed the week’s note from the empty state. */
  onCreateWeekNote: () => void;
  /** Re-fit blocks that passed with their task still open. */
  onReplan: () => void;
  /** Open the weekly review, where roll-forward lives. */
  onReview: () => void;
  // --- acting on an unscheduled task, without leaving the pane -------------
  /** Open any task's own line in its note — rail rows included, so a row is
   *  never a dead end. */
  onOpenTask: (file: string, line: number) => void;
  /** Tick or untick a task from the rail. */
  onToggleDone: (file: string, line: number, text: string, done: boolean) => void;
  /** Place a rail task by hand at a day and time — the manual counterpart to
   *  "Fit this week". */
  onScheduleTask: (file: string, line: number, text: string, day: number, startMin: number) => void;
  /** Right-click a rail row; the caller builds the menu. */
  onTaskMenu: (file: string, line: number, text: string, x: number, y: number) => void;
  onSetDue: (file: string, line: number, text: string, x: number, y: number) => void;
  onSetPriority: (file: string, line: number, text: string, x: number, y: number) => void;
  onSetEstimate: (file: string, line: number, text: string, x: number, y: number) => void;
  /** Break a placed block into sittings; the caller asks how many. */
  onSplitBlock: (uid: string, x: number, y: number) => void;
  // --- Phase 2C: manipulating a block already on the grid ------------------
  onMoveBlock: (uid: string, day: number, startMin: number) => void;
  onUnschedule: (uid: string) => void;
  onOpenSource: (uid: string) => void;
  // --- Edge-drag resize: top edge re-times start, bottom edge re-times end -
  onResizeBlock: (uid: string, startMin: number, endMin: number) => void;
  onResizeProposal: (groupKey: string, startMin: number, endMin: number) => void;
  // --- Read-only calendar-feed events ---------------------------------------
  /** A read-only ICS block was dragged onto the rail — turns it into a task.
   *  See `WeekGrid`'s `onDropIcsToRail` for the gesture itself. */
  onDropIcsToRail: (ev: CalEvent) => void;
}

/**
 * The week surface: header, 7-day grid, unscheduled-task rail, and — Phase 2 —
 * the "Fit this week" button, its ghost proposals, the capacity line, and
 * what happened on the last accept.
 *
 * Rebuilt from Phase 0's placeholder using week-dashboard's `Planner.tsx`
 * (668 lines) as the shape to follow rather than something to port: Planner
 * is the Electron app's whole-window orchestrator and almost none of that
 * exists yet in a plugin that only reads (now: reads and, via callbacks,
 * proposes into) one week. What's kept from it is the outline — header with
 * the week range, a fit bar, grid, rail beside it.
 *
 * Nothing in this file writes to the vault. `onAccept` / `onAcceptAll` are
 * callbacks the caller wires to the actual write path (Phase 2's other half,
 * built elsewhere) — from here they're just props, same as `onRefresh` always
 * was.
 *
 * Week navigation (Phase 2C): `weekStart` is the week actually being shown —
 * not necessarily the current one, since a week planner's main job is
 * planning *next* week — and every positional read in this tree (the header
 * range, the grid, the now-line) comes from it or from `snapshot.weekStart`,
 * never from `new Date()`. `isCurrentWeek` only ever decides whether the
 * "Today" control is inert; whether the now-line actually shows up is a
 * separate question `WeekGrid` answers itself from `now` against `weekStart`,
 * so navigating away from the current week and back can't leave the two
 * disagreeing.
 */
export function WeekViewRoot({
  snapshot,
  settings,
  now,
  onRefresh,
  weekStart,
  isCurrentWeek,
  onPrevWeek,
  onNextWeek,
  onToday,
  fit,
  fitting,
  lastWrite,
  onFit,
  onClearFit,
  onAccept,
  onAcceptAll,
  onDismiss,
  onMoveProposal,
  onToggleGaps,
  onCreateWeekNote,
  onReplan,
  onReview,
  onOpenTask,
  onToggleDone,
  onScheduleTask,
  onTaskMenu,
  onSetDue,
  onSetPriority,
  onSetEstimate,
  onSplitBlock,
  onMoveBlock,
  onUnschedule,
  onOpenSource,
  onResizeBlock,
  onResizeProposal,
  onDropIcsToRail,
}: WeekViewRootProps) {
  // A single hook, called on every render regardless of which branch below
  // fires — the loading branch returns early, but only after this runs, so
  // the hook order stays stable across a snapshot arriving on a later render.
  const [errorsDismissed, setErrorsDismissed] = useState(false);
  // A task picked up in the rail and not yet dropped. Held here rather than in
  // either child because the gesture starts in one (the rail) and finishes in
  // the other (the grid, which owns the geometry).
  const [incoming, setIncoming] = useState<{ task: VaultTask; minutes: number } | null>(null);
  // The grid owns every drag but has no idea where the rail is, so the
  // hit-test lives here, next to the element it tests.
  const railRef = useRef<HTMLDivElement | null>(null);
  const isOverRail = (clientX: number, clientY: number): boolean => {
    const el = railRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom;
  };

  if (!snapshot) {
    return (
      <div className="weekfit-week-view">
        <header className="weekfit-head">
          <h2 className="weekfit-head__title">Weekfit</h2>
        </header>
        <p className="weekfit-loading">Loading week…</p>
      </div>
    );
  }

  const unscheduledSource = [...snapshot.tasks, ...snapshot.thisweek];
  // An ICS event already captured as a task (a `[ics-uid::]` marker sitting
  // on some line in the snapshot) must stop being drawn as a read-only
  // calendar block once that happens, even though a fresh fetch of the feed
  // itself keeps returning the very same event unchanged. The feed has no
  // idea a task now exists for it; the vault does, so this reads it off the
  // lines the snapshot already carries rather
  // than doing a second vault sweep just to ask the question `readIcsLinks`
  // (vaultRepo.ts) already answers for the refresh command itself.
  const capturedIcsUids = new Set(
    [...snapshot.intentions, ...snapshot.tasks, ...snapshot.thisweek, ...snapshot.scheduledLines]
      .map((t) => icsUidOf(t.text))
      .filter((uid): uid is string => uid != null),
  );
  const showErrors = snapshot.errors.length > 0 && !errorsDismissed;
  // A fit that placed nothing is still a result — but it is not ghosts, and
  // the controls have to tell those apart.
  const hasGhosts = (fit?.proposals.length ?? 0) > 0;
  const hasFitResult = fit != null && (hasGhosts || fit.unplaced.length > 0);
  const showWriteNotice =
    lastWrite != null && (lastWrite.skipped.length > 0 || lastWrite.errors.length > 0);

  return (
    <div className="weekfit-week-view">
      <header className="weekfit-head">
        <div className="weekfit-head__nav">
          <button
            type="button"
            className="weekfit-head__navbtn"
            onClick={onPrevWeek}
            aria-label="Previous week"
          >
            ‹
          </button>
          <span className="weekfit-head__range">{fmtWeekRange(weekStart)}</span>
          <button
            type="button"
            className="weekfit-head__navbtn"
            onClick={onNextWeek}
            aria-label="Next week"
          >
            ›
          </button>
          <button
            type="button"
            className="weekfit-head__navbtn weekfit-head__today"
            onClick={onToday}
            disabled={isCurrentWeek}
            title={isCurrentWeek ? "You're already on the current week" : 'Jump to the current week'}
            aria-label="Go to the current week"
          >
            Today
          </button>
        </div>
        <div className="weekfit-head__right">
          {/* Which note is this week? Until now the header showed only a date
              range, so the relationship between what is on screen and what is
              on disk was left to be inferred — and rail rows can come from
              other files entirely. */}
          {snapshot.notePath ? (
            <button
              type="button"
              className="weekfit-head__note"
              title={`Open ${snapshot.notePath}`}
              onClick={() => onOpenTask(snapshot.notePath as string, 0)}
            >
              {snapshot.notePath}
            </button>
          ) : (
            <span className="weekfit-head__note weekfit-head__note--none">no note yet</span>
          )}
          <button type="button" className="weekfit-head__refresh" onClick={onRefresh}>
            Refresh
          </button>
        </div>
      </header>

      {/* Phase 2 — the button that makes the whole pitch true, the capacity
          line beside it, and the controls for the ghosts it produces. */}
      <div className="weekfit-fitbar">
        <div className="weekfit-fitbar__row">
          <button
            type="button"
            className="weekfit-fitbar__fit"
            onClick={onFit}
            disabled={fitting}
            aria-busy={fitting}
          >
            {fitting ? 'Fitting…' : 'Fit this week'}
          </button>
          {/* Gated on there actually being ghosts, not merely on a fit having
              been run. A fit or a replan that places nothing still returns a
              result object, and offering "Accept all" and "Clear ghosts" over
              an empty board invites the user to act on nothing. `Clear` stays
              while there is an unplaced list, since that is a result worth
              being able to dismiss. */}
          {hasGhosts && (
            <button type="button" className="weekfit-fitbar__acceptall" onClick={onAcceptAll}>
              Accept all
            </button>
          )}
          {hasFitResult && (
            <button type="button" className="weekfit-fitbar__clear" onClick={onClearFit}>
              {hasGhosts ? 'Clear ghosts' : 'Clear'}
            </button>
          )}
          {/* Replan and review were reachable only from the command palette,
              which is no way to surface a weekly ritual — you have to already
              know it exists to search for it. Both are one press from the
              board now. */}
          <button type="button" className="weekfit-fitbar__replan" onClick={onReplan}>
            Replan passed
          </button>
          <button type="button" className="weekfit-fitbar__review" onClick={onReview}>
            Review week&hellip;
          </button>
          <label className="weekfit-fitbar__gaps">
            <input type="checkbox" checked={settings.showGaps} onChange={onToggleGaps} />
            Show gap candidates
          </label>
        </div>
        {fit && <CapacityLine capacity={fit.capacity} />}
      </div>

      {fit && fit.unplaced.length > 0 && <UnplacedList unplaced={fit.unplaced} />}
      {showWriteNotice && lastWrite && <WriteResultNotice result={lastWrite} />}

      {/* Only when there is genuinely nothing to show. A null `notePath` is a
          normal state in `daily` mode — the week can be fully populated from
          daily notes and a "no weekly note" notice over the top of it would be
          both wrong and alarming. */}
      {snapshot.notePath === null &&
        snapshot.tasks.length === 0 &&
        snapshot.thisweek.length === 0 &&
        snapshot.scheduled.length === 0 && (
          // The day-one wall, and the one place worth teaching rather than
          // just reporting. Saying "no weekly note" and stopping leaves the
          // user to work out that they now need a file with three particular
          // headings before anything happens. The button writes it.
          <div className="weekfit-empty">
            <p className="weekfit-empty__lead">Nothing here yet for this week.</p>
            <button type="button" className="weekfit-empty__action" onClick={onCreateWeekNote}>
              Create this week&rsquo;s note
            </button>
            <p className="weekfit-empty__hint">
              It gets three sections &mdash; <code>## Intentions</code>, <code>## Tasks</code> and{' '}
              <code>## Review</code>. Put anything under <code>## Tasks</code>, even a plain{' '}
              <code>- [ ] Book dentist</code>, then press <strong>Fit this week</strong>.
            </p>
          </div>
        )}

      {/* Fitting is the whole point of the plugin, and it can do nothing at
          all without a window. Better said here, where someone is looking at
          an empty board wondering why, than only in a Notice they may have
          already dismissed. */}
      {settings.windows.length === 0 && (
        <p className="weekfit-notice weekfit-notice--quiet">
          No availability windows set, so there is nowhere to fit anything. Add one in Settings
          &rarr; Weekfit &mdash; it is the one setting with no sensible default.
        </p>
      )}

      {showErrors && (
        <div className="weekfit-notice weekfit-notice--error" role="alert">
          <ul className="weekfit-notice__list">
            {snapshot.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <button
            type="button"
            className="weekfit-notice__dismiss"
            onClick={() => setErrorsDismissed(true)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <div className="weekfit-week-view__main">
        <WeekGrid
          weekStart={weekStart}
          now={now}
          scheduled={snapshot.scheduled}
          blocks={settings.blocks}
          gaps={fit ? fit.gaps : null}
          showGaps={settings.showGaps}
          proposals={fit?.proposals ?? []}
          onAccept={onAccept}
          onDismiss={onDismiss}
          onMoveProposal={onMoveProposal}
          onMoveBlock={onMoveBlock}
          onUnschedule={onUnschedule}
          onOpenSource={onOpenSource}
          onResizeBlock={onResizeBlock}
          onResizeProposal={onResizeProposal}
          icsEvents={snapshot.icsEvents}
          capturedIcsUids={capturedIcsUids}
          onDropIcsToRail={onDropIcsToRail}
          incoming={incoming}
          onIncomingEnd={() => setIncoming(null)}
          isOverRail={isOverRail}
          hiddenUid={fit?.replacing ?? null}
          onSplit={onSplitBlock}
          onDropTask={(task, day, startMin) =>
            onScheduleTask(task.file, task.line, task.text, day, startMin)
          }
        />
        <div className="weekfit-railwrap" ref={railRef}>
        <IntentionsRail
          tasks={unscheduledSource}
          durations={settings.durations}
          scheduledLines={snapshot.scheduledLines}
          weeklyNotePath={snapshot.notePath}
          onOpenTask={(t) => onOpenTask(t.file, t.line)}
          onToggleDone={(t) => onToggleDone(t.file, t.line, t.text, !t.done)}
          onContextMenu={(t, e) => {
            e.preventDefault();
            onTaskMenu(t.file, t.line, t.text, e.clientX, e.clientY);
          }}
          onSetDue={(t, e) => onSetDue(t.file, t.line, t.text, e.clientX, e.clientY)}
          onSetPriority={(t, e) => onSetPriority(t.file, t.line, t.text, e.clientX, e.clientY)}
          onSetEstimate={(t, e) => onSetEstimate(t.file, t.line, t.text, e.clientX, e.clientY)}
          onDragStart={(task, minutes) => setIncoming({ task, minutes })}
        />
        </div>
      </div>
    </div>
  );
}

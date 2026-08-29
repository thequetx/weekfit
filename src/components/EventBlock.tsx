import type { PointerEvent } from 'react';
import { yForMinutes } from '../lib/grid';
import { fmtClock, fmtMinutes, minutesOfDay, sameDate } from '../lib/week';
import type { CalEvent } from '../lib/types';

export interface EventBlockProps {
  ev: CalEvent;
  /**
   * Where to draw it — `ev`'s own position (see `eventMinutes` below), or a
   * live drag preview overriding it. Kept apart from `ev` for the same reason
   * `GhostBlock` splits its position from `proposal`: a drag in progress can
   * move the block on screen without the `scheduled` array WeekGrid was
   * handed changing underneath it.
   */
  startMin: number;
  endMin: number;
  dragging: boolean;
  onUnschedule: (uid: string) => void;
  /** Starts the drag. `WeekGrid` takes it from here — once a drag is live it
   *  tracks pointermove/pointerup/pointercancel on `window`, not on this
   *  element (a React pointermove/up prop here would only fire while the
   *  cursor stayed over the block, which is the bug this replaced). */
  onDragStart: (ev: CalEvent, e: PointerEvent<HTMLDivElement>) => void;
}

/**
 * `ev`'s own position on the grid, ignoring any drag preview. Same-day end ->
 * the real end time; a block that runs past midnight -> the bottom of the
 * column, same as always. Exported so `WeekGrid` can read the block's
 * original duration when working out where a drag should land.
 */
export function eventMinutes(ev: CalEvent): { startMin: number; endMin: number } {
  const startMin = minutesOfDay(ev.start);
  const endMin = sameDate(ev.start, ev.end) ? minutesOfDay(ev.end) : 24 * 60;
  return { startMin, endMin };
}

/**
 * One scheduled block on the grid — a Day Planner line already in the vault.
 *
 * Phase 1 cut this to read-only display: no drag, no resize, no delete, no
 * open-source. Phase 2C gives back exactly the parts that make an accepted
 * block something other than furniture:
 *
 *  - **Drag to re-time**, the same mechanism as `GhostBlock` — pointer events
 *    with explicit capture, a 4px threshold separating a drag from a click.
 *    The threshold and the actual re-timing math live in `WeekGrid`, which
 *    owns the drag state for both real blocks and ghosts; this component only
 *    reports the initiating `pointerdown` upward. `WeekGrid` tracks the rest
 *    of the drag on `window`, not on this element.
 *  - **Unschedule**, a plain-language control (never a bare ✕, which reads as
 *    "delete") that hands the task back to the rail.
 *  - **Click opens the source line.** This component only forwards the raw
 *    pointer events; `WeekGrid`'s `onDragEnd` is what tells a click from a
 *    drag (the same 4px threshold) and calls `onOpenSource` only when the
 *    pointer never crossed it, so a drag can never also count as a click.
 *
 * `ev.uid` (`${file}:${line}`) is all any of these callbacks pass back;
 * `main.ts` is what turns that into an actual write or an actual pane.
 *
 * Kept visually and structurally distinct from `GhostBlock` on purpose
 * (`weekfit-ev`, solid border, full opacity, no dashed outline) even though
 * both are draggable now — a ghost must never look committed, and a real
 * block must never look provisional. See the `weekfit-ghost` rules in
 * styles.css for the other half of that contrast.
 */
export function EventBlock({
  ev,
  startMin,
  endMin,
  dragging,
  onUnschedule,
  onDragStart,
}: EventBlockProps) {
  // A `1/1` would be noise, so only a real split counts as linked.
  const linked = Boolean(ev.taskId && ev.session && ev.sessions && ev.sessions > 1);
  const top = yForMinutes(startMin);
  const height = Math.max(yForMinutes(endMin) - top, 18);
  const tight = height < 40;

  const label = `${ev.title} · ${fmtMinutes(startMin)}–${fmtMinutes(endMin)}`;

  return (
    <div
      className={`weekfit-ev${tight ? ' weekfit-ev--tight' : ''}${dragging ? ' weekfit-ev--dragging' : ''}`}
      style={{ top, height }}
      title={ev.description ? `${ev.title}\n\n${ev.description}` : ev.title}
      role="group"
      aria-label={label}
      onPointerDown={(e) => onDragStart(ev, e)}
    >
      <span className="weekfit-ev__time">{fmtClock(ev.start)}</span>
      <span className="weekfit-ev__title">{ev.title}</span>
      {linked && (
        <span
          className="weekfit-ev__ses"
          title={`Session ${ev.session} of ${ev.sessions} for this task`}
        >
          {ev.session}/{ev.sessions}
        </span>
      )}
      <button
        type="button"
        className="weekfit-ev__unschedule"
        aria-label={`Unschedule "${ev.title}"`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onUnschedule(ev.uid);
        }}
      >
        Unschedule
      </button>
    </div>
  );
}

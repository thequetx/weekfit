import type { PointerEvent } from 'react';
import { yForMinutes } from '../lib/grid';
import { fmtClock, fmtMinutes, minutesOfDay, sameDate } from '../lib/week';
import type { CalEvent } from '../lib/types';

export interface IcsEventBlockProps {
  ev: CalEvent;
  /** `ev`'s own position, exactly like `EventBlock`'s `startMin`/`endMin` —
   *  there is no drag preview here, since this block never moves on the grid
   *  (see the class doc comment below), but the caller (`WeekGrid`) still
   *  computes it the same way for both block kinds. */
  startMin: number;
  endMin: number;
  /** A drag onto the rail is in progress for this block — dims it in place,
   *  the same "this is about to leave" cue `.weekfit-ev--dragging` gives a
   *  real block, even though (unlike a real block) it never repositions. */
  dragging: boolean;
  /** Starts the one gesture this block supports: drag onto the rail.
   *  `WeekGrid` tracks the rest on `window`, same discipline as every other
   *  drag in this file. */
  onDragStart: (ev: CalEvent, e: PointerEvent<HTMLDivElement>) => void;
}

/**
 * `ev`'s own position on the grid — same formula as `EventBlock.eventMinutes`,
 * duplicated rather than imported so this file has no dependency on that one
 * (both are leaf components `WeekGrid` composes, not a hierarchy).
 */
export function icsEventMinutes(ev: CalEvent): { startMin: number; endMin: number } {
  const startMin = minutesOfDay(ev.start);
  const endMin = sameDate(ev.start, ev.end) ? minutesOfDay(ev.end) : 24 * 60;
  return { startMin, endMin };
}

/**
 * One calendar-feed event on the grid — informational, not a commitment this
 * plugin owns.
 *
 * Deliberately **read-only**: no resize handles, no re-time drag, no
 * Unschedule/Split controls, no click-to-open (there is no vault line behind
 * it to open). The *only* gesture it supports is being dragged onto the
 * rail — `WeekGrid`'s `onDropIcsToRail` — which is how one of these turns
 * into an actual task (spec §2.4, `data/icsCapture.ts`). Dropped anywhere
 * else on the grid, the drag is simply discarded; the block was never
 * actually moved; there is nothing to snap back from.
 *
 * Styled deliberately muted/outlined (`.weekfit-ev--ics` in styles.css, all
 * custom-property driven so a theme can still restyle it) rather than reusing
 * `.weekfit-ev`'s solid committed look — a calendar event Weekfit didn't book
 * and can't edit must never read as one of this plugin's own blocks.
 */
export function IcsEventBlock({ ev, startMin, endMin, dragging, onDragStart }: IcsEventBlockProps) {
  const top = yForMinutes(startMin);
  const height = Math.max(yForMinutes(endMin) - top, 18);
  const tight = height < 40;

  const label = `${ev.title} · ${fmtMinutes(startMin)}–${fmtMinutes(endMin)} · from your calendar feed, drag onto the task list to add it as a task`;

  return (
    <div
      className={`weekfit-ev weekfit-ev--ics${tight ? ' weekfit-ev--tight' : ''}${dragging ? ' weekfit-ev--dragging' : ''}`}
      style={{ top, height }}
      title={ev.description ? `${ev.title}\n\n${ev.description}` : ev.title}
      role="group"
      aria-label={label}
      onPointerDown={(e) => onDragStart(ev, e)}
    >
      <span className="weekfit-ev__time">{fmtClock(ev.start)}</span>
      <span className="weekfit-ev__title">{ev.title}</span>
    </div>
  );
}

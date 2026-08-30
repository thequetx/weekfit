import type { PointerEvent } from 'react';
import { yForMinutes } from '../lib/grid';
import { canSplit } from '../data/split';
import { fmtClock, fmtMinutes, minutesOfDay, sameDate } from '../lib/week';
import type { CalEvent } from '../lib/types';
import type { ProposalConflict } from '../lib/gaps';

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
  /** A resize (edge-drag) is live on this block right now — distinct from
   *  `dragging` (a move) so the cursor/shadow can read `ns-resize` rather
   *  than `grabbing` while it's happening. */
  resizing: boolean;
  /**
   * What this block (at its *current*, possibly-mid-drag position) sits on
   * top of, from `WeekGrid`'s `proposalConflict` check — `null` when the
   * spot is clear. `CalEvent` itself carries no such field (it's a `lib/`
   * type, ported byte-for-byte); this is WeekGrid's own live computation,
   * handed down as a plain prop instead. Mirrors `Proposal.conflict`
   * (`GhostBlock`) in meaning, kept as a separate prop here since a real
   * block has no `conflict` field of its own to reuse.
   */
  conflict?: ProposalConflict | null;
  onUnschedule: (uid: string) => void;
  /** Break this block into sittings. Absent, or on a block too short to
   *  split, the control simply isn't drawn — a disabled button people cannot
   *  explain to themselves is worse than no button. */
  onSplit?: (uid: string, x: number, y: number) => void;
  /** Starts the drag. `WeekGrid` takes it from here — once a drag is live it
   *  tracks pointermove/pointerup/pointercancel on `window`, not on this
   *  element (a React pointermove/up prop here would only fire while the
   *  cursor stayed over the block, which is the bug this replaced). */
  onDragStart: (ev: CalEvent, e: PointerEvent<HTMLDivElement>) => void;
  /** Starts an edge-drag resize. `WeekGrid` tracks the rest on `window`, the
   *  same as `onDragStart` — see its own doc comment there. The handle's own
   *  `onPointerDown` stops propagation before calling this, so a resize can
   *  never also start a move or (on release) read as the click that opens
   *  the source line. */
  onResizeStart: (ev: CalEvent, edge: 'top' | 'bottom', e: PointerEvent<HTMLDivElement>) => void;
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
 *  - **Edge-drag resize**, two thin handles (`.weekfit-resize`) pinned to the
 *    block's top and bottom edge, each ~6px tall so the middle of the block —
 *    where a move-drag and a click both live — stays untouched. Each handle's
 *    own `onPointerDown` stops the event from bubbling to the block's, so a
 *    resize can never also start a move. Below `SHORT_BLOCK_PX` the top
 *    handle is dropped entirely: on a very short block two 6px zones plus the
 *    Unschedule control would leave no room in the middle to grab or click
 *    the block at all, so only the bottom handle survives and the rest of the
 *    block keeps working as a move/click target.
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
/** Below this height (px) a top *and* bottom resize handle would leave no
 *  room in the middle to move or click the block, so the top handle is
 *  dropped and only the bottom one remains — see the class doc comment. */
const SHORT_BLOCK_PX = 24;

export function EventBlock({
  ev,
  startMin,
  endMin,
  dragging,
  resizing,
  conflict,
  onUnschedule,
  onSplit,
  onDragStart,
  onResizeStart,
}: EventBlockProps) {
  // A `1/1` would be noise, so only a real split counts as linked.
  const linked = Boolean(ev.taskId && ev.session && ev.sessions && ev.sessions > 1);
  const top = yForMinutes(startMin);
  const height = Math.max(yForMinutes(endMin) - top, 18);
  const tight = height < 40;
  const veryShort = height < SHORT_BLOCK_PX;

  // Same wording pattern as `GhostBlock`'s `conflictLabel` — naming *what* it
  // collides with is the whole value here; "conflict" alone tells whoever's
  // reading the tooltip/aria-label nothing they can act on.
  const conflictLabel = conflict
    ? `Overlaps ${conflict.kind === 'skeleton' ? 'the recurring block' : 'the event'} "${conflict.title}"`
    : null;

  const label = conflictLabel
    ? `${ev.title} · ${fmtMinutes(startMin)}–${fmtMinutes(endMin)} · ${conflictLabel}`
    : `${ev.title} · ${fmtMinutes(startMin)}–${fmtMinutes(endMin)}`;

  return (
    <div
      className={`weekfit-ev${tight ? ' weekfit-ev--tight' : ''}${dragging ? ' weekfit-ev--dragging' : ''}${resizing ? ' weekfit-ev--resizing' : ''}${conflict ? ' weekfit-ev--conflict' : ''}`}
      style={{ top, height }}
      title={conflictLabel ?? (ev.description ? `${ev.title}\n\n${ev.description}` : ev.title)}
      role="group"
      aria-label={label}
      onPointerDown={(e) => onDragStart(ev, e)}
    >
      {!veryShort && (
        <div
          className="weekfit-resize weekfit-resize--top"
          aria-hidden="true"
          onPointerDown={(e) => {
            e.stopPropagation();
            onResizeStart(ev, 'top', e);
          }}
        />
      )}
      <div
        className="weekfit-resize weekfit-resize--bottom"
        aria-hidden="true"
        onPointerDown={(e) => {
          e.stopPropagation();
          onResizeStart(ev, 'bottom', e);
        }}
      />
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
      {conflict && (
        <span className="weekfit-ev__conflict" aria-hidden="true">
          ⚠
        </span>
      )}
      {/* Only on a block long enough to become two hour-long sittings. A
          disabled control on a 45-minute block raises a question the block
          itself cannot answer. */}
      {onSplit && canSplit(endMin - startMin) && (
        <button
          type="button"
          className="weekfit-ev__split"
          aria-label={`Split "${ev.title}" into sittings`}
          title="Split into sittings"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onSplit(ev.uid, e.clientX, e.clientY);
          }}
        >
          Split
        </button>
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

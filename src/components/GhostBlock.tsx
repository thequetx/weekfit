import type { PointerEvent } from 'react';
import { yForMinutes } from '../lib/grid';
import { fmtMinutes } from '../lib/week';
import type { Proposal } from '../lib/gaps';

export interface GhostBlockProps {
  proposal: Proposal;
  /**
   * Where to draw it — the proposal's own `day`/`startMin`/`endMin`, or a live
   * drag preview overriding them. Kept apart from `proposal` so a drag in
   * progress can move the ghost on screen without `fit.proposals` (owned by
   * the caller) changing underneath it.
   */
  startMin: number;
  endMin: number;
  dragging: boolean;
  onAccept: (groupKey: string) => void;
  onDismiss: (groupKey: string) => void;
  /** Starts the drag. `WeekGrid` takes it from here — once a drag is live it
   *  tracks pointermove/pointerup/pointercancel on `window`, not on this
   *  element (a React pointermove/up prop here would only fire while the
   *  cursor stayed over the ghost, which is the bug this replaced). */
  onDragStart: (proposal: Proposal, e: PointerEvent<HTMLDivElement>) => void;
}

/**
 * One proposed placement from "Fit this week" — a ghost on the board until
 * Tyler accepts it. Never a commitment: nothing here has touched the vault.
 *
 * Visually distinct from `EventBlock` on purpose (`weekfit-ghost` rather than
 * `weekfit-ev`, dashed border, reduced opacity) so a proposal can never be
 * mistaken for something already scheduled — that confusion is exactly the
 * "ghost-wipe" class of bug this phase's tests exist to catch.
 *
 * Dragging uses pointer events with explicit capture (`setPointerCapture` in
 * `onDragStart`, released implicitly on pointerup/cancel) rather than HTML5
 * drag-and-drop, which behaves badly inside an Obsidian pane. Only the
 * initiating `pointerdown` is handled here — `WeekGrid` tracks the rest of
 * the drag on `window` rather than this element, so it keeps tracking even
 * once the cursor leaves the ghost. The Accept and Dismiss buttons stop
 * their own `pointerdown` from bubbling up to the ghost's handler, so
 * clicking either can never be misread as the start of a drag.
 */
export function GhostBlock({
  proposal,
  startMin,
  endMin,
  dragging,
  onAccept,
  onDismiss,
  onDragStart,
}: GhostBlockProps) {
  const top = yForMinutes(startMin);
  const height = Math.max(yForMinutes(endMin) - top, 20);
  // A `1/1` would be noise — only a real split earns the badge, same rule as
  // EventBlock's session marker.
  const linked = Boolean(proposal.sessions && proposal.sessions > 1);

  const conflictLabel = proposal.conflict
    ? `Overlaps ${proposal.conflict.kind === 'skeleton' ? 'the recurring block' : 'the event'} "${proposal.conflict.title}"`
    : null;

  const label = `${proposal.title} · ${fmtMinutes(startMin)}–${fmtMinutes(endMin)} · proposed, not yet on your calendar`;

  return (
    <div
      className={`weekfit-ghost${dragging ? ' weekfit-ghost--dragging' : ''}${
        proposal.conflict ? ' weekfit-ghost--conflict' : ''
      }`}
      style={{ top, height }}
      data-groupkey={proposal.groupKey}
      role="group"
      aria-label={label}
      title={conflictLabel ?? label}
      onPointerDown={(e) => onDragStart(proposal, e)}
    >
      <span className="weekfit-ghost__time">
        {fmtMinutes(startMin)}–{fmtMinutes(endMin)}
      </span>
      <span className="weekfit-ghost__title">{proposal.title}</span>
      {linked && (
        <span
          className="weekfit-ghost__ses"
          title={`Session ${proposal.session} of ${proposal.sessions} for this task`}
        >
          {proposal.session}/{proposal.sessions}
        </span>
      )}
      {proposal.conflict && (
        <span className="weekfit-ghost__conflict" aria-hidden="true">
          ⚠
        </span>
      )}
      <div className="weekfit-ghost__actions">
        <button
          type="button"
          className="weekfit-ghost__accept"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onAccept(proposal.groupKey)}
        >
          Accept
        </button>
        <button
          type="button"
          className="weekfit-ghost__dismiss"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onDismiss(proposal.groupKey)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

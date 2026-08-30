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
  /** A resize (edge-drag) is live on this ghost right now — see the matching
   *  prop on `EventBlockProps` for why it's kept apart from `dragging`. */
  resizing: boolean;
  onAccept: (groupKey: string) => void;
  onDismiss: (groupKey: string) => void;
  /** Starts the drag. `WeekGrid` takes it from here — once a drag is live it
   *  tracks pointermove/pointerup/pointercancel on `window`, not on this
   *  element (a React pointermove/up prop here would only fire while the
   *  cursor stayed over the ghost, which is the bug this replaced). */
  onDragStart: (proposal: Proposal, e: PointerEvent<HTMLDivElement>) => void;
  /** Starts an edge-drag resize — see `EventBlockProps.onResizeStart`, same
   *  idea for a ghost. */
  onResizeStart: (
    proposal: Proposal,
    edge: 'top' | 'bottom',
    e: PointerEvent<HTMLDivElement>,
  ) => void;
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
 *
 * Edge-drag resize (top/bottom `.weekfit-resize` handles) works the same way,
 * one level down: each handle stops its own `pointerdown` from bubbling to
 * the ghost's move handler, and is dropped below `SHORT_BLOCK_PX` (only the
 * bottom one) for the same "don't cover the whole body" reason as
 * `EventBlock` — see that component's doc comment for the full rationale.
 */
/** See `EventBlock`'s constant of the same name — same reasoning, applied to
 *  the ghost's own minimum rendered height (20px, vs. the real block's 18). */
const SHORT_BLOCK_PX = 24;

/**
 * Below this, the ghost lays out as a row and drops its time label.
 *
 * A ghost has three things to show and, at an hour or less, room for two. The
 * order they matter in is not the order they happened to be written in:
 *
 *  1. **The title.** The only thing the grid cannot tell you by itself.
 *  2. **Accept / Dismiss.** The block's entire purpose; a proposal you can't
 *     act on is just clutter.
 *  3. **The time.** The block's *position on a calendar* already says this,
 *     and the hover title repeats it exactly.
 *
 * It used to be precisely inverted: `__time` had `flex: none` and `__title`
 * did not, so the title was the one thing flexbox was free to crush — and it
 * did, on every ghost of an hour or less. The board ended up asking you to
 * accept an unnamed block. Now the time is what yields.
 *
 * Higher than `EventBlock`'s 40px because a ghost carries two buttons a real
 * block doesn't; one hour (46px) has to land on the tight side of this.
 */
const TIGHT_BLOCK_PX = 56;

export function GhostBlock({
  proposal,
  startMin,
  endMin,
  dragging,
  resizing,
  onAccept,
  onDismiss,
  onDragStart,
  onResizeStart,
}: GhostBlockProps) {
  const top = yForMinutes(startMin);
  const height = Math.max(yForMinutes(endMin) - top, 20);
  const veryShort = height < SHORT_BLOCK_PX;
  const tight = height < TIGHT_BLOCK_PX;
  // A `1/1` would be noise — only a real split earns the badge, same rule as
  // EventBlock's session marker.
  const linked = Boolean(proposal.sessions && proposal.sessions > 1);

  // Spelled out for the tooltip and the accessible name in every case, even
  // when the button itself is down to a single glyph.
  const acceptLabel = linked
    ? `Accept all ${proposal.sessions} sittings of this task`
    : 'Accept this placement';
  const dismissLabel = linked
    ? `Dismiss all ${proposal.sessions} sittings of this task`
    : 'Dismiss this placement';

  const conflictLabel = proposal.conflict
    ? `Overlaps ${proposal.conflict.kind === 'skeleton' ? 'the recurring block' : 'the event'} "${proposal.conflict.title}"`
    : null;

  const label = `${proposal.title} · ${fmtMinutes(startMin)}–${fmtMinutes(endMin)} · proposed, not yet on your calendar`;

  return (
    <div
      className={`weekfit-ghost${tight ? ' weekfit-ghost--tight' : ''}${
        veryShort ? ' weekfit-ghost--escape' : ''
      }${dragging ? ' weekfit-ghost--dragging' : ''}${
        resizing ? ' weekfit-ghost--resizing' : ''
      }${proposal.conflict ? ' weekfit-ghost--conflict' : ''}`}
      style={{ top, height }}
      data-groupkey={proposal.groupKey}
      role="group"
      aria-label={label}
      title={conflictLabel ?? label}
      onPointerDown={(e) => onDragStart(proposal, e)}
    >
      {!veryShort && (
        <div
          className="weekfit-resize weekfit-resize--top"
          aria-hidden="true"
          onPointerDown={(e) => {
            e.stopPropagation();
            onResizeStart(proposal, 'top', e);
          }}
        />
      )}
      <div
        className="weekfit-resize weekfit-resize--bottom"
        aria-hidden="true"
        onPointerDown={(e) => {
          e.stopPropagation();
          onResizeStart(proposal, 'bottom', e);
        }}
      />
      {/* Dropped on a tight ghost — the grid position already says when, and
          the block's own `title`/`aria-label` still spell it out in full. */}
      {!tight && (
        <span className="weekfit-ghost__time">
          {fmtMinutes(startMin)}–{fmtMinutes(endMin)}
        </span>
      )}
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
      {/* On a ghost too short to hold them in flow, the actions are pinned to
          its right edge instead (see `--escape` in styles.css). They were
          previously clipped, which left a 30-minute proposal with no way to
          accept or dismiss it at all.

          Whenever the ghost is laid out as a row — escaped or not — the words
          become a tick and a cross. A day column is about 130px wide and
          "Accept" plus "Dismiss" is most of that, so beside a title they left
          it showing `W…`: technically present, and no more use than absent.
          The accessible name and the tooltip still say "Accept this
          placement" in full. */}
      <div className={`weekfit-ghost__actions${veryShort ? ' weekfit-ghost__actions--escape' : ''}`}>
        <button
          type="button"
          className="weekfit-ghost__accept"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onAccept(proposal.groupKey)}
          title={acceptLabel}
          // Only when the word itself is gone. Setting it unconditionally
          // would replace a perfectly good visible name ("Accept all 3") with
          // a longer one, which is how this broke two existing tests — they
          // were right and it was wrong.
          aria-label={tight ? acceptLabel : undefined}
        >
          {tight ? '✓' : linked ? `Accept all ${proposal.sessions}` : 'Accept'}
        </button>
        <button
          type="button"
          className="weekfit-ghost__dismiss"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onDismiss(proposal.groupKey)}
          title={dismissLabel}
          aria-label={tight ? dismissLabel : undefined}
        >
          {tight ? '✕' : linked ? `Dismiss all ${proposal.sessions}` : 'Dismiss'}
        </button>
      </div>
    </div>
  );
}

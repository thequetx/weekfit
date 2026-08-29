import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { bodyHeight, endHour, gridHours, minutesForY, startHour, yForMinutes } from '../lib/grid';
import { DAY_NAMES, addDays, dayIndex, fmtHourLabel, fmtMinutes, sameDate } from '../lib/week';
import type { CalEvent, SkeletonBlock } from '../lib/types';
import type { Gap, Proposal } from '../lib/gaps';
import { snapToGap } from '../lib/gaps';
import { SNAP_MINUTES, snapToGrid } from '../lib/duration';
import { EventBlock, eventMinutes } from './EventBlock';
import { NowLine } from './NowLine';
import { GhostBlock } from './GhostBlock';

export interface WeekGridProps {
  /** Local midnight on the Monday of the rendered week. */
  weekStart: Date;
  now: Date;
  /** Existing commitments — Day Planner lines already in the vault
   *  (`snapshot.scheduled`). */
  scheduled: CalEvent[];
  /** Recurring structure from settings (`settings.blocks`) — muted, drawn
   *  behind everything else, not interactive. `days` is 0=Monday..6=Sunday. */
  blocks: SkeletonBlock[];
  /**
   * Phase 2 — candidate free intervals, drawn faintly behind everything when
   * `showGaps` is true, and what a drag snaps against. `null` means "Fit this
   * week" hasn't been pressed yet: there is nothing to snap to, so a real
   * block being re-timed falls back to the grid's own 30-minute lattice
   * instead (see `handleEventDragEnd`). An empty array is a different,
   * meaningful state — a fit *ran* and found no free time.
   */
  gaps: Gap[] | null;
  showGaps: boolean;
  /** Phase 2 — ghosts from "Fit this week". Empty in the Phase 1 caller, which
   *  is what keeps this component's Phase 1 behaviour unchanged. */
  proposals: Proposal[];
  onAccept: (groupKey: string) => void;
  onDismiss: (groupKey: string) => void;
  onMoveProposal: (groupKey: string, day: number, startMin: number) => void;
  /** Phase 2C — re-time, remove, or open the source of a block already on the
   *  grid. `uid` is `${file}:${line}`; `main.ts` resolves it. */
  onMoveBlock: (uid: string, day: number, startMin: number) => void;
  onUnschedule: (uid: string) => void;
  onOpenSource: (uid: string) => void;
  /**
   * Edge-drag resize — a block's top edge re-times its start (end fixed), its
   * bottom edge re-times its end (start fixed). Reports only the *final*
   * interval, on pointer-up; the drag's own preview is local state (see
   * `EventResizePreview`/`ProposalResizePreview` below), so this never fires
   * mid-drag. `main.ts` turns a resized real block into a vault write.
   */
  onResizeBlock: (uid: string, startMin: number, endMin: number) => void;
  onResizeProposal: (groupKey: string, startMin: number, endMin: number) => void;
}

interface DragState {
  proposal: Proposal;
  startClientX: number;
  startClientY: number;
  /** A press that never crosses the move threshold is a click on the ghost
   *  (Accept/Dismiss already stop their own pointerdown from reaching here),
   *  not a drag — so it must not call `onMoveProposal` on release. */
  moved: boolean;
  /**
   * Minutes between where the pointer actually grabbed the block and the
   * block's own `startMin`, captured at pointerdown. Every subsequent move
   * subtracts this back off `minutesAt` so the block moves *with* the
   * cursor instead of snapping so its top edge lands under it — without
   * this a grab anywhere but the very top edge makes the block jump on
   * pickup, and a jumped block is what "drifts down, hard to get the
   * cursor back on it" (the reported bug) turned out to be.
   */
  grabOffsetMin: number;
}

interface Preview {
  key: string;
  day: number;
  startMin: number;
}

/** Same shape as `DragState`/`Preview`, but for a real block keyed by `uid`
 *  rather than a ghost keyed by `key`. Kept as separate state from the ghost
 *  drag above rather than unified, since the two land through different
 *  callbacks (`onMoveBlock` vs `onMoveProposal`) and a click on a real block
 *  additionally has to open its source — a ghost never does. */
interface EventDragState {
  ev: CalEvent;
  startClientX: number;
  startClientY: number;
  moved: boolean;
  /** See `DragState.grabOffsetMin` — same idea, for a real block. */
  grabOffsetMin: number;
}

interface EventPreview {
  uid: string;
  day: number;
  startMin: number;
}

/**
 * Which drag gesture (if any) is currently live. `'ghost'`/`'event'` are the
 * pre-existing move-drags; the four `*-resize-*` kinds are this feature — one
 * per (ghost | real block) x (top edge | bottom edge). Deliberately *more
 * kinds of the same state machine* rather than a second boolean/ref pair
 * bolted on beside it: a resize is wired to `window` exactly the way a move
 * is (see the `useEffect` below), for the same reason (correctness must not
 * depend on the pointer staying over the element), so it shares the
 * mechanism rather than re-deriving it.
 */
type DragKind =
  | 'ghost'
  | 'event'
  | 'ghost-resize-top'
  | 'ghost-resize-bottom'
  | 'event-resize-top'
  | 'event-resize-bottom'
  | null;

/** Grid quantum a resized edge snaps to, and — since a block can never be
 *  shorter than one lattice step — the minimum legal duration too. */
const MIN_DURATION_MIN = SNAP_MINUTES;

/**
 * Clamp a moving *top* edge (dragging a block's start): never above the
 * grid's own floor, and never so far down it eats into the fixed bottom edge
 * past the one-lattice-step minimum — which is what would otherwise invert
 * the block (start past end) instead of just shrinking it to its floor.
 * `Math.max(minStart, ...)` on the upper bound guards the degenerate case
 * where the fixed edge itself sits within one step of the grid's top.
 */
function clampTopEdge(raw: number, anchorEndMin: number): number {
  const minStart = startHour * 60;
  const maxStart = Math.max(minStart, anchorEndMin - MIN_DURATION_MIN);
  return Math.min(Math.max(raw, minStart), maxStart);
}

/** Mirror of `clampTopEdge` for a moving *bottom* edge (dragging a block's
 *  end): never below the grid's own ceiling, never so far up it eats into
 *  the fixed top edge past the minimum duration. */
function clampBottomEdge(raw: number, anchorStartMin: number): number {
  const maxEnd = endHour * 60;
  const minEnd = Math.min(maxEnd, anchorStartMin + MIN_DURATION_MIN);
  return Math.max(Math.min(raw, maxEnd), minEnd);
}

/**
 * Resize state for a real block, keyed by `uid`. Mirrors `EventDragState`
 * above but for the edge being dragged rather than the whole block:
 *
 *  - `anchorMin` is the *other* edge — fixed for the whole gesture, exactly
 *    what "top edge changes start, end fixed" means.
 *  - `origEdgeMin` is the moving edge's own value at pointerdown, used both
 *    to seed `grabOffsetMin` (below) and, on pointer-up, to tell "the
 *    gesture landed back where it started" apart from a real resize — a
 *    no-op must not fire `onResizeBlock` (it would be a pointless vault
 *    write for a real block).
 *  - `grabOffsetMin` is `DragState.grabOffsetMin`'s idea applied to a single
 *    edge: minutes between where the pointer grabbed the handle and the edge
 *    itself, so the edge tracks the pointer's *delta* rather than snapping
 *    to sit under the cursor — the same failure mode the move-drag fix above
 *    exists to prevent, and just as real here (the handle is rarely grabbed
 *    at its exact pixel).
 */
interface EventResizeState {
  ev: CalEvent;
  edge: 'top' | 'bottom';
  day: number;
  anchorMin: number;
  origEdgeMin: number;
  grabOffsetMin: number;
}

interface EventResizePreview {
  uid: string;
  startMin: number;
  endMin: number;
}

/** Same shape as `EventResizeState`, for a ghost keyed by `key`/`groupKey`
 *  instead of `uid`. */
interface ProposalResizeState {
  proposal: Proposal;
  edge: 'top' | 'bottom';
  day: number;
  anchorMin: number;
  origEdgeMin: number;
  grabOffsetMin: number;
}

interface ProposalResizePreview {
  key: string;
  startMin: number;
  endMin: number;
}

/**
 * The 7-day week grid.
 *
 * Ported from week-dashboard's `WeekGrid.tsx` (385 lines) and cut down to
 * Phase 1's read-only scope; Phase 2 added back the ghost layer and its drag;
 * Phase 2C adds the same drag back to *real* blocks, plus unschedule and
 * open-source.
 *
 * Dragging (a ghost or a real block) is pointer events, not HTML5
 * drag-and-drop (which behaves badly inside an Obsidian pane): `onPointerDown`
 * on the block starts the drag and captures the pointer, but `pointermove` /
 * `pointerup` / `pointercancel` are then listened for on `window` rather than
 * the block element (see the `useEffect` below) — a React `onPointerMove`
 * prop on the block only fires while the pointer stays over it, and
 * `setPointerCapture` alone wasn't holding in practice, which is what let a
 * fast or upward drag lose tracking entirely. `window` always sees the
 * event regardless of what's under the cursor. A real block additionally
 * has to tell a click from a drag, since clicking (not dragging) it opens the
 * vault line it came from — `moved` on its drag state is exactly the ghost's
 * own click/drag distinction, reused for the same reason.
 *
 * A ghost's drop asks `snapToGap` (pure arithmetic from `lib/gaps.ts`) for the
 * nearest legal slot on the day it landed on; `null` means nothing on that day
 * fits, and the drop is discarded outright — the block's rendered position
 * falls back to its own start, exactly where it was before the drag, because
 * flinging it elsewhere or refusing silently would both be the board deciding
 * for Tyler. A real block follows the same rule once a fit has run (`gaps` is
 * an array); before that (`gaps` is `null`) there is nothing to check
 * legality against, so it snaps to the grid's own 30-minute lattice instead —
 * see `handleEventDragEnd`.
 *
 * Edge-drag resize (both ghost and real block) is the same mechanism —
 * `onPointerDown` on a thin handle at the block's top or bottom edge starts a
 * gesture tracked on `window` for the same reason a move is, and the moving
 * edge preserves its own grab offset the same way a move preserves the
 * block's — extended with two more `dragKind`s per block type (`*-resize-top`
 * / `*-resize-bottom`) rather than a second, parallel machine. It deliberately
 * skips the `snapToGap` legality check a move gets: `computeGaps` marks a
 * scheduled block's own footprint as *busy*, so a block being resized is never
 * inside any gap in the first place, and gating on that would make every
 * resize illegal by construction. A resize is instead clamped to the
 * 30-minute lattice, a one-step minimum duration, and the grid's own bounds —
 * see `clampTopEdge`/`clampBottomEdge` — and then always lands. (Marking the
 * overlap this can create against another block is a known follow-up, not
 * built here.)
 */
export function WeekGrid({
  weekStart,
  now,
  scheduled,
  blocks,
  gaps,
  showGaps,
  proposals,
  onAccept,
  onDismiss,
  onMoveProposal,
  onMoveBlock,
  onUnschedule,
  onOpenSource,
  onResizeBlock,
  onResizeProposal,
}: WeekGridProps) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  // -1..7ish when `now` isn't in this week at all — no column will match it,
  // which is exactly "no now-line" (WeekViewRoot: "only when `now` falls
  // inside the rendered week", computed here from `weekStart`/`now`, never
  // from whether the caller says this is "the current week").
  const nowDayIndex = dayIndex(now, weekStart);
  const gapList = gaps ?? [];

  // Column and body rects, read live during a drag rather than cached, since
  // an Obsidian pane can resize or scroll between pointerdown and pointerup.
  const colRefs = useRef<(HTMLDivElement | null)[]>([]);
  const bodyRefs = useRef<(HTMLDivElement | null)[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const eventDragRef = useRef<EventDragState | null>(null);
  const [eventPreview, setEventPreview] = useState<EventPreview | null>(null);
  const eventResizeRef = useRef<EventResizeState | null>(null);
  const [eventResizePreview, setEventResizePreview] = useState<EventResizePreview | null>(null);
  const ghostResizeRef = useRef<ProposalResizeState | null>(null);
  const [ghostResizePreview, setGhostResizePreview] = useState<ProposalResizePreview | null>(
    null,
  );
  // Which drag (if any) window's pointer listeners are currently wired up
  // for — null the rest of the time. State, not a ref, because attaching and
  // detaching `window` listeners is a side effect that has to run from
  // `useEffect`, and `useEffect` only re-fires when a *state* value it reads
  // changes.
  const [dragKind, setDragKind] = useState<DragKind>(null);

  function dayAt(clientX: number): number {
    let bestIdx = 0;
    let bestDist = Infinity;
    colRefs.current.forEach((el, i) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX < r.right) {
        bestIdx = i;
        bestDist = -1;
        return;
      }
      const dist = clientX < r.left ? r.left - clientX : clientX - r.right;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    });
    return bestIdx;
  }

  function minutesAt(day: number, clientY: number): number {
    const el = bodyRefs.current[day];
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return minutesForY(clientY - r.top);
  }

  /**
   * Where a block's top edge should land given where the pointer is *now*,
   * preserving where inside the block it was originally grabbed.
   *
   * `minutesAt` alone reports the minute under the cursor — using that
   * directly as the block's start (the old bug) pins whatever point you
   * grabbed to the top edge, so the block jumps on pickup. Subtracting
   * `grabOffsetMin` (captured at pointerdown — see `DragState`) undoes that:
   * the block moves by exactly as much as the pointer does.
   *
   * The result is snapped to the 30-minute lattice — `grabOffsetMin` itself
   * is rarely a multiple of 30 (a real event can start at :17), so the raw
   * subtraction usually isn't either — and then clamped so a block can never
   * be dragged off the top or bottom of the grid.
   */
  function grabAdjustedStart(
    day: number,
    clientY: number,
    grabOffsetMin: number,
    durationMin: number,
  ): number {
    const raw = minutesAt(day, clientY) - grabOffsetMin;
    const snapped = snapToGrid(raw);
    const minStart = startHour * 60;
    const maxStart = Math.max(minStart, endHour * 60 - durationMin);
    return Math.min(Math.max(snapped, minStart), maxStart);
  }

  function handleDragStart(proposal: Proposal, e: ReactPointerEvent<HTMLDivElement>) {
    // Optional chaining: real browsers all implement this, but jsdom (the
    // component test environment) doesn't. Kept as belt-and-braces, but
    // correctness never depends on it holding — window listeners (below) are
    // what actually keep the drag tracking regardless of what's under the
    // cursor.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const day = dayAt(e.clientX);
    dragRef.current = {
      proposal,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
      grabOffsetMin: minutesAt(day, e.clientY) - proposal.startMin,
    };
    setDragKind('ghost');
  }

  // Listened for on `window`, not the ghost element — see the doc comment on
  // `WeekGrid` and the `useEffect` below. Native `PointerEvent`s, not React's
  // synthetic ones, since `window.addEventListener` is what delivers them.
  function handleWindowDragMove(e: PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    drag.moved = true;
    const day = dayAt(e.clientX);
    const startMin = grabAdjustedStart(day, e.clientY, drag.grabOffsetMin, drag.proposal.minutes);
    setPreview({ key: drag.proposal.key, day, startMin });
  }

  function handleWindowDragEnd(e: PointerEvent) {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragKind(null);
    setPreview(null);
    if (!drag || !drag.moved) return;

    const day = dayAt(e.clientX);
    const startMin = grabAdjustedStart(day, e.clientY, drag.grabOffsetMin, drag.proposal.minutes);
    // Nothing on that day fits -> leave the ghost exactly where it was: no
    // callback, no fallback to another day. See lib/gaps.ts `snapToGap`.
    const snapped = snapToGap(gapList, day, startMin, drag.proposal.minutes);
    if (snapped) onMoveProposal(drag.proposal.groupKey, snapped.gap.day, snapped.startMin);
  }

  function positionOf(p: Proposal): { day: number; startMin: number; endMin: number } {
    if (preview && preview.key === p.key) {
      return { day: preview.day, startMin: preview.startMin, endMin: preview.startMin + p.minutes };
    }
    if (ghostResizePreview && ghostResizePreview.key === p.key) {
      return { day: p.day, startMin: ghostResizePreview.startMin, endMin: ghostResizePreview.endMin };
    }
    return { day: p.day, startMin: p.startMin, endMin: p.endMin };
  }

  // --- ghost resize: edge-drag re-times start or end, day never changes ----
  //
  // Deliberately its own pair of handlers rather than folded into
  // `handleWindowDragMove`/`handleWindowDragEnd` above: a resize never
  // changes which day the ghost is on (only vertical movement matters), has
  // no click/drag ambiguity to resolve (the handle isn't the click target —
  // `GhostBlock`'s `onDragStart` still owns the middle of the block), and
  // reports through a different callback (`onResizeProposal`, not
  // `onMoveProposal`). What it *does* share is the state machine's shape:
  // `dragKind` gates the same `window`-listener `useEffect` below, and the
  // grab-offset idea is `DragState.grabOffsetMin` applied to a single edge —
  // see `EventResizeState`'s doc comment above (the real-block twin of this)
  // for why that matters.

  function handleGhostResizeStart(
    proposal: Proposal,
    edge: 'top' | 'bottom',
    e: ReactPointerEvent<HTMLDivElement>,
  ) {
    // Belt-and-braces, as with the move-drag's own capture call — correctness
    // never depends on this holding, only on the `window` listeners below.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const origEdgeMin = edge === 'top' ? proposal.startMin : proposal.endMin;
    const anchorMin = edge === 'top' ? proposal.endMin : proposal.startMin;
    ghostResizeRef.current = {
      proposal,
      edge,
      day: proposal.day,
      anchorMin,
      origEdgeMin,
      grabOffsetMin: minutesAt(proposal.day, e.clientY) - origEdgeMin,
    };
    setDragKind(edge === 'top' ? 'ghost-resize-top' : 'ghost-resize-bottom');
  }

  function handleWindowGhostResizeMove(e: PointerEvent) {
    const drag = ghostResizeRef.current;
    if (!drag) return;
    const raw = minutesAt(drag.day, e.clientY) - drag.grabOffsetMin;
    const snapped = snapToGrid(raw);
    if (drag.edge === 'top') {
      const startMin = clampTopEdge(snapped, drag.anchorMin);
      setGhostResizePreview({ key: drag.proposal.key, startMin, endMin: drag.anchorMin });
    } else {
      const endMin = clampBottomEdge(snapped, drag.anchorMin);
      setGhostResizePreview({ key: drag.proposal.key, startMin: drag.anchorMin, endMin });
    }
  }

  function handleWindowGhostResizeEnd(e: PointerEvent) {
    const drag = ghostResizeRef.current;
    ghostResizeRef.current = null;
    setDragKind(null);
    setGhostResizePreview(null);
    if (!drag) return;

    const raw = minutesAt(drag.day, e.clientY) - drag.grabOffsetMin;
    const snapped = snapToGrid(raw);
    // Deliberately *not* gated on `snapToGap`/`gaps` — see the doc comment on
    // `WeekGrid` above (Phase 2C's resize section) for why a resize is exempt
    // from the legality check a move gets: `computeGaps` treats the block's
    // own footprint as busy, so gating here would make every resize illegal.
    if (drag.edge === 'top') {
      const startMin = clampTopEdge(snapped, drag.anchorMin);
      // Landed back where it started -> nothing to report.
      if (startMin !== drag.origEdgeMin) {
        onResizeProposal(drag.proposal.groupKey, startMin, drag.anchorMin);
      }
    } else {
      const endMin = clampBottomEdge(snapped, drag.anchorMin);
      if (endMin !== drag.origEdgeMin) {
        onResizeProposal(drag.proposal.groupKey, drag.anchorMin, endMin);
      }
    }
  }

  // --- real blocks (Phase 2C): drag to re-time, click to open source -------

  function handleEventDragStart(ev: CalEvent, e: ReactPointerEvent<HTMLDivElement>) {
    // See the matching comment in `handleDragStart` above.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const day = dayAt(e.clientX);
    const orig = eventMinutes(ev);
    eventDragRef.current = {
      ev,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
      grabOffsetMin: minutesAt(day, e.clientY) - orig.startMin,
    };
    setDragKind('event');
  }

  // Listened for on `window` — see `handleWindowDragMove` above for why.
  function handleWindowEventDragMove(e: PointerEvent) {
    const drag = eventDragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    drag.moved = true;
    const day = dayAt(e.clientX);
    const orig = eventMinutes(drag.ev);
    const durationMin = Math.max(orig.endMin - orig.startMin, 1);
    const startMin = grabAdjustedStart(day, e.clientY, drag.grabOffsetMin, durationMin);
    setEventPreview({ uid: drag.ev.uid, day, startMin });
  }

  function handleWindowEventDragEnd(e: PointerEvent) {
    const drag = eventDragRef.current;
    eventDragRef.current = null;
    setDragKind(null);
    setEventPreview(null);
    if (!drag) return;

    if (!drag.moved) {
      // Never crossed the threshold -> a click, not a drag. Opens the source
      // line instead of moving anything.
      onOpenSource(drag.ev.uid);
      return;
    }

    const day = dayAt(e.clientX);
    const orig = eventMinutes(drag.ev);
    const durationMin = Math.max(orig.endMin - orig.startMin, 1);
    const startMin = grabAdjustedStart(day, e.clientY, drag.grabOffsetMin, durationMin);

    if (gaps == null) {
      // "Fit this week" hasn't run, so there are no gaps to check legality
      // against — `grabAdjustedStart` already snapped to the grid's
      // 30-minute lattice and clamped to the grid's bounds, the same
      // treatment a freshly-placed block gets everywhere else. Unlike the
      // gap-aware path below, there's nothing to refuse against, so the move
      // always lands.
      onMoveBlock(drag.ev.uid, day, startMin);
      return;
    }

    // A fit has run: hold a re-time to the same legality a ghost's drop
    // does. Nothing on that day fits -> leave the block exactly where it
    // was — no callback at all, same discipline as a ghost's failed drop.
    const snapped = snapToGap(gaps, day, startMin, durationMin);
    if (snapped) onMoveBlock(drag.ev.uid, snapped.gap.day, snapped.startMin);
  }

  /** Which day column `ev` currently belongs in — its own day, or the drag
   *  preview's day while it's the one being dragged. */
  function eventDayOf(ev: CalEvent): number {
    if (eventPreview && eventPreview.uid === ev.uid) return eventPreview.day;
    return dayIndex(ev.start, weekStart);
  }

  function eventPositionOf(ev: CalEvent): { startMin: number; endMin: number } {
    const orig = eventMinutes(ev);
    if (eventPreview && eventPreview.uid === ev.uid) {
      return {
        startMin: eventPreview.startMin,
        endMin: eventPreview.startMin + (orig.endMin - orig.startMin),
      };
    }
    if (eventResizePreview && eventResizePreview.uid === ev.uid) {
      return { startMin: eventResizePreview.startMin, endMin: eventResizePreview.endMin };
    }
    return orig;
  }

  // --- real-block resize: edge-drag re-times start or end ------------------
  //
  // See the matching comment on the ghost-resize handlers above — same
  // reasoning applies here for why this is its own handler pair rather than
  // folded into the move-drag's, just with `onResizeBlock` in place of
  // `onResizeProposal` and no `snapToGap` gate (a resize is exempt from gap
  // legality — see the doc comment on `WeekGrid`).

  function handleEventResizeStart(
    ev: CalEvent,
    edge: 'top' | 'bottom',
    e: ReactPointerEvent<HTMLDivElement>,
  ) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const day = dayIndex(ev.start, weekStart);
    const orig = eventMinutes(ev);
    const origEdgeMin = edge === 'top' ? orig.startMin : orig.endMin;
    const anchorMin = edge === 'top' ? orig.endMin : orig.startMin;
    eventResizeRef.current = {
      ev,
      edge,
      day,
      anchorMin,
      origEdgeMin,
      grabOffsetMin: minutesAt(day, e.clientY) - origEdgeMin,
    };
    setDragKind(edge === 'top' ? 'event-resize-top' : 'event-resize-bottom');
  }

  function handleWindowEventResizeMove(e: PointerEvent) {
    const drag = eventResizeRef.current;
    if (!drag) return;
    const raw = minutesAt(drag.day, e.clientY) - drag.grabOffsetMin;
    const snapped = snapToGrid(raw);
    if (drag.edge === 'top') {
      const startMin = clampTopEdge(snapped, drag.anchorMin);
      setEventResizePreview({ uid: drag.ev.uid, startMin, endMin: drag.anchorMin });
    } else {
      const endMin = clampBottomEdge(snapped, drag.anchorMin);
      setEventResizePreview({ uid: drag.ev.uid, startMin: drag.anchorMin, endMin });
    }
  }

  function handleWindowEventResizeEnd(e: PointerEvent) {
    const drag = eventResizeRef.current;
    eventResizeRef.current = null;
    setDragKind(null);
    setEventResizePreview(null);
    if (!drag) return;

    const raw = minutesAt(drag.day, e.clientY) - drag.grabOffsetMin;
    const snapped = snapToGrid(raw);
    if (drag.edge === 'top') {
      const startMin = clampTopEdge(snapped, drag.anchorMin);
      if (startMin !== drag.origEdgeMin) onResizeBlock(drag.ev.uid, startMin, drag.anchorMin);
    } else {
      const endMin = clampBottomEdge(snapped, drag.anchorMin);
      if (endMin !== drag.origEdgeMin) onResizeBlock(drag.ev.uid, drag.anchorMin, endMin);
    }
  }

  // Wire pointermove/pointerup/pointercancel to `window` for exactly as long
  // as a drag (ghost or real block) is in progress, and nowhere else — a
  // listener left attached past the drag it belonged to is a leak, and in
  // Obsidian a leaked `window` listener survives the pane that registered it
  // being closed. Keying the effect on `dragKind` means React tears the old
  // pair down and stands up the new one whenever a drag starts or ends, and
  // the same cleanup function is what React runs on unmount, so a pane
  // closed mid-drag can't leave anything behind either.
  useEffect(() => {
    if (dragKind === 'ghost') {
      window.addEventListener('pointermove', handleWindowDragMove);
      window.addEventListener('pointerup', handleWindowDragEnd);
      window.addEventListener('pointercancel', handleWindowDragEnd);
      return () => {
        window.removeEventListener('pointermove', handleWindowDragMove);
        window.removeEventListener('pointerup', handleWindowDragEnd);
        window.removeEventListener('pointercancel', handleWindowDragEnd);
      };
    }
    if (dragKind === 'event') {
      window.addEventListener('pointermove', handleWindowEventDragMove);
      window.addEventListener('pointerup', handleWindowEventDragEnd);
      window.addEventListener('pointercancel', handleWindowEventDragEnd);
      return () => {
        window.removeEventListener('pointermove', handleWindowEventDragMove);
        window.removeEventListener('pointerup', handleWindowEventDragEnd);
        window.removeEventListener('pointercancel', handleWindowEventDragEnd);
      };
    }
    if (dragKind === 'event-resize-top' || dragKind === 'event-resize-bottom') {
      window.addEventListener('pointermove', handleWindowEventResizeMove);
      window.addEventListener('pointerup', handleWindowEventResizeEnd);
      window.addEventListener('pointercancel', handleWindowEventResizeEnd);
      return () => {
        window.removeEventListener('pointermove', handleWindowEventResizeMove);
        window.removeEventListener('pointerup', handleWindowEventResizeEnd);
        window.removeEventListener('pointercancel', handleWindowEventResizeEnd);
      };
    }
    if (dragKind === 'ghost-resize-top' || dragKind === 'ghost-resize-bottom') {
      window.addEventListener('pointermove', handleWindowGhostResizeMove);
      window.addEventListener('pointerup', handleWindowGhostResizeEnd);
      window.addEventListener('pointercancel', handleWindowGhostResizeEnd);
      return () => {
        window.removeEventListener('pointermove', handleWindowGhostResizeMove);
        window.removeEventListener('pointerup', handleWindowGhostResizeEnd);
        window.removeEventListener('pointercancel', handleWindowGhostResizeEnd);
      };
    }
    return undefined;
    // Only `dragKind` — every handler above closes over refs (mutated
    // synchronously at pointerdown, before `dragKind` ever flips) and props
    // read fresh at the moment the drag started, which is the behaviour the
    // 4px-threshold click/drag distinction already assumes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragKind]);

  return (
    <div className="weekfit-grid">
      <div className="weekfit-grid__gutter">
        <div className="weekfit-grid__gutterhead" />
        <div className="weekfit-grid__gutterbody" style={{ height: bodyHeight }}>
          {gridHours.map((h) => (
            <div key={h} className="weekfit-grid__hour" style={{ top: yForMinutes(h * 60) }}>
              {fmtHourLabel(h)}
            </div>
          ))}
        </div>
      </div>

      {days.map((day, di) => {
        const dayEvents = scheduled.filter((e) => !e.allDay && eventDayOf(e) === di);
        const allDay = scheduled.filter((e) => e.allDay && dayIndex(e.start, weekStart) === di);
        const dayBlocks = blocks.filter((b) => b.days.includes(di));
        const dayGaps = gapList.filter((g) => g.day === di);
        const dayProposals = proposals.filter((p) => positionOf(p).day === di);
        const isToday = sameDate(day, now);

        return (
          <div
            key={di}
            className={`weekfit-grid__col${isToday ? ' weekfit-grid__col--today' : ''}`}
            data-day={di}
            ref={(el) => {
              colRefs.current[di] = el;
            }}
          >
            <div className="weekfit-grid__colhead">
              <span className="weekfit-grid__dow">{DAY_NAMES[di]}</span>
              <span className="weekfit-grid__date">{day.getDate()}</span>
              {allDay.map((e) => (
                <span key={e.uid} className="weekfit-grid__chip" title={e.title}>
                  {e.title}
                </span>
              ))}
            </div>

            <div
              className="weekfit-grid__body"
              style={{ height: bodyHeight }}
              ref={(el) => {
                bodyRefs.current[di] = el;
              }}
            >
              {gridHours.map((h) => (
                <div key={h}>
                  <div className="weekfit-grid__line" style={{ top: yForMinutes(h * 60) }} />
                  <div
                    className="weekfit-grid__line weekfit-grid__line--half"
                    style={{ top: yForMinutes(h * 60 + 30) }}
                  />
                </div>
              ))}

              {/* Gap candidates — scenery, not controls (Phase 2B §2): no
                  hover state, no click, never in the way of a real block. */}
              {showGaps &&
                dayGaps.map((g, i) => {
                  const top = yForMinutes(g.startMin);
                  const height = Math.max(yForMinutes(g.endMin) - top, 4);
                  return (
                    <div
                      key={`gap-${i}`}
                      className="weekfit-gap"
                      style={{ top, height }}
                      aria-hidden="true"
                    />
                  );
                })}

              {/* Recurring structure from settings.blocks — background only,
                  behind the scheduled events, never interactive (Phase 1B §2). */}
              {dayBlocks.map((b, i) => {
                const top = yForMinutes(b.startMin);
                const height = Math.max(yForMinutes(b.endMin) - top, 16);
                return (
                  <div
                    key={`sk-${i}`}
                    className="weekfit-sk"
                    style={{ top, height }}
                    title={`${b.name} · ${fmtMinutes(b.startMin)}–${fmtMinutes(b.endMin)}${
                      b.note ? ` — ${b.note}` : ''
                    }`}
                  >
                    <span>{b.name}</span>
                  </div>
                );
              })}

              {dayEvents.map((e, i) => {
                const pos = eventPositionOf(e);
                return (
                  <EventBlock
                    key={`${e.uid}-${i}`}
                    ev={e}
                    startMin={pos.startMin}
                    endMin={pos.endMin}
                    dragging={eventPreview?.uid === e.uid}
                    resizing={eventResizePreview?.uid === e.uid}
                    onUnschedule={onUnschedule}
                    onDragStart={handleEventDragStart}
                    onResizeStart={handleEventResizeStart}
                  />
                );
              })}

              {dayProposals.map((p) => {
                const pos = positionOf(p);
                return (
                  <GhostBlock
                    key={p.key}
                    proposal={p}
                    startMin={pos.startMin}
                    endMin={pos.endMin}
                    dragging={preview?.key === p.key}
                    resizing={ghostResizePreview?.key === p.key}
                    onAccept={onAccept}
                    onDismiss={onDismiss}
                    onDragStart={handleDragStart}
                    onResizeStart={handleGhostResizeStart}
                  />
                );
              })}

              {nowDayIndex === di && <NowLine now={now} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

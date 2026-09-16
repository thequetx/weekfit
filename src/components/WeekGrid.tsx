import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { bodyHeight, endHour, gridHours, minutesForY, startHour, yForMinutes } from '../lib/grid';
import { DAY_NAMES, addDays, dayIndex, fmtHourLabel, fmtMinutes, sameDate } from '../lib/week';
import type { CalEvent, SkeletonBlock, VaultTask } from '../lib/types';
import type { Gap, Proposal, ProposalConflict } from '../lib/gaps';
import { proposalConflict } from '../lib/gaps';
import { SNAP_MINUTES, snapToGrid } from '../lib/duration';
import { parseTaskMeta } from '../lib/taskmeta';
import { EventBlock, eventMinutes } from './EventBlock';
import { IcsEventBlock, icsEventMinutes } from './IcsEventBlock';
import { NowLine } from './NowLine';
import { GhostBlock } from './GhostBlock';
import { packLanes, laneStyle } from './lanes';
import type { LanePlacement, Spanned } from './lanes';

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
  /** Keyed on the proposal itself (`key`), not its group — moving one sitting
   *  of a split must not drag the others on top of it. */
  onMoveProposal: (key: string, day: number, startMin: number) => void;
  /** Phase 2C — re-time, remove, or open the source of a block already on the
   *  grid. `uid` is `${file}:${line}`; `main.ts` resolves it. */
  onMoveBlock: (uid: string, day: number, startMin: number) => void;
  onUnschedule: (uid: string) => void;
  onOpenSource: (uid: string) => void;
  /**
   * A task the rail has started dragging onto the grid, or `null`. The grid
   * owns the geometry, so it resolves the drop; the rail only says what is
   * being dragged and how long it is.
   */
  incoming: { task: VaultTask; minutes: number } | null;
  /** Where an incoming task was dropped. Not called if it never moved, or if
   *  it was released outside the grid. */
  onDropTask: (task: VaultTask, day: number, startMin: number) => void;
  /** The incoming drag ended, however it ended — so the caller can clear it. */
  onIncomingEnd: () => void;
  /**
   * Is this point over the rail? The grid owns every drag but does not know
   * where the rail is, so the caller supplies the hit-test. Dropping a block
   * there unschedules it — the mirror of dragging one out of the rail, and the
   * gesture people reach for first.
   */
  isOverRail?: (clientX: number, clientY: number) => boolean;
  /** A block not to draw — it is being replaced by the ghosts on screen. */
  hiddenUid?: string | null;
  /** Split this block into sittings; the caller asks how many. */
  onSplit?: (uid: string, x: number, y: number) => void;
  /**
   * Edge-drag resize — a block's top edge re-times its start (end fixed), its
   * bottom edge re-times its end (start fixed). Reports only the *final*
   * interval, on pointer-up; the drag's own preview is local state (see
   * `EventResizePreview`/`ProposalResizePreview` below), so this never fires
   * mid-drag. `main.ts` turns a resized real block into a vault write.
   */
  onResizeBlock: (uid: string, startMin: number, endMin: number) => void;
  /** Keyed on the proposal itself, as `onMoveProposal`. */
  onResizeProposal: (key: string, startMin: number, endMin: number) => void;
  /**
   * Read-only calendar-feed events (`snapshot.icsEvents`), drawn distinctly
   * from `scheduled` and never resizable/re-timable/click-openable
   * (see `IcsEventBlock`'s own doc comment). Optional, defaulting to `[]`, so
   * every existing caller/test that predates this feature keeps compiling and
   * rendering exactly as it did.
   *
   * When `icsEventsBusy` is on, the same event is *also* present in
   * `scheduled` (so it still reserves a gap) — `WeekGrid` de-duplicates by uid
   * so it is drawn exactly once, in its `IcsEventBlock` styling rather than a
   * real block's, regardless of which array it happens to also be sitting in.
   */
  icsEvents?: CalEvent[];
  /**
   * An ICS event was dragged onto the rail — the one interaction a read-only
   * calendar block supports (spec §2.4). `main.ts` turns this into a task
   * line via `data/icsCapture.ts` and the same `appendUnderHeading` write path
   * "Capture a task" already uses. Optional for the same reason `icsEvents`
   * is: a caller that never passes any ICS events has nothing to drop.
   */
  onDropIcsToRail?: (ev: CalEvent) => void;
  /**
   * uids from `icsEvents` that already have a `[ics-uid::]` marker somewhere
   * in the snapshot — i.e. already captured as a task (`WeekViewRoot` derives
   * this from the task lines it already has, via `icsUidOf`). These are
   * dropped from the *drawn* ICS block set — spec §2.4, point 3, "that event
   * stops being drawn as an ICS block on the grid" — without touching
   * `icsUidSet`'s own busy-dedup role below: a captured event's underlying
   * feed entry can still be sitting in `scheduled` reserving a gap (the feed
   * has no idea it was captured, so a refetch keeps returning it), and that
   * reservation must still be excluded from `scheduled`'s own ordinary
   * `EventBlock` rendering — that block's `uid` is the feed's own uid, not a
   * `file:line`, so drawing it as an interactive real block would offer
   * controls (`onUnschedule`, drag-to-retime) that resolve to nothing.
   */
  capturedIcsUids?: Set<string>;
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
  // A task dragged in from the rail — it has no block on the grid yet, so the
  // preview is drawn from nothing rather than moved from somewhere.
  | 'incoming'
  // A read-only ICS block being dragged toward the rail. Its own kind
  // rather than reusing `'event'`: it never re-times or moves within the
  // grid (there is no `onMoveBlock`/`gaps` legality question for it at all),
  // it has no click-opens-source behaviour, and it reports through a
  // different callback (`onDropIcsToRail`) on drop.
  | 'ics'
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
 * A ghost's drop, and a real block's, always lands exactly where the pointer
 * released it — snapped only to the grid's own 30-minute lattice and clamped
 * to the grid's bounds, the same treatment every placement path (resize,
 * a task dragged in from the rail) already gets. `proposalConflict`
 * (`lib/gaps.ts`) is what tells the user whether that spot overlaps
 * something; nothing here refuses or relocates a hand-placement. (`snapToGap`,
 * also in `lib/gaps.ts`, still exists and is still tested — it is no longer
 * consulted on drop. It used to pull a placement onto a nearby gap's edge
 * whenever one sat within its 90-minute reach, which silently disagreed with
 * where the drag preview had just shown the block landing. Removed
 * 2026-09-16 on direct feedback asking to place a block anywhere, not just
 * near a gap.)
 *
 * Edge-drag resize (both ghost and real block) is the same mechanism —
 * `onPointerDown` on a thin handle at the block's top or bottom edge starts a
 * gesture tracked on `window` for the same reason a move is, and the moving
 * edge preserves its own grab offset the same way a move preserves the
 * block's — extended with two more `dragKind`s per block type (`*-resize-top`
 * / `*-resize-bottom`) rather than a second, parallel machine. A resize was
 * never gated on gap legality even before moves lost that gate too: `computeGaps`
 * marks a scheduled block's own footprint as *busy*, so a block being resized
 * is never inside any gap in the first place, and gating on that would make
 * every resize illegal by construction. A resize is instead clamped to the
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
  incoming,
  onDropTask,
  onIncomingEnd,
  isOverRail,
  hiddenUid,
  onSplit,
  onResizeBlock,
  onResizeProposal,
  icsEvents = [],
  onDropIcsToRail,
  capturedIcsUids,
}: WeekGridProps) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  // When `icsEventsBusy` is on, `vaultRepo.readWeek` pushes the same event
  // into both `scheduled` (so it reserves a gap) and `icsEvents` (so it
  // can still be drawn/dropped as an ICS block). Without this set, that event
  // would render twice: once as an ordinary `EventBlock`, once as an
  // `IcsEventBlock`. Filtering it out of `scheduled`'s own rendering below —
  // while leaving it in `scheduled` for every *non*-drawing purpose (gap
  // computation, conflict-checking) — is what keeps "reserves time" and "is
  // drawn read-only" as the two independent facts the settings toggle says
  // they are.
  const icsUidSet = new Set(icsEvents.map((e) => e.uid));
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
  const incomingRef = useRef<{ moved: boolean } | null>(null);
  const [incomingPreview, setIncomingPreview] = useState<{ day: number; startMin: number } | null>(
    null,
  );
  // Dragging a read-only ICS block toward the rail. No preview state beyond
  // "which uid is mid-drag": unlike every move-drag above, this
  // block never repositions on the grid (see `DragKind`'s own doc comment on
  // `'ics'`), so there is no day/startMin to track, only whether to dim it.
  const icsDragRef = useRef<{ ev: CalEvent; startClientX: number; startClientY: number; moved: boolean } | null>(
    null,
  );
  const [icsDraggingUid, setIcsDraggingUid] = useState<string | null>(null);

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

    // A ghost dropped on the rail is dismissed — the same gesture that
    // unschedules a real block, meaning the same thing: take this off the
    // week. Nothing is written either way; a ghost was never on disk.
    if (isOverRail?.(e.clientX, e.clientY)) {
      onDismiss(drag.proposal.groupKey);
      return;
    }

    const day = dayAt(e.clientX);
    const startMin = grabAdjustedStart(day, e.clientY, drag.grabOffsetMin, drag.proposal.minutes);
    // Always land exactly where the preview showed it landing.
    //
    // Was: prefer a legal gap via `snapToGap`, falling back to the raw
    // position only when nothing on that day fit. Removed 2026-09-16 — the
    // drag preview above never consulted `snapToGap`, so committing through
    // it here could silently relocate the block onto a nearby gap's edge the
    // instant one sat within reach, disagreeing with what the user had just
    // watched move under their cursor. `proposalConflict` is the only
    // legality signal now, same as a resize already was.
    onMoveProposal(drag.proposal.key, day, startMin);
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

  // --- a task dragged in from the rail -----------------------------------
  //
  // Same window-listener discipline as every other drag here, and for the same
  // reason: the pointer starts over the rail, travels across the grid, and
  // must keep being tracked the whole way. An element-bound handler would lose
  // it the moment it crossed the boundary.

  function beginIncoming() {
    incomingRef.current = { moved: false };
    setDragKind('incoming');
  }

  function handleIncomingMove(e: PointerEvent) {
    const drag = incomingRef.current;
    if (!drag || !incoming) return;
    drag.moved = true;
    const day = dayAt(e.clientX);
    const startMin = clampToGrid(snapToGrid(minutesAt(day, e.clientY)), incoming.minutes);
    setIncomingPreview({ day, startMin });
  }

  function handleIncomingEnd(e: PointerEvent) {
    const drag = incomingRef.current;
    const task = incoming;
    incomingRef.current = null;
    setIncomingPreview(null);
    setDragKind(null);
    onIncomingEnd();
    if (!drag || !task || !drag.moved) return;

    // Released outside the grid — no day column contains the pointer — is a
    // cancelled drag, not a drop at the nearest edge. Placing work somewhere
    // the user did not point at is the board deciding.
    if (!withinGrid(e.clientX, e.clientY)) return;

    const day = dayAt(e.clientX);
    const startMin = clampToGrid(snapToGrid(minutesAt(day, e.clientY)), task.minutes);
    onDropTask(task.task, day, startMin);
  }

  /** Keep a placement inside the rendered hours. */
  function clampToGrid(startMin: number, minutes: number): number {
    const lo = startHour * 60;
    const hi = endHour * 60 - minutes;
    return Math.max(lo, Math.min(startMin, Math.max(lo, hi)));
  }

  /** Is the pointer actually over the grid body? */
  function withinGrid(clientX: number, clientY: number): boolean {
    return bodyRefs.current.some((el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom;
    });
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
    // from gap legality: `computeGaps` treats the block's own footprint as
    // busy, so gating here would make every resize illegal.
    if (drag.edge === 'top') {
      const startMin = clampTopEdge(snapped, drag.anchorMin);
      // Landed back where it started -> nothing to report.
      if (startMin !== drag.origEdgeMin) {
        onResizeProposal(drag.proposal.key, startMin, drag.anchorMin);
      }
    } else {
      const endMin = clampBottomEdge(snapped, drag.anchorMin);
      if (endMin !== drag.origEdgeMin) {
        onResizeProposal(drag.proposal.key, drag.anchorMin, endMin);
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
    // Over the rail mid-drag: stop previewing a placement, since releasing
    // here takes the block off the week rather than putting it somewhere.
    if (isOverRail?.(e.clientX, e.clientY)) {
      setEventPreview(null);
      return;
    }

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

    // Released over the rail: that is "take this off the week", not a move to
    // whichever day column happens to be nearest the pointer.
    if (isOverRail?.(e.clientX, e.clientY)) {
      onUnschedule(drag.ev.uid);
      return;
    }

    const day = dayAt(e.clientX);
    const orig = eventMinutes(drag.ev);
    const durationMin = Math.max(orig.endMin - orig.startMin, 1);
    const startMin = grabAdjustedStart(day, e.clientY, drag.grabOffsetMin, durationMin);

    // Always land exactly where the preview showed it — see the matching
    // note on the ghost drop above.
    //
    // Was: once a fit had run (`gaps` non-null), prefer a legal gap via
    // `snapToGap`, falling back to the raw position only when nothing fit;
    // before a fit had run (`gaps == null`) the move already always landed.
    // Removed 2026-09-16 so whether a fit has run no longer changes what a
    // hand-drag does — `proposalConflict` is the only legality signal either
    // way.
    onMoveBlock(drag.ev.uid, day, startMin);
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

  /**
   * What a ghost or real block currently sitting at `day`/`startMin`/`endMin`
   * would land on top of — recurring structure from `settings.blocks`, or
   * another entry in `scheduled` — via `proposalConflict` (`lib/gaps.ts`).
   * Recomputed on every render from the live position, so it covers a
   * mid-drag preview and a settled position with the same call: there is no
   * separate "was this hand-placed" flag to track, only "is the current spot
   * clear". `excludeUid` is how a real block is kept from ever conflicting
   * with its own unmoved footprint in `scheduled` — a ghost never needs it,
   * since a proposal is never itself a member of `scheduled`. Drag/resize
   * previews already feed this the *proposed* position (see `positionOf` /
   * `eventPositionOf`), which is what makes the marker show up mid-gesture
   * rather than only after release.
   */
  function conflictFor(
    day: number,
    startMin: number,
    endMin: number,
    excludeUid?: string,
  ): ProposalConflict | null {
    // `hiddenUid` is the block a pending split is about to become. It is still
    // in `scheduled` — only its drawing is suppressed — so without excluding
    // it, every sitting overlapping its old footprint is flagged as
    // conflicting with the very block it replaces. That is what splitting in a
    // busy week looked like: a wall of conflicts, all of them against itself.
    const events = scheduled.filter(
      (e) => e.uid !== excludeUid && (hiddenUid == null || e.uid !== hiddenUid),
    );
    return proposalConflict(weekStart, day, startMin, endMin, blocks, events);
  }

  // --- real-block resize: edge-drag re-times start or end ------------------
  //
  // See the matching comment on the ghost-resize handlers above — same
  // reasoning applies here for why this is its own handler pair rather than
  // folded into the move-drag's, just with `onResizeBlock` in place of
  // `onResizeProposal` (a resize is exempt from gap legality, same as a move
  // now is — see the doc comment on `WeekGrid`).

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

  // --- Dragging a read-only ICS block onto the rail ------------------------
  //
  // The one gesture `IcsEventBlock` supports. Modelled on the move-drags
  // above (pointer capture on down, tracked on `window` from then on, a 4px
  // threshold telling a drag from a stray click) but deliberately smaller:
  // there is no day/minute math, no `snapToGap`, no preview position, because
  // the block never actually moves on the grid — it only ever leaves it
  // (dropped on the rail) or stays exactly where it was (dropped anywhere
  // else, which is simply not a drop this gesture recognises).

  function handleIcsDragStart(ev: CalEvent, e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    icsDragRef.current = { ev, startClientX: e.clientX, startClientY: e.clientY, moved: false };
    setDragKind('ics');
  }

  function handleWindowIcsDragMove(e: PointerEvent) {
    const drag = icsDragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    drag.moved = true;
    setIcsDraggingUid(drag.ev.uid);
  }

  function handleWindowIcsDragEnd(e: PointerEvent) {
    const drag = icsDragRef.current;
    icsDragRef.current = null;
    setDragKind(null);
    setIcsDraggingUid(null);
    if (!drag || !drag.moved) return;

    // Anywhere but the rail is a cancelled drag, not a drop: this block has
    // no other legal destination, so there is nothing to snap it to or
    // refuse it from — it was never actually moved in the first place.
    if (isOverRail?.(e.clientX, e.clientY)) {
      onDropIcsToRail?.(drag.ev);
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
  // The rail starts the gesture (it owns the pointerdown) but the grid owns
  // the geometry, so the grid takes over the moment a task is handed to it.
  // Keyed on `incoming` rather than started by a callback, because the rail
  // has no way to reach into this component's drag machine.
  useEffect(() => {
    if (incoming && dragKind === null) beginIncoming();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on `incoming` alone on purpose. `dragKind` and `beginIncoming` both change while a drag is running, and re-running this then would restart the very gesture the user is mid-way through.
  }, [incoming]);

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
    if (dragKind === 'incoming') {
      window.addEventListener('pointermove', handleIncomingMove);
      window.addEventListener('pointerup', handleIncomingEnd);
      window.addEventListener('pointercancel', handleIncomingEnd);
      return () => {
        window.removeEventListener('pointermove', handleIncomingMove);
        window.removeEventListener('pointerup', handleIncomingEnd);
        window.removeEventListener('pointercancel', handleIncomingEnd);
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
    if (dragKind === 'ics') {
      window.addEventListener('pointermove', handleWindowIcsDragMove);
      window.addEventListener('pointerup', handleWindowIcsDragEnd);
      window.addEventListener('pointercancel', handleWindowIcsDragEnd);
      return () => {
        window.removeEventListener('pointermove', handleWindowIcsDragMove);
        window.removeEventListener('pointerup', handleWindowIcsDragEnd);
        window.removeEventListener('pointercancel', handleWindowIcsDragEnd);
      };
    }
    return undefined;
    // Only `dragKind` — every handler above closes over refs (mutated
    // synchronously at pointerdown, before `dragKind` ever flips) and props
    // read fresh at the moment the drag started, which is the behaviour the
    // 4px-threshold click/drag distinction already assumes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the comment directly above: `dragKind` is the only dependency that may re-bind these window listeners. Re-binding on any other change would detach the listeners a live drag depends on.
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
        const dayEvents = scheduled.filter(
          (e) => !e.allDay && e.uid !== hiddenUid && !icsUidSet.has(e.uid) && eventDayOf(e) === di,
        );
        const allDay = scheduled.filter(
          (e) => e.allDay && !icsUidSet.has(e.uid) && dayIndex(e.start, weekStart) === di,
        );
        // Drawn from `icsEvents` itself, per the toggle's own doc comment
        // (contract.ts): "always carried here regardless of the toggle,
        // because the grid still needs to draw it". `scheduled` is only ever
        // the busy-toggle's *reservation* signal now, never the draw source
        // for one of these. `capturedIcsUids` additionally drops one already
        // turned into a task — see this prop's own doc comment above.
        const dayIcsEvents = icsEvents.filter(
          (e) => !e.allDay && !capturedIcsUids?.has(e.uid) && dayIndex(e.start, weekStart) === di,
        );
        const dayIcsAllDay = icsEvents.filter(
          (e) => e.allDay && !capturedIcsUids?.has(e.uid) && dayIndex(e.start, weekStart) === di,
        );
        const dayBlocks = blocks.filter((b) => b.days.includes(di));
        const dayGaps = gapList.filter((g) => g.day === di);
        const dayProposals = proposals.filter((p) => positionOf(p).day === di);
        // One lane layout for every foreground block in this day, whatever its
        // kind — a ghost, a real block and an ICS event at the same hour must
        // share the column rather than overlap. Positions come from the same
        // effective getters the render uses below (eventPositionOf /
        // icsEventMinutes / positionOf), so a mid-drag preview is packed where
        // it is actually drawn.
        const laneItems: Spanned[] = [
          ...dayEvents.map((e) => {
            const p = eventPositionOf(e);
            return { id: `ev:${e.uid}`, startMin: p.startMin, endMin: p.endMin };
          }),
          ...dayIcsEvents.map((e) => {
            const p = icsEventMinutes(e);
            return { id: `ics:${e.uid}`, startMin: p.startMin, endMin: p.endMin };
          }),
          ...dayProposals.map((pr) => {
            const p = positionOf(pr);
            return { id: `ghost:${pr.key}`, startMin: p.startMin, endMin: p.endMin };
          }),
            // The rail task mid-flight — packed alongside the committed blocks so it
            // slots into a free lane instead of covering the column. Only present on
            // the day under the cursor, and only while a drag is happening.
           ...(incoming && incomingPreview?.day === di
           ? [{
               id: 'incoming:',
                startMin: incomingPreview.startMin,
               endMin: incomingPreview.startMin + incoming.minutes,
            }]
          : []),
        ];
        const lanePlacements = packLanes(laneItems);
        const laneFor = (id: string): LanePlacement =>
          lanePlacements.get(id) ?? { lane: 0, lanes: 1 };
        const incomingLane = laneFor('incoming:');
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
              {/* All-day calendar-feed events. Same chip, visually muted —
                  read-only scenery, like every other all-day chip: neither
                  kind has ever been draggable or clickable here. */}
              {dayIcsAllDay.map((e) => (
                <span
                  key={e.uid}
                  className="weekfit-grid__chip weekfit-grid__chip--ics"
                  title={`${e.title} · from your calendar feed`}
                >
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
                // Excludes `e` itself from what it's checked against — a
                // block never conflicts with where it currently is.
                const conflict = conflictFor(di, pos.startMin, pos.endMin, e.uid);
                // A laned block sitting beside another real block no longer needs the marker —
                // you can see both. Keep it only when the thing it overlaps is a recurring
                // block, which is drawn full-width behind it and is genuinely hidden.
                const shownConflict = conflict?.kind === 'skeleton' ? conflict : null;
                return (
                  <EventBlock
                    key={`${e.uid}-${i}`}
                    ev={e}
                    startMin={pos.startMin}
                    endMin={pos.endMin}
                    {...laneFor(`ev:${e.uid}`)}
                    dragging={eventPreview?.uid === e.uid}
                    resizing={eventResizePreview?.uid === e.uid}
                    conflict={shownConflict}
                    onUnschedule={onUnschedule}
                    onSplit={onSplit}
                    onDragStart={handleEventDragStart}
                    onResizeStart={handleEventResizeStart}
                  />
                );
              })}

              {/* Read-only calendar-feed blocks. Positioned with the
                  same formula as a real block (`icsEventMinutes`, the ICS
                  twin of `eventMinutes`), but never fed a drag preview: this
                  block never repositions on the grid, only leaves it (dropped
                  on the rail — see `handleWindowIcsDragEnd`). */}
              {dayIcsEvents.map((e) => {
                const pos = icsEventMinutes(e);
                return (
                  <IcsEventBlock
                    key={e.uid}
                    ev={e}
                    startMin={pos.startMin}
                    endMin={pos.endMin}
                    {...laneFor(`ics:${e.uid}`)}
                    dragging={icsDraggingUid === e.uid}
                    onDragStart={handleIcsDragStart}
                  />
                );
              })}

              {dayProposals.map((p) => {
                const pos = positionOf(p);
                const conflict = conflictFor(di, pos.startMin, pos.endMin);
                // `GhostBlock` already reads `proposal.conflict` (see its own
                // doc comment) — this is what actually populates it, freshly
                // on every render, rather than mutating the caller's `p`.
                const effectiveProposal: Proposal = { ...p, conflict: conflict ?? undefined };
                return (
                  <GhostBlock
                    key={p.key}
                    proposal={effectiveProposal}
                    startMin={pos.startMin}
                    endMin={pos.endMin}
                    {...laneFor(`ghost:${p.key}`)}
                    dragging={preview?.key === p.key}
                    resizing={ghostResizePreview?.key === p.key}
                    onAccept={onAccept}
                    onDismiss={onDismiss}
                    onDragStart={handleDragStart}
                    onResizeStart={handleGhostResizeStart}
                  />
                );
              })}

              {/* A rail task mid-flight. Drawn dashed and accent-tinted so it
                  reads as "about to be", like a ghost — because until the
                  pointer comes up nothing has been written. */}
              {incomingPreview && incomingPreview.day === di && incoming && (
                <div
                  className="weekfit-grid__incoming"
                  style={{
                    top: yForMinutes(incomingPreview.startMin),
                    height: Math.max(
                      yForMinutes(incomingPreview.startMin + incoming.minutes) -
                        yForMinutes(incomingPreview.startMin),
                      18,
                      ),
                      ...laneStyle(incomingLane.lane, incomingLane.lanes),
                    }}
                  aria-hidden="true"
                >
                  {fmtMinutes(incomingPreview.startMin)} {parseTaskMeta(incoming.task.text).title}
                </div>
              )}
              {nowDayIndex === di && <NowLine now={now} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

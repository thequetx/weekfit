import { useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { bodyHeight, gridHours, minutesForY, yForMinutes } from '../lib/grid';
import { DAY_NAMES, addDays, dayIndex, fmtHourLabel, fmtMinutes, sameDate } from '../lib/week';
import type { CalEvent, SkeletonBlock } from '../lib/types';
import type { Gap, Proposal } from '../lib/gaps';
import { snapToGap } from '../lib/gaps';
import { snapToGrid } from '../lib/duration';
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
}

interface DragState {
  proposal: Proposal;
  startClientX: number;
  startClientY: number;
  /** A press that never crosses the move threshold is a click on the ghost
   *  (Accept/Dismiss already stop their own pointerdown from reaching here),
   *  not a drag — so it must not call `onMoveProposal` on release. */
  moved: boolean;
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
}

interface EventPreview {
  uid: string;
  day: number;
  startMin: number;
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
 * captures the pointer, `onPointerMove` recomputes a live preview position
 * from the cursor, and `onPointerUp` resolves the drop. A real block additionally
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

  function handleDragStart(proposal: Proposal, e: PointerEvent<HTMLDivElement>) {
    // Optional chaining: real browsers all implement this, but jsdom (the
    // component test environment) doesn't, and a capture that silently
    // doesn't happen there is harmless — the drag state machine below doesn't
    // depend on it, only on the pointer events actually arriving.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      proposal,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
    };
  }

  function handleDragMove(proposal: Proposal, e: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.proposal.key !== proposal.key) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    drag.moved = true;
    const day = dayAt(e.clientX);
    setPreview({ key: proposal.key, day, startMin: minutesAt(day, e.clientY) });
  }

  function handleDragEnd(proposal: Proposal, e: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    setPreview(null);
    if (!drag || drag.proposal.key !== proposal.key || !drag.moved) return;

    const day = dayAt(e.clientX);
    const startMin = minutesAt(day, e.clientY);
    // Nothing on that day fits -> leave the ghost exactly where it was: no
    // callback, no fallback to another day. See lib/gaps.ts `snapToGap`.
    const snapped = snapToGap(gapList, day, startMin, proposal.minutes);
    if (snapped) onMoveProposal(proposal.groupKey, snapped.gap.day, snapped.startMin);
  }

  function positionOf(p: Proposal): { day: number; startMin: number; endMin: number } {
    if (preview && preview.key === p.key) {
      return { day: preview.day, startMin: preview.startMin, endMin: preview.startMin + p.minutes };
    }
    return { day: p.day, startMin: p.startMin, endMin: p.endMin };
  }

  // --- real blocks (Phase 2C): drag to re-time, click to open source -------

  function handleEventDragStart(ev: CalEvent, e: PointerEvent<HTMLDivElement>) {
    // See the matching comment in `handleDragStart` above.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    eventDragRef.current = {
      ev,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
    };
  }

  function handleEventDragMove(ev: CalEvent, e: PointerEvent<HTMLDivElement>) {
    const drag = eventDragRef.current;
    if (!drag || drag.ev.uid !== ev.uid) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    drag.moved = true;
    const day = dayAt(e.clientX);
    setEventPreview({ uid: ev.uid, day, startMin: minutesAt(day, e.clientY) });
  }

  function handleEventDragEnd(ev: CalEvent, e: PointerEvent<HTMLDivElement>) {
    const drag = eventDragRef.current;
    eventDragRef.current = null;
    setEventPreview(null);
    if (!drag || drag.ev.uid !== ev.uid) return;

    if (!drag.moved) {
      // Never crossed the threshold -> a click, not a drag. Opens the source
      // line instead of moving anything.
      onOpenSource(ev.uid);
      return;
    }

    const day = dayAt(e.clientX);
    const startMin = minutesAt(day, e.clientY);
    const orig = eventMinutes(ev);
    const durationMin = Math.max(orig.endMin - orig.startMin, 1);

    if (gaps == null) {
      // "Fit this week" hasn't run, so there are no gaps to check legality
      // against — `minutesAt` already rounds to the grid's 30-minute lattice
      // via `minutesForY`, and `snapToGrid` makes that lattice explicit here,
      // the same quantum a freshly-placed block snaps to everywhere else.
      // Unlike the gap-aware path below, there's nothing to refuse against,
      // so the move always lands.
      onMoveBlock(ev.uid, day, snapToGrid(startMin));
      return;
    }

    // A fit has run: hold a re-time to the same legality a ghost's drop
    // does. Nothing on that day fits -> leave the block exactly where it
    // was — no callback at all, same discipline as a ghost's failed drop.
    const snapped = snapToGap(gaps, day, startMin, durationMin);
    if (snapped) onMoveBlock(ev.uid, snapped.gap.day, snapped.startMin);
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
    return orig;
  }

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
                    onUnschedule={onUnschedule}
                    onDragStart={handleEventDragStart}
                    onDragMove={handleEventDragMove}
                    onDragEnd={handleEventDragEnd}
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
                    onAccept={onAccept}
                    onDismiss={onDismiss}
                    onDragStart={handleDragStart}
                    onDragMove={handleDragMove}
                    onDragEnd={handleDragEnd}
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

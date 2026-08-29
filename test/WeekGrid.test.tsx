import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { WeekGrid } from '../src/components/WeekGrid';
import type { WeekGridProps } from '../src/components/WeekGrid';
import { addDays } from '../src/lib/week';
import type { CalEvent, SkeletonBlock } from '../src/lib/types';
import type { Gap, Proposal } from '../src/lib/gaps';

// vitest.config.ts doesn't run with `test.globals: true` for the `components`
// project either — see the matching comment in rail.test.tsx / WeekViewRoot.test.tsx.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Monday of a fixed week, local time — same convention as WeekViewRoot.test.tsx.
const WEEK_START = new Date(2026, 7, 31);
const NOW = new Date(2026, 7, 31, 8, 0);
const WEDNESDAY = addDays(WEEK_START, 2);

function calEvent(opts: Partial<CalEvent> & { start: Date; end: Date }): CalEvent {
  return { uid: 'ev1', title: 'Event', allDay: false, ...opts };
}

function dateAt(day: Date, hours: number, minutes: number): Date {
  const d = new Date(day);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    key: 'Weekly/2026-W36.md:5',
    groupKey: 'Weekly/2026-W36.md:5',
    kind: 'fit',
    file: 'Weekly/2026-W36.md',
    line: 5,
    text: '- [ ] Write report ~90m',
    title: 'Write report',
    minutes: 90,
    day: 2,
    startMin: 570, // 09:30
    endMin: 660, // 11:00
    window: 'work',
    ...overrides,
  };
}

function skeletonBlock(overrides: Partial<SkeletonBlock> = {}): SkeletonBlock {
  return {
    name: 'Gym',
    kind: 'gym',
    days: [2],
    startMin: 600,
    endMin: 660,
    ...overrides,
  };
}

function baseProps(overrides: Partial<WeekGridProps> = {}): WeekGridProps {
  return {
    weekStart: WEEK_START,
    now: NOW,
    scheduled: [],
    blocks: [] as SkeletonBlock[],
    gaps: null,
    showGaps: false,
    proposals: [],
    onAccept: vi.fn(),
    onDismiss: vi.fn(),
    onMoveProposal: vi.fn(),
    onMoveBlock: vi.fn(),
    onUnschedule: vi.fn(),
    onOpenSource: vi.fn(),
    onResizeBlock: vi.fn(),
    onResizeProposal: vi.fn(),
    ...overrides,
  };
}

// jsdom gives every `getBoundingClientRect()` a 0x0 rect, which is exactly
// why the grab-offset bug reached a user with 586 passing tests: every
// arithmetic path that reads a rect silently computed with zeros and nothing
// caught it. This stubs realistic geometry for the day columns and day
// bodies so `dayAt`/`minutesAt` (and therefore the drag math) run for real.
//
//   - Column `di` spans clientX [di*COL_WIDTH, (di+1)*COL_WIDTH).
//   - Every body starts at clientY = BODY_TOP (simulating a pane that has
//     scrolled / has a header above the grid), matching `minutesForY`'s own
//     coordinate system (`clientY - rect.top`).
const COL_WIDTH = 100;
const BODY_TOP = 40;

function installGeometry(container: HTMLElement): void {
  const cols = Array.from(container.querySelectorAll<HTMLElement>('.weekfit-grid__col'));
  const bodies = Array.from(container.querySelectorAll<HTMLElement>('.weekfit-grid__body'));

  function rect(x: number, y: number, width: number, height: number): DOMRect {
    return {
      x,
      y,
      width,
      height,
      top: y,
      left: x,
      right: x + width,
      bottom: y + height,
      toJSON() {
        return this;
      },
    } as DOMRect;
  }

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const colIdx = cols.indexOf(this);
    if (colIdx !== -1) return rect(colIdx * COL_WIDTH, 0, COL_WIDTH, 2000);
    const bodyIdx = bodies.indexOf(this);
    if (bodyIdx !== -1) return rect(bodyIdx * COL_WIDTH, BODY_TOP, COL_WIDTH, 2000);
    return rect(0, 0, 0, 0);
  });
}

function pointer(clientX: number, clientY: number, extra: Partial<PointerEvent> = {}) {
  return { clientX, clientY, pointerId: 1, ...extra };
}

/** Dispatched on `window`, never the block — see the "tracks via window"
 *  suite below for why that distinction is the whole point of this file. */
function windowPointer(type: 'pointermove' | 'pointerup' | 'pointercancel', clientX: number, clientY: number) {
  // Wrapped in `act` so the resulting state update (`setPreview` etc.) is
  // flushed synchronously — a raw `window.dispatchEvent` bypasses Testing
  // Library's own `act`-wrapping (that only covers `fireEvent`), and the
  // conflict-marking suite below reads the DOM *between* a move and the
  // following pointerup, so the update has to have landed by the time the
  // assertion runs, not on some later microtask.
  act(() => {
    window.dispatchEvent(new PointerEvent(type, { clientX, clientY, pointerId: 1, bubbles: true }));
  });
}

describe('WeekGrid — grab offset is preserved (the reported bug)', () => {
  // Geometry: startHour=5 (300min), pxPerHour=46 (src/config.ts GRID).
  // minutesForY(y) = round((y/46*60 + 300)/30)*30, clamped to [300, 1410].
  // y=230  -> raw 600 (10:00) exactly, a lattice point.
  // y=253  -> raw 630 (10:30) exactly, a lattice point.
  // Using two already-on-lattice points isolates the grab-offset arithmetic
  // from snapToGrid's own rounding, which is asserted separately below.
  const Y_AT_10_00 = BODY_TOP + 230;
  const Y_AT_10_30 = BODY_TOP + 253;
  const DAY2_X = 250; // inside column 2's [200, 300) span -> Wednesday

  it('a real block grabbed mid-block moves by the pointer delta, not to the pointer position', () => {
    const onMoveBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:7',
      start: dateAt(WEDNESDAY, 9, 30), // startMin 570
      end: dateAt(WEDNESDAY, 10, 30), // endMin 630, duration 60
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: null, onMoveBlock })} />,
    );
    installGeometry(container);
    const block = container.querySelector('.weekfit-ev') as HTMLElement;

    // Grab 30 minutes into the block (minutesAt=600 at pointerdown, block
    // starts at 570 -> grabOffsetMin=30) rather than at its top edge.
    fireEvent.pointerDown(block, pointer(DAY2_X, Y_AT_10_00));
    // Regression guard for defect 2: pointermove/pointerup are dispatched on
    // `window`, never the block. Against the old code (React onPointerMove/
    // onPointerUp props on the block div) this event is invisible — a
    // `window`-targeted PointerEvent never bubbles down into the block's
    // subtree, so only a real `window.addEventListener` can observe it.
    windowPointer('pointermove', DAY2_X, Y_AT_10_30);
    windowPointer('pointerup', DAY2_X, Y_AT_10_30);

    // The pointer moved by exactly 30 minutes (10:00 -> 10:30). The block
    // must move by that same 30 minutes — from 570 to 600 — not jump to the
    // pointer's absolute position (630), which is what the unfixed code did
    // (see below).
    expect(onMoveBlock).toHaveBeenCalledTimes(1);
    expect(onMoveBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:7', 2, 600);
  });

  it('a ghost grabbed mid-block moves by the pointer delta, not to the pointer position', () => {
    const onMoveProposal = vi.fn();
    const gap: Gap = {
      day: 2,
      startMin: 300,
      endMin: 1440,
      minutes: 1140,
      window: 'work',
      windowIndex: 0,
      minBlockMin: 30,
    };
    const p = proposal({ day: 2, startMin: 570, endMin: 660, minutes: 90 });
    const { container } = render(
      <WeekGrid {...baseProps({ gaps: [gap], proposals: [p], onMoveProposal })} />,
    );
    installGeometry(container);
    const ghost = container.querySelector('.weekfit-ghost') as HTMLElement;

    fireEvent.pointerDown(ghost, pointer(DAY2_X, Y_AT_10_00));
    windowPointer('pointermove', DAY2_X, Y_AT_10_30);
    windowPointer('pointerup', DAY2_X, Y_AT_10_30);

    expect(onMoveProposal).toHaveBeenCalledTimes(1);
    expect(onMoveProposal).toHaveBeenCalledWith('Weekly/2026-W36.md:5', 2, 600);
  });
});

describe('WeekGrid — snaps to the 30-minute lattice', () => {
  it('a start not already on the lattice is rounded to it', () => {
    const onMoveBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:9',
      start: dateAt(WEDNESDAY, 7, 15), // startMin 435 — off-lattice on purpose
      end: dateAt(WEDNESDAY, 8, 0), // duration 45
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: null, onMoveBlock })} />,
    );
    installGeometry(container);
    const block = container.querySelector('.weekfit-ev') as HTMLElement;

    // minutesForY(y)=450 (07:30) at pointerdown -> grabOffsetMin = 450-435 = 15.
    // Solve precisely instead of eyeballing pixels: y such that
    // minutesForY(y) = min, i.e. the inverse of minutesForY's rounding step:
    // minutesForY(y) = round((y/46*60+300)/30)*30 => y = (min-300)/60*46.
    const yFor = (min: number) => ((min - 300) / 60) * 46;

    fireEvent.pointerDown(block, pointer(250, BODY_TOP + yFor(450)));
    windowPointer('pointermove', 250, BODY_TOP + yFor(480));
    windowPointer('pointerup', 250, BODY_TOP + yFor(480));

    // raw = minutesAt(480) - grabOffsetMin(15) = 465, which snapToGrid rounds
    // up to 480 (08:00) rather than leaving it at the off-lattice 465.
    expect(onMoveBlock).toHaveBeenCalledTimes(1);
    expect(onMoveBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:9', 2, 480);
  });
});

describe('WeekGrid — a drag is clamped to the grid bounds', () => {
  const yFor = (min: number) => ((min - 300) / 60) * 46;

  it('cannot be pulled above the top of the grid', () => {
    const onMoveBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:1',
      start: dateAt(WEDNESDAY, 6, 0), // startMin 360
      end: dateAt(WEDNESDAY, 7, 30), // duration 90
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: null, onMoveBlock })} />,
    );
    installGeometry(container);
    const block = container.querySelector('.weekfit-ev') as HTMLElement;

    // Grab 60 minutes into the block (pointerdown at minute 420 -> offset 60).
    fireEvent.pointerDown(block, pointer(250, BODY_TOP + yFor(420)));
    // Fling the pointer far above the grid's top edge.
    windowPointer('pointermove', 250, BODY_TOP - 5000);
    windowPointer('pointerup', 250, BODY_TOP - 5000);

    // minutesAt clamps to 300 (the grid's own floor) regardless of how far
    // above it the pointer went; raw = 300 - 60 = 240, which is BELOW the
    // grid floor once the offset is subtracted back out. The fix's own
    // clamp (not just minutesForY's) must catch this and hold it at 300.
    expect(onMoveBlock).toHaveBeenCalledTimes(1);
    expect(onMoveBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:1', 2, 300);
  });

  it('cannot be pulled below the bottom of the grid', () => {
    const onMoveBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:2',
      start: dateAt(WEDNESDAY, 22, 30), // startMin 1350
      end: dateAt(WEDNESDAY, 23, 30), // duration 60
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: null, onMoveBlock })} />,
    );
    installGeometry(container);
    const block = container.querySelector('.weekfit-ev') as HTMLElement;

    // Grab at the block's own top edge (offset 0) for a clean bound check.
    fireEvent.pointerDown(block, pointer(250, BODY_TOP + yFor(1350)));
    // Fling the pointer far below the grid's bottom edge.
    windowPointer('pointermove', 250, BODY_TOP + 100000);
    windowPointer('pointerup', 250, BODY_TOP + 100000);

    // endHour(24)*60 - duration(60) = 1380 is the latest legal start; the
    // grid's own 1410 floor-of-the-last-half-hour must not win here.
    expect(onMoveBlock).toHaveBeenCalledTimes(1);
    expect(onMoveBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:2', 2, 1380);
  });
});

describe('WeekGrid — drop legality (snapToGap)', () => {
  const yFor = (min: number) => ((min - 300) / 60) * 46;

  it('gaps === null: the move always lands, with no legality check', () => {
    const onMoveBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:3',
      start: dateAt(WEDNESDAY, 9, 0),
      end: dateAt(WEDNESDAY, 10, 0),
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: null, onMoveBlock })} />,
    );
    installGeometry(container);
    const block = container.querySelector('.weekfit-ev') as HTMLElement;

    fireEvent.pointerDown(block, pointer(250, BODY_TOP + yFor(540)));
    windowPointer('pointermove', 250, BODY_TOP + yFor(600));
    windowPointer('pointerup', 250, BODY_TOP + yFor(600));

    expect(onMoveBlock).toHaveBeenCalledTimes(1);
  });

  it('gaps present but snapToGap finds nothing: reverts, no callback', () => {
    const onMoveBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:4',
      start: dateAt(WEDNESDAY, 9, 0),
      end: dateAt(WEDNESDAY, 10, 0),
    });
    // A fit ran and found nothing free anywhere — an empty array, not null.
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: [], onMoveBlock })} />,
    );
    installGeometry(container);
    const block = container.querySelector('.weekfit-ev') as HTMLElement;

    fireEvent.pointerDown(block, pointer(250, BODY_TOP + yFor(540)));
    windowPointer('pointermove', 250, BODY_TOP + yFor(600));
    windowPointer('pointerup', 250, BODY_TOP + yFor(600));

    expect(onMoveBlock).not.toHaveBeenCalled();
  });

  it('gaps present but snapToGap finds nothing for a ghost either: reverts, no callback', () => {
    const onMoveProposal = vi.fn();
    const p = proposal();
    const { container } = render(
      <WeekGrid {...baseProps({ gaps: [], proposals: [p], onMoveProposal })} />,
    );
    installGeometry(container);
    const ghost = container.querySelector('.weekfit-ghost') as HTMLElement;

    fireEvent.pointerDown(ghost, pointer(250, BODY_TOP + yFor(600)));
    windowPointer('pointermove', 250, BODY_TOP + yFor(660));
    windowPointer('pointerup', 250, BODY_TOP + yFor(660));

    expect(onMoveProposal).not.toHaveBeenCalled();
  });
});

describe('WeekGrid — click vs. drag on a real block', () => {
  it('a plain click (no movement) opens the source, and does not move it', () => {
    const onOpenSource = vi.fn();
    const onMoveBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:11',
      start: dateAt(WEDNESDAY, 9, 0),
      end: dateAt(WEDNESDAY, 10, 0),
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], onOpenSource, onMoveBlock })} />,
    );
    installGeometry(container);
    const block = container.querySelector('.weekfit-ev') as HTMLElement;

    fireEvent.pointerDown(block, pointer(250, 100));
    windowPointer('pointerup', 250, 100);

    expect(onOpenSource).toHaveBeenCalledTimes(1);
    expect(onOpenSource).toHaveBeenCalledWith('Weekly/2026-W36.md:11');
    expect(onMoveBlock).not.toHaveBeenCalled();
  });

  it('a real drag (past the 4px threshold) does not open the source', () => {
    const onOpenSource = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:12',
      start: dateAt(WEDNESDAY, 9, 0),
      end: dateAt(WEDNESDAY, 10, 0),
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: null, onOpenSource })} />,
    );
    installGeometry(container);
    const block = container.querySelector('.weekfit-ev') as HTMLElement;

    fireEvent.pointerDown(block, pointer(250, 100));
    windowPointer('pointermove', 250, 140); // past the 4px threshold
    windowPointer('pointerup', 250, 140);

    expect(onOpenSource).not.toHaveBeenCalled();
  });
});

describe('WeekGrid — edge-drag resize', () => {
  // Same geometry as the suites above: startHour=5 (300min), pxPerHour=46.
  // yFor(min) lands exactly on a lattice point for any multiple of 30.
  const yFor = (min: number) => ((min - 300) / 60) * 46;

  function resizeHandle(container: HTMLElement, blockSelector: string, edge: 'top' | 'bottom') {
    return container.querySelector(`${blockSelector} .weekfit-resize--${edge}`) as HTMLElement;
  }

  it('dragging the bottom edge down extends the block by that delta, start unchanged', () => {
    const onResizeBlock = vi.fn();
    const onMoveBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:20',
      start: dateAt(WEDNESDAY, 9, 0), // startMin 540
      end: dateAt(WEDNESDAY, 10, 0), // endMin 600
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: null, onResizeBlock, onMoveBlock })} />,
    );
    installGeometry(container);
    const handle = resizeHandle(container, '.weekfit-ev', 'bottom');

    // Grab exactly on the bottom edge (offset 0) and pull it down 30 minutes.
    fireEvent.pointerDown(handle, pointer(250, BODY_TOP + yFor(600)));
    windowPointer('pointermove', 250, BODY_TOP + yFor(630));
    windowPointer('pointerup', 250, BODY_TOP + yFor(630));

    expect(onResizeBlock).toHaveBeenCalledTimes(1);
    expect(onResizeBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:20', 540, 630);
    // A resize must never also move the block or open its source.
    expect(onMoveBlock).not.toHaveBeenCalled();
  });

  it('dragging the top edge up extends it upward, end unchanged', () => {
    const onResizeBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:21',
      start: dateAt(WEDNESDAY, 10, 0), // startMin 600
      end: dateAt(WEDNESDAY, 11, 0), // endMin 660
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: null, onResizeBlock })} />,
    );
    installGeometry(container);
    const handle = resizeHandle(container, '.weekfit-ev', 'top');

    // Grab exactly on the top edge (offset 0) and pull it up 30 minutes.
    fireEvent.pointerDown(handle, pointer(250, BODY_TOP + yFor(600)));
    windowPointer('pointermove', 250, BODY_TOP + yFor(570));
    windowPointer('pointerup', 250, BODY_TOP + yFor(570));

    expect(onResizeBlock).toHaveBeenCalledTimes(1);
    expect(onResizeBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:21', 570, 660);
  });

  it('dragging the bottom edge up past the top clamps to a 30-minute minimum instead of inverting', () => {
    const onResizeBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:22',
      start: dateAt(WEDNESDAY, 9, 0), // startMin 540
      end: dateAt(WEDNESDAY, 10, 0), // endMin 600
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: null, onResizeBlock })} />,
    );
    installGeometry(container);
    const handle = resizeHandle(container, '.weekfit-ev', 'bottom');

    fireEvent.pointerDown(handle, pointer(250, BODY_TOP + yFor(600)));
    // Fling the pointer far above the block's own start — without the
    // minimum-duration clamp this would invert the block (end before start).
    windowPointer('pointermove', 250, BODY_TOP - 5000);
    windowPointer('pointerup', 250, BODY_TOP - 5000);

    // start(540) + one lattice step(30) = 570, never below or equal to start.
    expect(onResizeBlock).toHaveBeenCalledTimes(1);
    expect(onResizeBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:22', 540, 570);
  });

  it('dragging the top edge down past the bottom clamps to a 30-minute minimum instead of inverting', () => {
    const onResizeBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:23',
      start: dateAt(WEDNESDAY, 9, 0), // startMin 540
      end: dateAt(WEDNESDAY, 10, 0), // endMin 600
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: null, onResizeBlock })} />,
    );
    installGeometry(container);
    const handle = resizeHandle(container, '.weekfit-ev', 'top');

    fireEvent.pointerDown(handle, pointer(250, BODY_TOP + yFor(540)));
    // Fling the pointer far below the block's own end.
    windowPointer('pointermove', 250, BODY_TOP + 100000);
    windowPointer('pointerup', 250, BODY_TOP + 100000);

    // end(600) - one lattice step(30) = 570, never past or equal to end.
    expect(onResizeBlock).toHaveBeenCalledTimes(1);
    expect(onResizeBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:23', 570, 600);
  });

  it('clamps at the grid bounds: the top edge cannot be pulled above the grid floor', () => {
    const onResizeBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:24',
      start: dateAt(WEDNESDAY, 10, 0), // startMin 600, far from the min-duration bound
      end: dateAt(WEDNESDAY, 11, 0), // endMin 660
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: null, onResizeBlock })} />,
    );
    installGeometry(container);
    const handle = resizeHandle(container, '.weekfit-ev', 'top');

    fireEvent.pointerDown(handle, pointer(250, BODY_TOP + yFor(600)));
    windowPointer('pointermove', 250, BODY_TOP - 5000);
    windowPointer('pointerup', 250, BODY_TOP - 5000);

    // The grid's own floor (startHour*60 = 300), not the much looser
    // min-duration bound (660-30=630) — proof the grid clamp is what's biting.
    expect(onResizeBlock).toHaveBeenCalledTimes(1);
    expect(onResizeBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:24', 300, 660);
  });

  it('clamps at the grid bounds: the bottom edge cannot be pulled below the grid ceiling', () => {
    const onResizeBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:25',
      start: dateAt(WEDNESDAY, 20, 0), // startMin 1200, far from the min-duration bound
      end: dateAt(WEDNESDAY, 21, 0), // endMin 1260
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: null, onResizeBlock })} />,
    );
    installGeometry(container);
    const handle = resizeHandle(container, '.weekfit-ev', 'bottom');

    fireEvent.pointerDown(handle, pointer(250, BODY_TOP + yFor(1260)));
    windowPointer('pointermove', 250, BODY_TOP + 100000);
    windowPointer('pointerup', 250, BODY_TOP + 100000);

    // `minutesForY` (lib/grid.ts, not owned by this feature) itself floors a
    // pointer position to endHour*60-30 = 1410 — one lattice step short of
    // midnight, the same ceiling the pre-existing move-drag bottom-bound test
    // above hits. This proves the resize clamp passes that value through
    // rather than doing something else with it.
    expect(onResizeBlock).toHaveBeenCalledTimes(1);
    expect(onResizeBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:25', 1200, 1410);
  });

  it('snaps the moving edge to the 30-minute lattice', () => {
    const onResizeBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:26',
      start: dateAt(WEDNESDAY, 7, 15), // startMin 435 — off-lattice on purpose
      end: dateAt(WEDNESDAY, 9, 0), // endMin 540
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: null, onResizeBlock })} />,
    );
    installGeometry(container);
    const handle = resizeHandle(container, '.weekfit-ev', 'top');

    // minutesForY(y)=450 (07:30) at pointerdown -> grabOffsetMin = 450-435 = 15.
    fireEvent.pointerDown(handle, pointer(250, BODY_TOP + yFor(450)));
    windowPointer('pointermove', 250, BODY_TOP + yFor(480));
    windowPointer('pointerup', 250, BODY_TOP + yFor(480));

    // raw = minutesAt(480) - grabOffsetMin(15) = 465, which snapToGrid rounds
    // up to 480 (08:00) rather than leaving it at the off-lattice 465.
    expect(onResizeBlock).toHaveBeenCalledTimes(1);
    expect(onResizeBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:26', 480, 540);
  });

  it('does not call onMoveBlock or onOpenSource for a resize', () => {
    const onResizeBlock = vi.fn();
    const onMoveBlock = vi.fn();
    const onOpenSource = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:27',
      start: dateAt(WEDNESDAY, 9, 0),
      end: dateAt(WEDNESDAY, 10, 0),
    });
    const { container } = render(
      <WeekGrid
        {...baseProps({ scheduled: [ev], gaps: null, onResizeBlock, onMoveBlock, onOpenSource })}
      />,
    );
    installGeometry(container);
    const handle = resizeHandle(container, '.weekfit-ev', 'bottom');

    fireEvent.pointerDown(handle, pointer(250, BODY_TOP + yFor(600)));
    windowPointer('pointermove', 250, BODY_TOP + yFor(630));
    windowPointer('pointerup', 250, BODY_TOP + yFor(630));

    expect(onResizeBlock).toHaveBeenCalledTimes(1);
    expect(onMoveBlock).not.toHaveBeenCalled();
    expect(onOpenSource).not.toHaveBeenCalled();
  });

  it('fires the callback once, on pointer-up, not per move', () => {
    const onResizeBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:28',
      start: dateAt(WEDNESDAY, 9, 0),
      end: dateAt(WEDNESDAY, 10, 0),
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: null, onResizeBlock })} />,
    );
    installGeometry(container);
    const handle = resizeHandle(container, '.weekfit-ev', 'bottom');

    fireEvent.pointerDown(handle, pointer(250, BODY_TOP + yFor(600)));
    // Several intermediate moves before release — none of them should fire
    // the callback, only the final pointer-up.
    windowPointer('pointermove', 250, BODY_TOP + yFor(630));
    windowPointer('pointermove', 250, BODY_TOP + yFor(660));
    windowPointer('pointermove', 250, BODY_TOP + yFor(600));
    windowPointer('pointermove', 250, BODY_TOP + yFor(690));
    expect(onResizeBlock).not.toHaveBeenCalled();

    windowPointer('pointerup', 250, BODY_TOP + yFor(690));

    expect(onResizeBlock).toHaveBeenCalledTimes(1);
    expect(onResizeBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:28', 540, 690);
  });

  // Regression guard for the bug WeekGrid was just rewritten to fix — see the
  // "grab offset is preserved" suite above for the move-drag original. The
  // same class of bug (a React onPointerMove/onPointerUp prop on the handle
  // itself, which only fires while the cursor stays over a 6px-tall strip)
  // would be *worse* for a resize handle than for a whole block, since the
  // hit target is far smaller and a fast drag leaves it almost immediately.
  it('tracks a resize via pointermove/pointerup dispatched on window, not the handle', () => {
    const onResizeBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:29',
      start: dateAt(WEDNESDAY, 9, 0),
      end: dateAt(WEDNESDAY, 10, 0),
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], gaps: null, onResizeBlock })} />,
    );
    installGeometry(container);
    const handle = resizeHandle(container, '.weekfit-ev', 'bottom');

    fireEvent.pointerDown(handle, pointer(250, BODY_TOP + yFor(600)));
    // Dispatched on `window`, never on `handle` — a window-targeted
    // PointerEvent never bubbles down into the handle's subtree, so only a
    // real `window.addEventListener` (not a React prop on the handle) can
    // observe this.
    windowPointer('pointermove', 250, BODY_TOP + yFor(630));
    windowPointer('pointerup', 250, BODY_TOP + yFor(630));

    expect(onResizeBlock).toHaveBeenCalledTimes(1);
    expect(onResizeBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:29', 540, 630);
  });

  it('resizes a ghost via onResizeProposal, bottom edge', () => {
    const onResizeProposal = vi.fn();
    const onMoveProposal = vi.fn();
    const p = proposal({ day: 2, startMin: 570, endMin: 660, minutes: 90 });
    const { container } = render(
      <WeekGrid {...baseProps({ proposals: [p], onResizeProposal, onMoveProposal })} />,
    );
    installGeometry(container);
    const handle = resizeHandle(container, '.weekfit-ghost', 'bottom');

    fireEvent.pointerDown(handle, pointer(250, BODY_TOP + yFor(660)));
    windowPointer('pointermove', 250, BODY_TOP + yFor(690));
    windowPointer('pointerup', 250, BODY_TOP + yFor(690));

    expect(onResizeProposal).toHaveBeenCalledTimes(1);
    expect(onResizeProposal).toHaveBeenCalledWith('Weekly/2026-W36.md:5', 570, 690);
    expect(onMoveProposal).not.toHaveBeenCalled();
  });

  it('resizes a ghost via onResizeProposal, top edge, and clamps its minimum duration', () => {
    const onResizeProposal = vi.fn();
    const p = proposal({ day: 2, startMin: 570, endMin: 660, minutes: 90 });
    const { container } = render(
      <WeekGrid {...baseProps({ proposals: [p], onResizeProposal })} />,
    );
    installGeometry(container);
    const handle = resizeHandle(container, '.weekfit-ghost', 'top');

    fireEvent.pointerDown(handle, pointer(250, BODY_TOP + yFor(570)));
    // Fling far past the ghost's own end — must clamp to a 30-minute
    // minimum, not invert.
    windowPointer('pointermove', 250, BODY_TOP + 100000);
    windowPointer('pointerup', 250, BODY_TOP + 100000);

    expect(onResizeProposal).toHaveBeenCalledTimes(1);
    expect(onResizeProposal).toHaveBeenCalledWith('Weekly/2026-W36.md:5', 630, 660);
  });

  it('a very short block keeps only the bottom resize handle', () => {
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:30',
      start: dateAt(WEDNESDAY, 9, 0),
      end: dateAt(WEDNESDAY, 9, 15), // 15 minutes -> well under the 24px floor
    });
    const { container } = render(<WeekGrid {...baseProps({ scheduled: [ev], gaps: null })} />);
    installGeometry(container);

    expect(container.querySelector('.weekfit-ev .weekfit-resize--bottom')).not.toBeNull();
    expect(container.querySelector('.weekfit-ev .weekfit-resize--top')).toBeNull();
  });
});

describe('WeekGrid — conflict marking', () => {
  // Same geometry as the suites above.
  const yFor = (min: number) => ((min - 300) / 60) * 46;

  function resizeHandleFor(container: HTMLElement, blockSelector: string, edge: 'top' | 'bottom') {
    return container.querySelector(`${blockSelector} .weekfit-resize--${edge}`) as HTMLElement;
  }

  it('a block dragged onto a recurring block from settings.blocks gets the conflict marker, naming it', () => {
    const onMoveBlock = vi.fn();
    const gym = skeletonBlock({ name: 'Gym', days: [2], startMin: 600, endMin: 660 });
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:40',
      start: dateAt(WEDNESDAY, 9, 0), // startMin 540
      end: dateAt(WEDNESDAY, 10, 0), // endMin 600, duration 60
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], blocks: [gym], gaps: null, onMoveBlock })} />,
    );
    installGeometry(container);
    const block = container.querySelector('.weekfit-ev') as HTMLElement;

    // Grab the block at its own top edge (offset 0) and drag it down 60
    // minutes, landing it squarely on Gym's 10:00-11:00 slot.
    fireEvent.pointerDown(block, pointer(250, BODY_TOP + yFor(540)));
    windowPointer('pointermove', 250, BODY_TOP + yFor(600));

    // Live preview, before pointerup — this is the "before you release"
    // half of the feature, not only "after it lands".
    expect(block.className).toContain('weekfit-ev--conflict');
    expect(block.getAttribute('aria-label')).toMatch(/gym/i);

    windowPointer('pointerup', 250, BODY_TOP + yFor(600));

    // Marking, never refusing: the drop still lands and the callback fires.
    expect(onMoveBlock).toHaveBeenCalledTimes(1);
    expect(onMoveBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:40', 2, 600);
  });

  it('a block dragged onto another scheduled block gets the conflict marker, naming that block', () => {
    const onMoveBlock = vi.fn();
    const other = calEvent({
      uid: 'Weekly/2026-W36.md:41',
      title: 'Team Sync',
      start: dateAt(WEDNESDAY, 10, 0), // 600
      end: dateAt(WEDNESDAY, 11, 0), // 660
    });
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:42',
      start: dateAt(WEDNESDAY, 9, 0), // 540
      end: dateAt(WEDNESDAY, 10, 0), // 600
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev, other], gaps: null, onMoveBlock })} />,
    );
    installGeometry(container);
    // `ev` renders first — `scheduled`'s own order, preserved by the filter
    // in WeekGrid — so it's the first `.weekfit-ev` in the DOM.
    const block = container.querySelectorAll('.weekfit-ev')[0] as HTMLElement;

    fireEvent.pointerDown(block, pointer(250, BODY_TOP + yFor(540)));
    windowPointer('pointermove', 250, BODY_TOP + yFor(600));

    expect(block.className).toContain('weekfit-ev--conflict');
    expect(block.getAttribute('aria-label')).toMatch(/team sync/i);

    windowPointer('pointerup', 250, BODY_TOP + yFor(600));

    expect(onMoveBlock).toHaveBeenCalledTimes(1);
    expect(onMoveBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:42', 2, 600);
  });

  it('a block dragged to a free slot does not get the conflict marker', () => {
    const onMoveBlock = vi.fn();
    const gym = skeletonBlock({ days: [2], startMin: 900, endMin: 960 }); // 15:00-16:00, well clear
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:43',
      start: dateAt(WEDNESDAY, 9, 0), // 540
      end: dateAt(WEDNESDAY, 10, 0), // 600
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], blocks: [gym], gaps: null, onMoveBlock })} />,
    );
    installGeometry(container);
    const block = container.querySelector('.weekfit-ev') as HTMLElement;

    fireEvent.pointerDown(block, pointer(250, BODY_TOP + yFor(540)));
    windowPointer('pointermove', 250, BODY_TOP + yFor(630)); // -> 10:30-11:30, still clear

    expect(block.className).not.toContain('weekfit-ev--conflict');
    expect(container.querySelector('.weekfit-ev__conflict')).toBeNull();

    windowPointer('pointerup', 250, BODY_TOP + yFor(630));
    expect(onMoveBlock).toHaveBeenCalledTimes(1);
    expect(onMoveBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:43', 2, 630);
  });

  it('a block never conflicts with itself, even overlapping its own original position mid-drag', () => {
    const onMoveBlock = vi.fn();
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:44',
      start: dateAt(WEDNESDAY, 9, 0), // 540
      end: dateAt(WEDNESDAY, 10, 0), // 600
    });
    // `ev` is the *only* thing on the board — the sole possible source of a
    // false-positive conflict is its own (unmoved) entry in `scheduled`.
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], blocks: [], gaps: null, onMoveBlock })} />,
    );
    installGeometry(container);
    const block = container.querySelector('.weekfit-ev') as HTMLElement;

    // Nudge it 30 minutes — the live preview (9:30-10:30) still overlaps the
    // block's own original position (9:00-10:00) sitting untouched in
    // `scheduled`. A broken self-exclusion would flag this.
    fireEvent.pointerDown(block, pointer(250, BODY_TOP + yFor(540)));
    windowPointer('pointermove', 250, BODY_TOP + yFor(570));

    expect(block.className).not.toContain('weekfit-ev--conflict');

    windowPointer('pointerup', 250, BODY_TOP + yFor(570));
    expect(onMoveBlock).toHaveBeenCalledTimes(1);
    expect(onMoveBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:44', 2, 570);
  });

  it('a resize that grows a block into a recurring commitment flags it, and the release still fires onResizeBlock', () => {
    const onResizeBlock = vi.fn();
    const gym = skeletonBlock({ name: 'Gym', days: [2], startMin: 630, endMin: 690 }); // 10:30-11:30
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:45',
      start: dateAt(WEDNESDAY, 9, 0), // 540
      end: dateAt(WEDNESDAY, 10, 0), // 600
    });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], blocks: [gym], gaps: null, onResizeBlock })} />,
    );
    installGeometry(container);
    const handle = resizeHandleFor(container, '.weekfit-ev', 'bottom');
    const block = container.querySelector('.weekfit-ev') as HTMLElement;

    // Drag the bottom edge from 600 to 660 — grows the block into Gym's
    // 10:30-11:30 slot (630-660 overlap).
    fireEvent.pointerDown(handle, pointer(250, BODY_TOP + yFor(600)));
    windowPointer('pointermove', 250, BODY_TOP + yFor(660));

    expect(block.className).toContain('weekfit-ev--conflict');
    expect(block.getAttribute('aria-label')).toMatch(/gym/i);

    windowPointer('pointerup', 250, BODY_TOP + yFor(660));

    expect(onResizeBlock).toHaveBeenCalledTimes(1);
    expect(onResizeBlock).toHaveBeenCalledWith('Weekly/2026-W36.md:45', 540, 660);
  });

  it('a ghost resized into a scheduled block gets the conflict marker, and the release still fires onResizeProposal', () => {
    const onResizeProposal = vi.fn();
    const other = calEvent({
      uid: 'Weekly/2026-W36.md:46',
      title: 'Standup',
      start: dateAt(WEDNESDAY, 11, 0), // 660
      end: dateAt(WEDNESDAY, 11, 30), // 690
    });
    const p = proposal({ day: 2, startMin: 570, endMin: 660, minutes: 90 });
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [other], proposals: [p], onResizeProposal })} />,
    );
    installGeometry(container);
    const handle = resizeHandleFor(container, '.weekfit-ghost', 'bottom');
    const ghost = container.querySelector('.weekfit-ghost') as HTMLElement;

    fireEvent.pointerDown(handle, pointer(250, BODY_TOP + yFor(660)));
    windowPointer('pointermove', 250, BODY_TOP + yFor(690));

    // GhostBlock names the conflict in its `title` (tooltip), not its
    // `aria-label` — see `GhostBlock`'s own `conflictLabel`/`title` split.
    expect(ghost.className).toContain('weekfit-ghost--conflict');
    expect(ghost.getAttribute('title')).toMatch(/standup/i);

    windowPointer('pointerup', 250, BODY_TOP + yFor(690));

    expect(onResizeProposal).toHaveBeenCalledTimes(1);
    expect(onResizeProposal).toHaveBeenCalledWith('Weekly/2026-W36.md:5', 570, 690);
  });

  it('a conflicting ghost and a conflicting real block stay visually distinguishable', () => {
    const gym = skeletonBlock({ name: 'Gym', days: [2], startMin: 600, endMin: 660 });
    const ev = calEvent({
      uid: 'Weekly/2026-W36.md:47',
      start: dateAt(WEDNESDAY, 10, 0), // 600 — already sitting on Gym
      end: dateAt(WEDNESDAY, 11, 0), // 660
    });
    const p = proposal({ day: 2, startMin: 600, endMin: 690, minutes: 90 }); // also overlaps Gym
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [ev], blocks: [gym], proposals: [p], gaps: null })} />,
    );
    installGeometry(container);

    const block = container.querySelector('.weekfit-ev') as HTMLElement;
    const ghost = container.querySelector('.weekfit-ghost') as HTMLElement;

    // Both flagged...
    expect(block.className).toContain('weekfit-ev--conflict');
    expect(ghost.className).toContain('weekfit-ghost--conflict');

    // ...but never with each other's marker — a ghost in conflict must never
    // read as a committed block in conflict, or vice versa.
    expect(block.className).not.toContain('weekfit-ghost--conflict');
    expect(ghost.className).not.toContain('weekfit-ev--conflict');
    // The pre-existing real-vs-ghost distinction (solid vs. dashed, `weekfit-ev`
    // vs. `weekfit-ghost`) still holds independent of the conflict marker.
    expect(block.className).toContain('weekfit-ev');
    expect(ghost.className).toContain('weekfit-ghost');
  });
});

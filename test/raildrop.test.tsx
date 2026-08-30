import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeekGrid } from '../src/components/WeekGrid';
import type { WeekGridProps } from '../src/components/WeekGrid';
import { startOfISOWeek } from '../src/lib/week';
import type { CalEvent, SkeletonBlock } from '../src/lib/types';
import type { Proposal } from '../src/lib/gaps';

afterEach(cleanup);

const NOW = new Date(2026, 7, 31, 10, 0);
const WEEK_START = startOfISOWeek(NOW);

function calEvent(over: Partial<CalEvent> = {}): CalEvent {
  const start = new Date(WEEK_START);
  start.setHours(10, 0, 0, 0);
  const end = new Date(WEEK_START);
  end.setHours(11, 0, 0, 0);
  return { uid: 'Weekly/2026-W36.md:2', title: 'Team sync', start, end, allDay: false, ...over };
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    key: 'k',
    groupKey: 'g',
    kind: 'fit',
    file: 'Weekly/2026-W36.md',
    line: 3,
    text: '- [ ] Write report',
    title: 'Write report',
    minutes: 60,
    day: 0,
    startMin: 600,
    endMin: 660,
    window: 'work',
    ...over,
  };
}

function baseProps(over: Partial<WeekGridProps> = {}): WeekGridProps {
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
    incoming: null,
    onDropTask: vi.fn(),
    onIncomingEnd: vi.fn(),
    ...over,
  };
}

/** The rail sits to the right of the grid in this fixture: anything with
 *  clientX >= 900 counts as over it. */
const overRail = (x: number) => x >= 900;
const isOverRail = (x: number, _y: number) => overRail(x);

function windowPointer(type: 'pointermove' | 'pointerup', clientX: number, clientY: number) {
  act(() => {
    window.dispatchEvent(new PointerEvent(type, { clientX, clientY, pointerId: 1, bubbles: true }));
  });
}

describe('dragging back onto the rail', () => {
  // The mirror of dragging a task out of the rail, and the gesture people
  // reach for first — previously the only way off the week was the block's own
  // Unschedule button.
  it('unschedules a real block dropped on the rail', () => {
    const onUnschedule = vi.fn();
    const onMoveBlock = vi.fn();
    const { container } = render(
      <WeekGrid
        {...baseProps({ scheduled: [calEvent()], onUnschedule, onMoveBlock, isOverRail })}
      />,
    );

    const block = container.querySelector('.weekfit-ev') as HTMLElement;
    expect(block).toBeTruthy();
    fireEvent.pointerDown(block, { clientX: 50, clientY: 300, pointerId: 1 });
    windowPointer('pointermove', 950, 300); // out over the rail
    windowPointer('pointerup', 950, 300);

    expect(onUnschedule).toHaveBeenCalledWith('Weekly/2026-W36.md:2');
    // And emphatically not re-timed to whichever column is nearest.
    expect(onMoveBlock).not.toHaveBeenCalled();
  });

  it('dismisses a ghost dropped on the rail', () => {
    const onDismiss = vi.fn();
    const onMoveProposal = vi.fn();
    const { container } = render(
      <WeekGrid {...baseProps({ proposals: [proposal()], onDismiss, onMoveProposal, isOverRail })} />,
    );

    const ghost = container.querySelector('.weekfit-ghost') as HTMLElement;
    expect(ghost).toBeTruthy();
    fireEvent.pointerDown(ghost, { clientX: 50, clientY: 300, pointerId: 1 });
    windowPointer('pointermove', 950, 300);
    windowPointer('pointerup', 950, 300);

    expect(onDismiss).toHaveBeenCalledWith('g');
    expect(onMoveProposal).not.toHaveBeenCalled();
  });

  it('a drop inside the grid is still a move, not an unschedule', () => {
    const onUnschedule = vi.fn();
    const { container } = render(
      <WeekGrid {...baseProps({ scheduled: [calEvent()], onUnschedule, isOverRail })} />,
    );

    const block = container.querySelector('.weekfit-ev') as HTMLElement;
    fireEvent.pointerDown(block, { clientX: 50, clientY: 300, pointerId: 1 });
    windowPointer('pointermove', 120, 340);
    windowPointer('pointerup', 120, 340);

    expect(onUnschedule).not.toHaveBeenCalled();
  });

  it('a click without movement still opens the source rather than unscheduling', () => {
    const onUnschedule = vi.fn();
    const onOpenSource = vi.fn();
    const { container } = render(
      <WeekGrid
        {...baseProps({ scheduled: [calEvent()], onUnschedule, onOpenSource, isOverRail })}
      />,
    );

    const block = container.querySelector('.weekfit-ev') as HTMLElement;
    fireEvent.pointerDown(block, { clientX: 50, clientY: 300, pointerId: 1 });
    windowPointer('pointerup', 50, 300);

    expect(onOpenSource).toHaveBeenCalled();
    expect(onUnschedule).not.toHaveBeenCalled();
  });
});

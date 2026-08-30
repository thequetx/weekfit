import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeekGrid } from '../src/components/WeekGrid';
import type { WeekGridProps } from '../src/components/WeekGrid';
import { startOfISOWeek } from '../src/lib/week';
import type { SkeletonBlock } from '../src/lib/types';
import type { Proposal } from '../src/lib/gaps';

afterEach(cleanup);

const NOW = new Date(2026, 7, 31, 10, 0);
const WEEK_START = startOfISOWeek(NOW);

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    key: 'k1',
    groupKey: 'g1',
    kind: 'fit',
    file: 'Weekly/2026-W36.md',
    line: 3,
    text: '- [ ] Rebuild the overlay ~6h',
    title: 'Rebuild the overlay',
    minutes: 120,
    day: 0,
    startMin: 9 * 60,
    endMin: 11 * 60,
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

/** Two sittings of one task: same groupKey, different keys. */
const sittings = [
  proposal({ key: 'g1#0', session: 1, sessions: 2, day: 0 }),
  proposal({ key: 'g1#1', session: 2, sessions: 2, day: 2 }),
];

function windowPointer(type: 'pointermove' | 'pointerup', x: number, y: number) {
  act(() => {
    window.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true }));
  });
}

describe('a split’s sittings are individually movable', () => {
  // Reported: splitting stacked the entries on top of each other so they read
  // as one. `moveProposal` matched on `groupKey`, so dragging any sitting
  // moved every sitting of that task to the identical slot.
  it('dragging one sitting reports that sitting’s own key, not the group', () => {
    const onMoveProposal = vi.fn();
    const { container } = render(
      <WeekGrid {...baseProps({ proposals: sittings, onMoveProposal })} />,
    );
    const ghosts = container.querySelectorAll('.weekfit-ghost');
    expect(ghosts.length).toBe(2);

    fireEvent.pointerDown(ghosts[0], { clientX: 50, clientY: 300, pointerId: 1 });
    windowPointer('pointermove', 120, 360);
    windowPointer('pointerup', 120, 360);

    expect(onMoveProposal).toHaveBeenCalledTimes(1);
    // The individual sitting, never the shared group id.
    expect(onMoveProposal.mock.calls[0][0]).toBe('g1#0');
    expect(onMoveProposal.mock.calls[0][0]).not.toBe('g1');
  });

  it('resizing one sitting likewise reports its own key', () => {
    const onResizeProposal = vi.fn();
    const { container } = render(
      <WeekGrid {...baseProps({ proposals: sittings, onResizeProposal })} />,
    );
    const handle = container.querySelector('.weekfit-ghost .weekfit-resize--bottom') as HTMLElement;
    expect(handle).toBeTruthy();

    fireEvent.pointerDown(handle, { clientX: 50, clientY: 340, pointerId: 1 });
    windowPointer('pointermove', 50, 400);
    windowPointer('pointerup', 50, 400);

    expect(onResizeProposal).toHaveBeenCalledTimes(1);
    expect(onResizeProposal.mock.calls[0][0]).toBe('g1#0');
  });
});

describe('a split says that accepting takes the whole task', () => {
  // Reported as unintended: accepting one sitting accepted both. It is how the
  // format works — the sittings are written as one set of children — so the
  // fix is to stop the button implying otherwise.
  it('labels Accept and Dismiss with the number of sittings', () => {
    render(<WeekGrid {...baseProps({ proposals: sittings })} />);
    expect(screen.getAllByRole('button', { name: /accept all 2/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /dismiss all 2/i }).length).toBeGreaterThan(0);
  });

  it('a lone proposal keeps the plain labels', () => {
    render(<WeekGrid {...baseProps({ proposals: [proposal()] })} />);
    expect(screen.getByRole('button', { name: /^accept$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^dismiss$/i })).toBeInTheDocument();
  });
});

describe('a short ghost can still be accepted', () => {
  // Reported: half-hour blocks hid the controls entirely, so a 30-minute
  // proposal could be neither accepted nor dismissed.
  it('lifts its actions out of the block rather than clipping them', () => {
    const { container } = render(
      <WeekGrid
        {...baseProps({ proposals: [proposal({ minutes: 30, startMin: 9 * 60, endMin: 9 * 60 + 30 })] })}
      />,
    );
    const actions = container.querySelector('.weekfit-ghost__actions');
    expect(actions).toBeTruthy();
    expect(actions!.classList.contains('weekfit-ghost__actions--escape')).toBe(true);
    // And they are still real, clickable buttons.
    expect(screen.getByRole('button', { name: /^accept$/i })).toBeInTheDocument();
  });

  it('a tall ghost keeps its actions in flow', () => {
    const { container } = render(
      <WeekGrid {...baseProps({ proposals: [proposal({ minutes: 180, endMin: 12 * 60 })] })} />,
    );
    const actions = container.querySelector('.weekfit-ghost__actions');
    expect(actions!.classList.contains('weekfit-ghost__actions--escape')).toBe(false);
  });
});

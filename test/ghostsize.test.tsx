import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { WeekGrid } from '../src/components/WeekGrid';
import type { WeekGridProps } from '../src/components/WeekGrid';
import type { Proposal } from '../src/lib/gaps';
import type { SkeletonBlock } from '../src/lib/types';
import { GRID } from '../src/config';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WEEK_START = new Date(2026, 7, 31);
const NOW = new Date(2026, 7, 31, 8, 0);

function proposal(startMin: number, minutes: number, title = 'Chase the invoice'): Proposal {
  return {
    key: `Weekly/2026-W36.md:${startMin}`,
    groupKey: `Weekly/2026-W36.md:${startMin}`,
    kind: 'fit',
    file: 'Weekly/2026-W36.md',
    line: 5,
    text: `- [ ] ${title}`,
    title,
    minutes,
    day: 0,
    startMin,
    endMin: startMin + minutes,
    window: 'work',
  };
}

function grid(proposals: Proposal[], overrides: Partial<WeekGridProps> = {}) {
  return render(
    <WeekGrid
      weekStart={WEEK_START}
      now={NOW}
      scheduled={[]}
      blocks={[] as SkeletonBlock[]}
      gaps={null}
      showGaps={false}
      proposals={proposals}
      onAccept={vi.fn()}
      onDismiss={vi.fn()}
      onMoveProposal={vi.fn()}
      onMoveBlock={vi.fn()}
      onUnschedule={vi.fn()}
      onOpenSource={vi.fn()}
      onResizeBlock={vi.fn()}
      incoming={null}
      onDropTask={() => {}}
      onIncomingEnd={() => {}}
      onResizeProposal={vi.fn()}
      {...overrides}
    />,
  );
}

function ghost(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('.weekfit-ghost');
  expect(el, 'no ghost rendered').not.toBeNull();
  return el!;
}

/**
 * The board must never ask you to accept a block it hasn't named.
 *
 * jsdom has no layout, so none of this can check pixels — but the bug was
 * never a pixel. `__title` was the only flex item allowed to shrink, so on a
 * cramped ghost it was the one thing the browser dropped, and a 30-minute
 * proposal rendered as a truncated time and two buttons. What's testable is
 * the decision: which parts are put on the page at which height.
 */
describe('a ghost keeps its name at every height', () => {
  // 46px per hour: 30m is 23px, an hour 46px, 90m 69px.
  const px = (minutes: number) => (minutes / 60) * GRID.pxPerHour;

  it.each([15, 30, 45, 60, 90, 120, 180])('renders the title at %imin', (minutes) => {
    const { container } = grid([proposal(600, minutes)]);
    const title = ghost(container).querySelector('.weekfit-ghost__title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe('Chase the invoice');
  });

  it.each([15, 30, 45, 60, 90, 120, 180])('keeps both actions at %imin', (minutes) => {
    const { container } = grid([proposal(600, minutes)]);
    const g = ghost(container);
    expect(g.querySelector('.weekfit-ghost__accept')).not.toBeNull();
    expect(g.querySelector('.weekfit-ghost__dismiss')).not.toBeNull();
  });

  it('drops the time — and only the time — when it runs out of room', () => {
    const { container } = grid([proposal(600, 60)]);
    const g = ghost(container);
    expect(px(60)).toBeLessThan(56); // an hour is tight
    expect(g.classList.contains('weekfit-ghost--tight')).toBe(true);
    expect(g.querySelector('.weekfit-ghost__time')).toBeNull();
    expect(g.querySelector('.weekfit-ghost__title')).not.toBeNull();
  });

  it('shows the time once there is room for it', () => {
    const { container } = grid([proposal(600, 90)]);
    const g = ghost(container);
    expect(px(90)).toBeGreaterThanOrEqual(56);
    expect(g.classList.contains('weekfit-ghost--tight')).toBe(false);
    expect(g.querySelector('.weekfit-ghost__time')!.textContent).toContain('10');
  });

  // Dropping the visible time is only acceptable because it is still there
  // for anyone who needs it — the block's own label carries the full range.
  it('still states the time in the accessible label when it is not drawn', () => {
    const { container } = grid([proposal(600, 30)]);
    const g = ghost(container);
    expect(g.querySelector('.weekfit-ghost__time')).toBeNull();
    expect(g.getAttribute('aria-label')).toContain('10am–10:30am');
  });
});

describe('the escaped actions on a 30-minute ghost', () => {
  it('shrink to a glyph so the title still has somewhere to go', () => {
    const { container } = grid([proposal(600, 30)]);
    const g = ghost(container);
    expect(g.classList.contains('weekfit-ghost--escape')).toBe(true);
    expect(g.querySelector('.weekfit-ghost__accept')!.textContent).toBe('✓');
    expect(g.querySelector('.weekfit-ghost__dismiss')!.textContent).toBe('✕');
  });

  // A glyph is not a name. Losing the word from the button is only safe
  // because the accessible name never went anywhere.
  it('keep their full names for a screen reader and the tooltip', () => {
    const { container } = grid([proposal(600, 30)]);
    const accept = ghost(container).querySelector('.weekfit-ghost__accept')!;
    expect(accept.getAttribute('aria-label')).toBe('Accept this placement');
    expect(accept.getAttribute('title')).toBe('Accept this placement');
  });

  it('say how many sittings they cover when the task was split', () => {
    const { container } = grid([{ ...proposal(600, 30), session: 2, sessions: 3 }]);
    const accept = ghost(container).querySelector('.weekfit-ghost__accept')!;
    expect(accept.textContent).toBe('✓');
    expect(accept.getAttribute('aria-label')).toBe('Accept all 3 sittings of this task');
  });

  it('spell the words out again as soon as the ghost can hold them', () => {
    const { container } = grid([proposal(600, 90)]);
    const g = ghost(container);
    expect(g.classList.contains('weekfit-ghost--escape')).toBe(false);
    expect(g.querySelector('.weekfit-ghost__accept')!.textContent).toBe('Accept');
    expect(g.querySelector('.weekfit-ghost__dismiss')!.textContent).toBe('Dismiss');
  });
});

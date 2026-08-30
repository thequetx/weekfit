import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IntentionsRail } from '../src/components/IntentionsRail';
import { DEFAULT_SETTINGS } from '../src/data/contract';
import type { VaultTask } from '../src/lib/types';

afterEach(cleanup);

function task(text: string, line = 0): VaultTask {
  return { text: `- [ ] ${text}`, done: false, file: 'Weekly/2026-W36.md', line };
}

function rail(tasks: VaultTask[], handlers = {}) {
  return render(
    <IntentionsRail tasks={tasks} durations={DEFAULT_SETTINGS.durations} {...handlers} />,
  );
}

/**
 * The three chips the row already showed became the controls that set them.
 * The point of doing it that way is that a resting row looks exactly as it
 * did — so these tests care as much about what did *not* change.
 */
describe('the value is the control', () => {
  it.each([
    ['.weekfit-rail__due', 'onSetDue'],
    ['.weekfit-rail__est', 'onSetEstimate'],
    ['.weekfit-rail__pri', 'onSetPriority'],
  ])('%s is a real button that reports its task', (selector, handler) => {
    const spy = vi.fn();
    const t = task('Prep slides 📅 2026-09-04 🔺 ~90m', 3);
    const { container } = rail([t], { [handler]: spy });

    const el = container.querySelector(selector)!;
    expect(el.tagName).toBe('BUTTON');
    fireEvent.click(el);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(t);
  });

  // Every chip sits inside the row's drag handle area; a pointerdown that
  // bubbled would start dragging the task onto the grid instead of opening
  // a menu. The checkbox already had to solve this.
  it.each(['.weekfit-rail__due', '.weekfit-rail__est', '.weekfit-rail__pri'])(
    'clicking %s does not start a drag',
    (selector) => {
      const onDragStart = vi.fn();
      const { container } = rail([task('Prep slides ~90m')], { onDragStart });
      fireEvent.pointerDown(container.querySelector(selector)!);
      expect(onDragStart).not.toHaveBeenCalled();
    },
  );

  it('still opens the note when the title itself is clicked', () => {
    const onOpenTask = vi.fn();
    rail([task('Prep slides ~90m')], { onOpenTask });
    fireEvent.click(screen.getByText('Prep slides'));
    expect(onOpenTask).toHaveBeenCalledTimes(1);
  });
});

describe('a row with nothing set still offers to set it', () => {
  it('renders both controls, marked unset', () => {
    const { container } = rail([task('Book dentist')]);
    expect(container.querySelector('.weekfit-rail__due--unset')).not.toBeNull();
    expect(container.querySelector('.weekfit-rail__pri--unset')).not.toBeNull();
  });

  it('names them for a screen reader rather than showing a bare glyph', () => {
    rail([task('Book dentist')]);
    expect(
      screen.getByRole('button', { name: 'Set a due date for "Book dentist"' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Set priority for "Book dentist"' }),
    ).toBeInTheDocument();
  });

  // The duration is never unset — the ladder always resolves one — so its
  // chip always shows a value, and always with the `≈` when it was a guess.
  it('always shows a duration, with the guess marker when it was guessed', () => {
    const { container } = rail([task('Book dentist')]);
    const est = container.querySelector('.weekfit-rail__est')!;
    expect(est.textContent).toContain('≈');
    expect(est.classList.contains('weekfit-rail__est--override')).toBe(false);
  });

  it('drops the guess marker once a duration is written on the line', () => {
    const { container } = rail([task('Book dentist ~45m')]);
    const est = container.querySelector('.weekfit-rail__est')!;
    expect(est.textContent).not.toContain('≈');
    expect(est.textContent).toContain('45m');
  });
});

describe('what the row says has not changed', () => {
  it('still shows the due date, not a placeholder', () => {
    const { container } = rail([task('Prep slides 📅 2026-09-04')]);
    expect(container.querySelector('.weekfit-rail__due')!.textContent).not.toBe('+');
    expect(container.querySelector('.weekfit-rail__due--unset')).toBeNull();
  });

  it('still marks an overdue task overdue', () => {
    const { container } = rail([task('Prep slides 📅 2020-01-01')]);
    expect(container.querySelector('.weekfit-rail__due--overdue')).not.toBeNull();
  });

  it('leaves the task text alone — these controls only report a click', () => {
    const line = task('Prep slides 📅 2026-09-04 🔺 ~90m');
    const { container } = rail([line]);
    fireEvent.click(container.querySelector('.weekfit-rail__due')!);
    fireEvent.click(container.querySelector('.weekfit-rail__est')!);
    fireEvent.click(container.querySelector('.weekfit-rail__pri')!);
    expect(line.text).toBe('- [ ] Prep slides 📅 2026-09-04 🔺 ~90m');
  });

  it('does nothing at all when no handler is wired', () => {
    const { container } = rail([task('Prep slides ~90m')]);
    expect(() => {
      fireEvent.click(container.querySelector('.weekfit-rail__due')!);
      fireEvent.click(container.querySelector('.weekfit-rail__est')!);
      fireEvent.click(container.querySelector('.weekfit-rail__pri')!);
    }).not.toThrow();
  });
});

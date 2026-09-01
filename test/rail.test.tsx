import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { IntentionsRail } from '../src/components/IntentionsRail';
import type { CalEvent, DurationMap, VaultTask } from '../src/lib/types';

// vitest.config.ts doesn't run with `test.globals: true`, so
// @testing-library/react's automatic afterEach(cleanup) never registers —
// without this, each test's DOM piles up on top of the last one instead of
// starting fresh.
afterEach(cleanup);

const DURATIONS: DurationMap = {
  defaultMinutes: 60,
  byKind: { content: 45 },
};

// `parse.ts` stores the **whole raw line** in `VaultTask.text`, checkbox and
// all. Fixtures that omit the prefix are not the shape the rail ever sees, and
// that discrepancy is exactly what let the "already scheduled" exclusion ship
// broken behind a green test — `DAY_PLANNER_RE` is `^`-anchored, so it matched
// the bare body in the fixture and never matched a real line. So: prefix by
// default, and pass `raw: true` for the rare case that needs something else.
function task(
  text: string,
  opts: Partial<VaultTask> & { raw?: boolean } = {},
): VaultTask {
  const { raw, ...rest } = opts;
  return {
    text: raw ? text : `- [ ] ${text}`,
    done: false,
    file: 'Weekly/2026-W36.md',
    line: 0,
    ...rest,
  };
}

describe('IntentionsRail', () => {
  it('renders one row per unscheduled task, with metadata stripped from the title', () => {
    render(
      <IntentionsRail
        tasks={[task('Write the report ~90m 📅 2026-09-01 🔼')]}
        durations={DURATIONS}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(1);

    const title = items[0].querySelector('.weekfit-rail__title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe('Write the report');
    // The invisible-text bug class: raw metadata must never survive into the
    // rendered title, even though it's still used to drive the due/estimate
    // badges elsewhere on the row.
    expect(title!.textContent).not.toContain('~90m');
    expect(title!.textContent).not.toContain('📅');
    expect(title!.textContent).not.toContain('🔼');
  });

  it('shows an explicit ~90m estimate as "1h 30m", unmarked as a guess', () => {
    render(<IntentionsRail tasks={[task('Write the report ~90m')]} durations={DURATIONS} />);
    const est = document.querySelector('.weekfit-rail__est');
    expect(est).not.toBeNull();
    expect(est!.textContent).toBe('1h 30m');
    expect(est!.className).toContain('weekfit-rail__est--override');
    expect(est!.querySelector('.weekfit-rail__est-guess')).toBeNull();
  });

  it('sizes an untagged task from durations.byKind and marks it as a guess', () => {
    render(<IntentionsRail tasks={[task('Edit the clip #content')]} durations={DURATIONS} />);
    const est = document.querySelector('.weekfit-rail__est');
    expect(est).not.toBeNull();
    // 45 minutes from durations.byKind.content, not the 60m global fallback.
    expect(est!.textContent).toBe('≈45m');
    expect(est!.className).toContain('weekfit-rail__est--kind');
    expect(est!.querySelector('.weekfit-rail__est-guess')).not.toBeNull();
  });

  it('marks the global-fallback size as a guess too', () => {
    render(<IntentionsRail tasks={[task('Do the thing')]} durations={DURATIONS} />);
    const est = document.querySelector('.weekfit-rail__est');
    expect(est!.textContent).toBe('≈1h');
    expect(est!.className).toContain('weekfit-rail__est--default');
  });

  it('marks a task that is on the grid as scheduled, and still shows it', () => {
    const onGrid = task('Sits on the grid');
    const waiting = task('Not yet scheduled', { line: 1 });
    render(
      <IntentionsRail
        tasks={[onGrid, waiting]}
        scheduledLines={[onGrid]}
        durations={DURATIONS}
      />,
    );
    expect(screen.getByText('Sits on the grid').closest('.weekfit-rail__item')).toHaveClass(
      'weekfit-rail__item--scheduled',
    );
    expect(screen.getByText('Not yet scheduled').closest('.weekfit-rail__item')).toHaveClass(
      'weekfit-rail__item--unscheduled',
    );
  });

  it('shows a done task struck through rather than hiding it', () => {
    render(
      <IntentionsRail
        tasks={[task('Finished already', { done: true }), task('Still open', { line: 1 })]}
        durations={DURATIONS}
      />,
    );
    expect(screen.getByText('Finished already').closest('.weekfit-rail__item')).toHaveClass(
      'weekfit-rail__item--done',
    );
    expect(screen.getByText('Still open').closest('.weekfit-rail__item')).toHaveClass(
      'weekfit-rail__item--unscheduled',
    );
  });

  it('sorts by priority then due date (compareMeta order)', () => {
    render(
      <IntentionsRail
        tasks={[
          task('Low priority, no date 🔽'),
          task('Highest priority 🔺'),
          task('Due sooner 📅 2026-09-01'),
          task('Due later 📅 2026-09-10'),
        ]}
        durations={DURATIONS}
      />,
    );
    const titles = screen
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.weekfit-rail__title')?.textContent);
    // highest priority first; among the untagged (priority "none") pair, the
    // sooner due date comes first; lowest priority last.
    expect(titles).toEqual(['Highest priority', 'Due sooner', 'Due later', 'Low priority, no date']);
  });

  it('renders a quiet empty state when nothing is unscheduled', () => {
    render(<IntentionsRail tasks={[]} durations={DURATIONS} />);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByText(/nothing waiting/i)).toBeInTheDocument();
  });

  it('labels a scheduled row with where it landed', () => {
    const onGrid = task('Sits on the grid');
    const block: CalEvent = {
      uid: 'Weekly/2026-W36.md:0',                       // = `${onGrid.file}:${onGrid.line}`
      title: 'Sits on the grid',
      start: new Date(2026, 8, 1, 14, 0),                 // Tue 1 Sep 2026, 14:00
      end: new Date(2026, 8, 1, 15, 0),
      allDay: false,
    };
    render(
      <IntentionsRail
        tasks={[onGrid]}
        scheduledLines={[onGrid]}
        scheduled={[block]}
        durations={DURATIONS}
      />,
    );
      expect(screen.getByText('Tue 2pm')).toBeInTheDocument();
    });
});
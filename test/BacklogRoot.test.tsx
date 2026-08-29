import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BacklogRoot } from '../src/views/BacklogRoot';
import { collectBacklog } from '../src/data/backlog';
import { DEFAULT_SETTINGS } from '../src/data/contract';
import type { WeekfitSettings } from '../src/data/contract';
import type { VaultTask } from '../src/lib/types';

// vitest.config.ts's `components` project runs with `globals: true`, but
// `@testing-library/react`'s automatic `afterEach(cleanup)` registration is
// still not something to rely on here — see `test/rail.test.tsx`, the model
// for this file. Explicit cleanup, every time.
afterEach(cleanup);

// Same fixture shape as `test/backlog.test.ts` and `test/rail.test.tsx`:
// prefixed by default, since `VaultTask.text` is always the whole raw line.
function task(text: string, opts: Partial<VaultTask> = {}): VaultTask {
  return {
    text: `- [ ] ${text}`,
    done: false,
    file: 'Weekly/2026-W36.md',
    line: 0,
    ...opts,
  };
}

function settingsWith(byKind: Record<string, number> = {}): WeekfitSettings {
  return { ...DEFAULT_SETTINGS, durations: { defaultMinutes: 60, byKind } };
}

describe('BacklogRoot', () => {
  it('renders one row per item, with metadata stripped from the title', () => {
    const items = collectBacklog(
      [task('Write the report ~90m 📅 2026-09-01 🔼')],
      settingsWith(),
    );
    render(<BacklogRoot items={items} onOpenSource={() => {}} />);

    const rows = screen.getAllByRole('button');
    expect(rows).toHaveLength(1);

    const title = rows[0].querySelector('.weekfit-backlog__title');
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe('Write the report');
    // The invisible-text bug class, same as the rail: raw metadata must
    // never survive into the rendered title.
    expect(title!.textContent).not.toContain('~90m');
    expect(title!.textContent).not.toContain('📅');
    expect(title!.textContent).not.toContain('🔼');
  });

  it('marks a defaulted size as a guess, and an explicit estimate as not', () => {
    const items = collectBacklog(
      [task('Write the report ~90m'), task('Do the thing')],
      settingsWith(),
    );
    render(<BacklogRoot items={items} onOpenSource={() => {}} />);

    const ests = screen
      .getAllByRole('button')
      .map((li) => li.querySelector('.weekfit-backlog__est'));

    expect(ests[0]!.className).toContain('weekfit-backlog__est--override');
    expect(ests[0]!.querySelector('.weekfit-backlog__est-guess')).toBeNull();

    expect(ests[1]!.className).toContain('weekfit-backlog__est--default');
    expect(ests[1]!.querySelector('.weekfit-backlog__est-guess')).not.toBeNull();
  });

  it('marks a tag-default size as a guess too', () => {
    const items = collectBacklog(
      [task('Edit the clip #content')],
      settingsWith({ content: 45 }),
    );
    render(<BacklogRoot items={items} onOpenSource={() => {}} />);

    const est = screen.getByRole('button').querySelector('.weekfit-backlog__est');
    expect(est!.className).toContain('weekfit-backlog__est--kind');
    expect(est!.querySelector('.weekfit-backlog__est-guess')).not.toBeNull();
  });

  it('shows each row\'s source file', () => {
    const items = collectBacklog(
      [task('Write the report', { file: 'Projects/Notes.md', line: 12 })],
      settingsWith(),
    );
    render(<BacklogRoot items={items} onOpenSource={() => {}} />);
    expect(screen.getByText('Projects/Notes.md')).toBeInTheDocument();
  });

  it('renders a quiet empty state when there is nothing in the backlog, and does not throw', () => {
    expect(() =>
      render(<BacklogRoot items={[]} onOpenSource={() => {}} />),
    ).not.toThrow();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText(/nothing here/i)).toBeInTheDocument();
  });

  it('calls onOpenSource with the row\'s file and line when clicked', () => {
    const items = collectBacklog(
      [task('Write the report', { file: 'Projects/Notes.md', line: 12 })],
      settingsWith(),
    );
    const onOpenSource = vi.fn();
    render(<BacklogRoot items={items} onOpenSource={onOpenSource} />);

    fireEvent.click(screen.getByText('Write the report'));
    expect(onOpenSource).toHaveBeenCalledWith('Projects/Notes.md', 12);
  });

  it('calls onOpenSource on Enter when a row has keyboard focus', () => {
    const items = collectBacklog(
      [task('Write the report', { file: 'Projects/Notes.md', line: 12 })],
      settingsWith(),
    );
    const onOpenSource = vi.fn();
    render(<BacklogRoot items={items} onOpenSource={onOpenSource} />);

    fireEvent.keyDown(screen.getByRole('button', { name: /write the report/i }), {
      key: 'Enter',
    });
    expect(onOpenSource).toHaveBeenCalledWith('Projects/Notes.md', 12);
  });
});

import { describe, expect, it } from 'vitest';
import { compareForFit, orderByFit, orderForFit } from '../src/data/fitorder';
import { compareMeta, parseTaskMeta } from '../src/lib/taskmeta';
import type { VaultTask } from '../src/lib/types';

function task(text: string, line = 0): VaultTask {
  return { text: `- [ ] ${text}`, done: false, file: 'Weekly/2026-W36.md', line };
}

const titles = (tasks: VaultTask[]) =>
  tasks.map((t) => t.text.replace('- [ ] ', '').split(/\s+[📅🔺⏫🔼🔽⏬[]/)[0].trim());

const cmp = (a: string, b: string) =>
  compareForFit(parseTaskMeta(`- [ ] ${a}`), parseTaskMeta(`- [ ] ${b}`));

/**
 * Both strategies take the best remaining gap for each task in turn, so the
 * order of the list handed to them *is* the priority order. It used to be the
 * order the lines happened to sit in the note, which is how a task due
 * Thursday lost Thursday's free morning to the line above it and landed on
 * Friday — a day late, with Thursday still empty.
 */
describe('a deadline gets first pick of the week', () => {
  it('puts the sooner due date first', () => {
    expect(cmp('A [due:: 2026-09-03]', 'B [due:: 2026-09-04]')).toBeLessThan(0);
    expect(cmp('A [due:: 2026-09-05]', 'B [due:: 2026-09-04]')).toBeGreaterThan(0);
  });

  it('reads both flavours of the standard, not just one', () => {
    // `📅 2026-09-03` and `[due:: 2026-09-03]` are the same commitment.
    expect(cmp('A 📅 2026-09-03', 'B [due:: 2026-09-04]')).toBeLessThan(0);
    expect(cmp('A [due:: 2026-09-03]', 'B 📅 2026-09-04')).toBeLessThan(0);
  });

  it('puts a dated task ahead of an undated one', () => {
    expect(cmp('A [due:: 2026-09-30]', 'B')).toBeLessThan(0);
    expect(cmp('A', 'B [due:: 2026-09-30]')).toBeGreaterThan(0);
  });

  it('leads with an overdue task, which simply has the earliest date', () => {
    const ordered = orderForFit([
      task('Later [due:: 2026-09-04]', 1),
      task('Overdue [due:: 2026-08-02]', 2),
      task('Sooner [due:: 2026-09-03]', 3),
    ]);
    expect(titles(ordered)).toEqual(['Overdue', 'Sooner', 'Later']);
  });
});

describe('priority decides only among equal deadlines', () => {
  it('breaks a tie on the same due date', () => {
    expect(cmp('A 📅 2026-09-03 🔺', 'B 📅 2026-09-03')).toBeLessThan(0);
    expect(cmp('A 📅 2026-09-03 ⏬', 'B 📅 2026-09-03')).toBeGreaterThan(0);
  });

  it('orders undated tasks among themselves', () => {
    expect(titles(orderForFit([task('Low 🔽', 1), task('High ⏫', 2), task('Plain', 3)]))).toEqual([
      'High',
      'Plain',
      'Low',
    ]);
  });

  // The whole reason this comparator exists rather than reusing the rail's.
  it('never lets a high priority jump a nearer deadline', () => {
    expect(cmp('Urgent-looking 🔺 [due:: 2026-12-25]', 'Due tomorrow [due:: 2026-09-01]'))
      .toBeGreaterThan(0);
  });

  it('is the reverse of the rail order, deliberately', () => {
    const soon = parseTaskMeta('- [ ] Soon [due:: 2026-09-01]');
    const loud = parseTaskMeta('- [ ] Loud 🔺 [due:: 2026-12-25]');
    // The rail shows you what matters most; the fit answers a different
    // question — what has to happen first. See the note in fitorder.ts.
    expect(compareMeta(soon, loud)).toBeGreaterThan(0);
    expect(compareForFit(soon, loud)).toBeLessThan(0);
  });
});

describe('the author’s own order is the last word', () => {
  it('keeps file order for tasks that tie on both keys', () => {
    const ordered = orderForFit([task('First', 1), task('Second', 2), task('Third', 3)]);
    expect(titles(ordered)).toEqual(['First', 'Second', 'Third']);
  });

  it('keeps file order within one due date and priority', () => {
    const ordered = orderForFit([
      task('B 📅 2026-09-03 🔼', 1),
      task('A 📅 2026-09-03 🔼', 2),
    ]);
    expect(titles(ordered)).toEqual(['B', 'A']);
  });

  it('does not mutate or drop anything', () => {
    const input = [task('B [due:: 2026-09-04]', 1), task('A [due:: 2026-09-03]', 2)];
    const copy = [...input];
    const ordered = orderForFit(input);
    expect(input).toEqual(copy);
    expect(ordered).toHaveLength(2);
    expect(new Set(ordered)).toEqual(new Set(input));
  });

  it('handles an empty list', () => {
    expect(orderForFit([])).toEqual([]);
  });
});

describe('orderByFit works on anything carrying a task line', () => {
  // "Replan passed" places from `PassedBlock`s, which hold their own task.
  it('orders wrapped items by the line inside them', () => {
    const blocks = [
      { uid: 'b', task: task('Later [due:: 2026-09-05]', 1) },
      { uid: 'a', task: task('Sooner [due:: 2026-09-02]', 2) },
    ];
    expect(orderByFit(blocks, (b) => b.task.text).map((b) => b.uid)).toEqual(['a', 'b']);
  });

  it('tolerates a line with no metadata at all', () => {
    const items = [{ text: '- [ ] Book dentist' }, { text: '- [ ] Water plants' }];
    expect(orderByFit(items, (i) => i.text)).toEqual(items);
  });
});

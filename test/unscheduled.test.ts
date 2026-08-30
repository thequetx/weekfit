import { describe, expect, it } from 'vitest';
import { hasScheduledSessions, isUnscheduled } from '../src/data/sessions';
import { hasPlacement } from '../src/data/dayplanner';
import type { VaultTask } from '../src/lib/types';

const NOTE = 'Weekly/2026-W36.md';

function task(text: string, line: number, opts: Partial<VaultTask> = {}): VaultTask {
  return { text, done: false, file: NOTE, line, ...opts };
}

// The shape splitting writes: a parent that keeps its estimate and gains no
// range of its own, with each sitting as an indented child beneath it.
const parent = task('- [ ] Rebuild the overlay ~6h #deep', 2);
const children = [
  task('    - [ ] 09:00 - 12:00 Rebuild the overlay ⏳ 2026-08-31', 3),
  task('    - [ ] 09:00 - 10:00 Rebuild the overlay ⏳ 2026-09-01', 4),
];

describe('hasScheduledSessions', () => {
  it('sees a split parent as scheduled, though its own line has no range', () => {
    expect(hasPlacement(parent.text)).toBe(false); // why the rail was fooled
    expect(hasScheduledSessions(parent, children)).toBe(true);
  });

  it('says no for a task with nothing under it', () => {
    expect(hasScheduledSessions(task('- [ ] Book dentist', 7), children)).toBe(false);
  });

  // A scheduled task that merely happens to sit on the next line is not a
  // sitting of the one above it.
  it('does not mistake a same-indent neighbour for a child', () => {
    const sibling = [task('- [ ] 09:00 - 10:00 Something else ⏳ 2026-08-31', 3)];
    expect(hasScheduledSessions(parent, sibling)).toBe(false);
  });

  it('does not look across files', () => {
    const elsewhere = [
      task('    - [ ] 09:00 - 12:00 Rebuild the overlay', 3, { file: 'Notes/Other.md' }),
    ];
    expect(hasScheduledSessions(parent, elsewhere)).toBe(false);
  });

  it('does not count a child that is not immediately beneath', () => {
    const detached = [task('    - [ ] 09:00 - 12:00 Rebuild the overlay', 5)];
    expect(hasScheduledSessions(parent, detached)).toBe(false);
  });
});

describe('isUnscheduled — one definition, shared by the rail and the fit engine', () => {
  // The reported contradiction: after splitting, the parent stayed in the rail
  // as an unscheduled, draggable task while its sittings sat on the grid
  // beside it. Both surfaces decided "unscheduled" from the parent's own line,
  // which by design carries no time at all.
  it('a split parent is not unscheduled', () => {
    expect(isUnscheduled(parent, children, hasPlacement)).toBe(false);
  });

  it('a plain open task is unscheduled', () => {
    expect(isUnscheduled(task('- [ ] Book dentist', 7), children, hasPlacement)).toBe(true);
  });

  it('a task carrying its own range is not', () => {
    const placed = task('- [ ] 09:00 - 10:00 Team sync ⏳ 2026-08-31', 7);
    expect(isUnscheduled(placed, [], hasPlacement)).toBe(false);
  });

  it('a done task is not', () => {
    expect(isUnscheduled(task('- [x] Finished', 7, { done: true }), [], hasPlacement)).toBe(false);
  });
});

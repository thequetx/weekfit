import { describe, expect, it } from 'vitest';
import { canSplit, maxSittingsFor, planSplit, planSplitAuto } from '../src/data/split';
import type { SplitTarget } from '../src/data/split';
import { DEFAULT_SETTINGS } from '../src/data/contract';
import type { WeekSnapshot, WeekfitSettings } from '../src/data/contract';
import { addDays, startOfISOWeek } from '../src/lib/week';
import type { AvailabilityWindow, CalEvent, VaultTask } from '../src/lib/types';

const WEEK_START = startOfISOWeek(new Date(2026, 7, 31)); // Mon 31 Aug
// Sunday before the week starts, so nothing is trimmed for being in the past.
const NOW = addDays(WEEK_START, -1);
const NOTE = 'Weekly/2026-W36.md';

function task(text: string, line = 2): VaultTask {
  return { text, done: false, file: NOTE, line };
}

function block(day: number, startMin: number, minutes: number): CalEvent {
  const start = addDays(WEEK_START, day);
  start.setMinutes(startMin);
  const end = new Date(start.getTime() + minutes * 60_000);
  return { uid: `${NOTE}:2`, title: 'Rebuild the overlay', start, end, allDay: false };
}

function win(
  name: string,
  startMin: number,
  endMin: number,
  days: number[] = [0, 1, 2, 3, 4, 5, 6],
): AvailabilityWindow {
  return { name, days, startMin, endMin, minBlockMin: 30 };
}

const settings: WeekfitSettings = {
  ...DEFAULT_SETTINGS,
  windows: [win('work', 9 * 60, 18 * 60)],
};

/** A 6h block on Wednesday at 09:00, from a task with a 6h estimate. */
const TARGET: SplitTarget = {
  uid: `${NOTE}:2`,
  task: task('- [ ] 09:00 - 15:00 Rebuild the overlay ~6h'),
  day: 2,
  startMin: 9 * 60,
  endMin: 15 * 60,
};

function snapshot(over: Partial<WeekSnapshot> = {}): WeekSnapshot {
  return {
    weekId: '2026-W36',
    weekStart: WEEK_START,
    notePath: NOTE,
    intentions: [],
    tasks: [],
    thisweek: [],
    scheduled: [block(2, 9 * 60, 360)],
    scheduledLines: [TARGET.task],
    errors: [],
    ...over,
  };
}

describe('how many sittings a block can become', () => {
  it('a 6h block can be up to four, capped by MAX_SESSIONS', () => {
    expect(maxSittingsFor(360)).toBe(4);
  });

  it('a 2h block can be two — one hour each is the floor', () => {
    expect(maxSittingsFor(120)).toBe(2);
    expect(canSplit(120)).toBe(true);
  });

  // Why the Split control is hidden rather than disabled on a short block.
  it('a 90m block cannot be split at all', () => {
    expect(canSplit(90)).toBe(false);
    expect(maxSittingsFor(90)).toBe(1);
  });
});

describe('planSplit', () => {
  it('keeps the first sitting exactly where the block already was', () => {
    const plan = planSplit(snapshot(), settings, NOW, TARGET, 2)!;
    expect(plan).not.toBeNull();
    const first = plan.proposals[0];
    expect(first.day).toBe(2);
    expect(first.startMin).toBe(9 * 60);
    // Shortened to its share, not moved.
    expect(first.endMin).toBe(12 * 60);
  });

  it('produces exactly the requested number of sittings, numbered', () => {
    const plan = planSplit(snapshot(), settings, NOW, TARGET, 3)!;
    expect(plan.proposals).toHaveLength(3);
    expect(plan.proposals.map((p) => p.session)).toEqual([1, 2, 3]);
    expect(plan.proposals.every((p) => p.sessions === 3)).toBe(true);
  });

  it('gives every sitting one groupKey, so accepting takes the whole split', () => {
    const plan = planSplit(snapshot(), settings, NOW, TARGET, 3)!;
    expect(new Set(plan.proposals.map((p) => p.groupKey)).size).toBe(1);
  });

  it('cuts the block into equal pieces', () => {
    const plan = planSplit(snapshot(), settings, NOW, TARGET, 3)!;
    for (const p of plan.proposals) expect(p.endMin - p.startMin).toBe(120);
  });

  it('names the block it replaces, so the grid can stop drawing it', () => {
    const plan = planSplit(snapshot(), settings, NOW, TARGET, 2)!;
    expect(plan.replacing).toBe(TARGET.uid);
  });

  // The block's own hours are busy in the week as it stands. If gaps were
  // computed against that, the freed second half of its own slot would be
  // invisible and every sitting would be pushed elsewhere for no reason.
  it('treats the time it is giving back as available', () => {
    // Wednesday-only window, so the only place the second sitting can go is
    // the half of its own old slot the split just freed. Against the week as
    // it stands those hours are busy, and nothing would place at all.
    const wedOnly: WeekfitSettings = { ...settings, windows: [win('work', 9 * 60, 18 * 60, [2])] };
    const plan = planSplit(snapshot(), wedOnly, NOW, TARGET, 2)!;
    expect(plan.unplaced).toEqual([]);
    const second = plan.proposals[1];
    expect(second.day).toBe(2);
    expect(second.startMin).toBe(12 * 60);
  });

  it('refuses more sittings than the block can carry', () => {
    expect(planSplit(snapshot(), settings, NOW, TARGET, 7)).toBeNull();
    expect(planSplit(snapshot(), settings, NOW, TARGET, 1)).toBeNull();
  });

  it('reports what would not fit rather than pretending', () => {
    // A single one-hour window all week: only the kept slot can land.
    // One hour, on the split block's own day, entirely inside the sitting
    // being kept — so there is nowhere at all for the rest to go.
    const cramped: WeekfitSettings = {
      ...settings,
      windows: [win('work', 9 * 60, 10 * 60, [2])],
    };
    const plan = planSplit(snapshot(), cramped, NOW, TARGET, 3);
    expect(plan).not.toBeNull();
    expect(plan!.unplaced.length).toBeGreaterThan(0);
  });
});

describe('planSplitAuto — the menu’s "Fit" option', () => {
  it('prefers the fewest sittings that actually fit', () => {
    const plan = planSplitAuto(snapshot(), settings, NOW, TARGET)!;
    expect(plan.sessions).toBe(2);
    expect(plan.unplaced).toEqual([]);
  });

  it('still returns a plan when nothing fits cleanly, so the view can say so', () => {
    // One hour, on the split block's own day, entirely inside the sitting
    // being kept — so there is nowhere at all for the rest to go.
    const cramped: WeekfitSettings = {
      ...settings,
      windows: [win('work', 9 * 60, 10 * 60, [2])],
    };
    const plan = planSplitAuto(snapshot(), cramped, NOW, TARGET);
    expect(plan).not.toBeNull();
    expect(plan!.unplaced.length).toBeGreaterThan(0);
  });

  it('returns null for a block too short to split', () => {
    const short: SplitTarget = { ...TARGET, endMin: TARGET.startMin + 90 };
    expect(planSplitAuto(snapshot(), settings, NOW, short)).toBeNull();
  });
});

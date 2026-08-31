import { describe, expect, it } from 'vitest';
import { computeFit } from '../src/data/planner';
import { DEFAULT_SETTINGS } from '../src/data/contract';
import type { WeekSnapshot, WeekfitSettings } from '../src/data/contract';
import { addDays, startOfISOWeek } from '../src/lib/week';
import type { AvailabilityWindow, VaultTask } from '../src/lib/types';

const WEEK_START = startOfISOWeek(new Date(2026, 7, 31)); // Mon 31 Aug
// The Sunday before, so the whole week is on offer and nothing is trimmed.
const NOW = addDays(WEEK_START, -1);

function task(text: string, line: number): VaultTask {
  return { text, done: false, file: 'Weekly/2026-W36.md', line };
}

function win(name: string, startMin: number, endMin: number): AvailabilityWindow {
  return { name, days: [0, 1, 2, 3, 4], startMin, endMin, minBlockMin: 30 };
}

/** Five weekdays, nine to five, and eight one-hour tasks to put in them. */
function week(strategy: 'spread' | 'earliest'): {
  snapshot: WeekSnapshot;
  settings: WeekfitSettings;
} {
  const tasks = Array.from({ length: 8 }, (_, i) => task(`- [ ] Job ${i + 1} ~1h`, i + 2));
  return {
    snapshot: {
      weekId: '2026-W36',
      weekStart: WEEK_START,
      notePath: 'Weekly/2026-W36.md',
      intentions: [],
      tasks,
      thisweek: [],
      scheduled: [],
      scheduledLines: [],
      icsEvents: [],
      errors: [],
    },
    settings: {
      ...DEFAULT_SETTINGS,
      fitStrategy: strategy,
      windows: [win('work', 9 * 60, 17 * 60)],
    },
  };
}

function daysUsed(strategy: 'spread' | 'earliest'): Map<number, number> {
  const { snapshot, settings } = week(strategy);
  const fit = computeFit(snapshot, settings, NOW);
  const byDay = new Map<number, number>();
  for (const p of fit.proposals) byDay.set(p.day, (byDay.get(p.day) ?? 0) + 1);
  return byDay;
}

describe('fitStrategy', () => {
  // The complaint this exists for: the ported engine prefers the earliest day
  // outright, so eight tasks and five free days produced a brutal Monday and
  // an untouched Friday.
  it('earliest piles work onto the front of the week', () => {
    const byDay = daysUsed('earliest');
    expect(byDay.get(0)).toBeGreaterThan(2);
    expect(byDay.size).toBeLessThan(5);
  });

  it('spread uses more of the week than earliest does', () => {
    expect(daysUsed('spread').size).toBeGreaterThan(daysUsed('earliest').size);
  });

  it('spread never loads one day much more heavily than another', () => {
    const counts = [...daysUsed('spread').values()];
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('places every task either way — balancing must not cost placements', () => {
    for (const strategy of ['spread', 'earliest'] as const) {
      const { snapshot, settings } = week(strategy);
      const fit = computeFit(snapshot, settings, NOW);
      expect(fit.proposals).toHaveLength(8);
      expect(fit.unplaced).toEqual([]);
    }
  });

  it('spread is the default', () => {
    expect(DEFAULT_SETTINGS.fitStrategy).toBe('spread');
  });

  // A task bigger than any single day still has to work: that falls back to
  // the whole pool, where the engine's own splitting lives.
  it('falls back to the engine when nothing fits in one day', () => {
    const { snapshot, settings } = week('spread');
    const big = {
      ...snapshot,
      tasks: [task('- [ ] Enormous ~20h', 2)],
    };
    const fit = computeFit(big, settings, NOW);
    // Either split across days or reported unplaced — but never silently lost.
    expect(fit.proposals.length + fit.unplaced.length).toBeGreaterThan(0);
  });

  it('still honours a task’s window preference', () => {
    const { snapshot } = week('spread');
    const settings: WeekfitSettings = {
      ...DEFAULT_SETTINGS,
      fitStrategy: 'spread',
      durations: { defaultMinutes: 60, byKind: { deep: 60 } },
      windows: [win('admin', 9 * 60, 12 * 60), win('deep', 13 * 60, 17 * 60)],
    };
    const tagged = { ...snapshot, tasks: [task('- [ ] Focused work #deep ~1h', 2)] };
    const fit = computeFit(tagged, settings, NOW);
    expect(fit.proposals[0].window).toBe('deep');
  });
});

import { describe, expect, it } from 'vitest';
import { computeFit, computeReplan, proposalGroups } from '../src/data/planner';
import type { WeekSnapshot, WeekfitSettings } from '../src/data/contract';
import { DEFAULT_SETTINGS } from '../src/data/contract';
import { addDays, startOfISOWeek } from '../src/lib/week';
import type { AvailabilityWindow, CalEvent, VaultTask } from '../src/lib/types';

// Monday 2026-08-31 — same week vaultRepo.test.ts uses.
const WEEK_START = startOfISOWeek(new Date(2026, 7, 31));

function task(text: string, opts: Partial<VaultTask> = {}): VaultTask {
  return { text, done: false, file: 'Weekly/2026-W36.md', line: 0, ...opts };
}

function win(
  name: string,
  days: number[],
  startMin: number,
  endMin: number,
  minBlockMin = 30,
): AvailabilityWindow {
  return { name, days, startMin, endMin, minBlockMin };
}

function snapshot(overrides: Partial<WeekSnapshot> = {}): WeekSnapshot {
  return {
    weekId: '2026-W36',
    weekStart: WEEK_START,
    notePath: 'Weekly/2026-W36.md',
    intentions: [],
    tasks: [],
    thisweek: [],
    scheduled: [],
    scheduledLines: [],
    icsEvents: [],
    errors: [],
    ...overrides,
  };
}

function settings(overrides: Partial<WeekfitSettings> = {}): WeekfitSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

// Monday 00:00 — before the 9-5 window opens, so the whole week is on offer
// and nothing is trimmed for being "in the past".
const NOW = new Date(WEEK_START);

describe('computeFit', () => {
  it('proposes placements for unscheduled tasks, landing them inside the configured gaps', () => {
    const snap = snapshot({
      tasks: [task('Write the report ~90m'), task('Book dentist')],
    });
    const s = settings({ windows: [win('work', [0, 1, 2, 3, 4], 9 * 60, 17 * 60)] });

    const fit = computeFit(snap, s, NOW);

    expect(fit.gaps.length).toBeGreaterThan(0);
    expect(fit.proposals).toHaveLength(2);
    expect(fit.unplaced).toHaveLength(0);
    for (const p of fit.proposals) {
      expect(p.startMin).toBeGreaterThanOrEqual(9 * 60);
      expect(p.endMin).toBeLessThanOrEqual(17 * 60);
    }
  });

  it('folds snapshot.tasks and snapshot.thisweek into one candidate pool', () => {
    const snap = snapshot({
      tasks: [task('From the weekly note ~30m')],
      thisweek: [task('Swept in from elsewhere ~30m')],
    });
    const s = settings({ windows: [win('work', [0, 1, 2, 3, 4], 9 * 60, 17 * 60)] });

    const fit = computeFit(snap, s, NOW);

    expect(fit.proposals.map((p) => p.title).sort()).toEqual([
      'From the weekly note',
      'Swept in from elsewhere',
    ]);
  });

  it('excludes a done task', () => {
    const snap = snapshot({
      tasks: [task('Finished already ~30m', { done: true }), task('Still open ~30m')],
    });
    const s = settings({ windows: [win('work', [0, 1, 2, 3, 4], 9 * 60, 17 * 60)] });

    const fit = computeFit(snap, s, NOW);

    expect(fit.proposals).toHaveLength(1);
    expect(fit.proposals[0].title).toBe('Still open');
  });

  // Mirrors IntentionsRail.tsx's own filter exactly: `!DAY_PLANNER_RE.test(t.text)`.
  // Deliberately fed the same way that rule is exercised elsewhere in this
  // codebase's tests (duration.test.ts, rail.test.tsx) — `text` as just the
  // task's own body, matching the shape the rule was written to recognise.
  it('excludes a task that actually became a block on this week, same rule the rail uses', () => {
    const placed = task('- [ ] 09:00 - 10:30 Already scheduled', { line: 1 });
    const snap = snapshot({
      tasks: [placed, task('- [ ] Not yet scheduled ~30m', { line: 2 })],
      // What makes it "scheduled" is that it produced a block — not that its
      // text contains a time.
      scheduledLines: [placed],
    });
    const s = settings({ windows: [win('work', [0, 1, 2, 3, 4], 9 * 60, 17 * 60)] });

    const fit = computeFit(snap, s, NOW);

    expect(fit.proposals.map((p) => p.title)).toEqual(['Not yet scheduled']);
    // Excluded before capacity arithmetic too, not just before fitting.
    expect(fit.capacity.committedMin).toBe(30);
  });

  it('groups proposals for a split task under one groupKey via proposalGroups', () => {
    const snap = snapshot({
      tasks: [task('Edit the big video ~4h')],
    });
    // A single 1h gap per day, five days, forces a split across sessions.
    const s = settings({
      windows: [win('work', [0, 1, 2, 3, 4], 9 * 60, 10 * 60, 60)],
    });

    const fit = computeFit(snap, s, NOW);

    expect(fit.proposals.length).toBeGreaterThan(1);
    const groups = proposalGroups(fit.proposals);
    expect(groups.size).toBe(1);
    const [[key, group]] = [...groups.entries()];
    expect(group).toHaveLength(fit.proposals.length);
    expect(group.every((p) => p.groupKey === key)).toBe(true);
  });

  describe('capacity', () => {
    it('reports freeMin: null (not zero) when no window is configured at all', () => {
      const snap = snapshot({ tasks: [task('Book dentist ~30m')] });
      const s = settings({ windows: [] });

      const fit = computeFit(snap, s, NOW);

      expect(fit.gaps).toEqual([]);
      expect(fit.capacity.freeMin).toBeNull();
      expect(fit.capacity.committedMin).toBe(30);
      // No opinion on free time means no opinion on over-commitment either.
      expect(fit.capacity.overBy).toBe(0);
      // Nothing to fit into, so every sized task comes back unplaced.
      expect(fit.unplaced).toHaveLength(1);
      expect(fit.proposals).toHaveLength(0);
    });

    it('reports overBy > 0 for a week with more committed work than free time', () => {
      const snap = snapshot({
        tasks: [task('First hour ~60m'), task('Second hour ~60m')],
      });
      // Exactly one hour of capacity, Monday only.
      const s = settings({ windows: [win('work', [0], 9 * 60, 10 * 60, 30)] });

      const fit = computeFit(snap, s, NOW);

      expect(fit.capacity.committedMin).toBe(120);
      expect(fit.capacity.freeMin).toBe(60);
      expect(fit.capacity.overBy).toBe(60);
      expect(fit.proposals).toHaveLength(1); // one hour placed
      expect(fit.unplaced).toHaveLength(1); // the other can't fit anywhere
    });

    it('reports overBy: 0 when committed work fits inside the free time', () => {
      const snap = snapshot({ tasks: [task('Quick task ~30m')] });
      const s = settings({ windows: [win('work', [0, 1, 2, 3, 4], 9 * 60, 17 * 60)] });

      const fit = computeFit(snap, s, NOW);

      expect(fit.capacity.overBy).toBe(0);
      expect(fit.capacity.committedMin).toBeLessThanOrEqual(fit.capacity.freeMin ?? 0);
    });
  });

  it('leaves an already-booked task alone (a future session already on the calendar)', () => {
    const start = addDays(WEEK_START, 1);
    start.setHours(9, 0, 0, 0);
    const end = addDays(WEEK_START, 1);
    end.setHours(10, 0, 0, 0);
    const ev: CalEvent = {
      uid: 'x',
      title: 'Write the report',
      start,
      end,
      allDay: false,
    };
    const snap = snapshot({
      tasks: [task('Write the report ~60m')],
      scheduled: [ev],
    });
    const s = settings({ windows: [win('work', [0, 1, 2, 3, 4], 9 * 60, 17 * 60)] });

    const fit = computeFit(snap, s, NOW);

    // fitTasks (given events + now) skips a task that already has a future
    // session booked, rather than proposing it a second time.
    expect(fit.proposals).toHaveLength(0);
    expect(fit.unplaced).toHaveLength(0);
  });
});

describe('proposalGroups', () => {
  it('returns an empty map for no proposals', () => {
    expect(proposalGroups([]).size).toBe(0);
  });
});

describe('computeFit — already-placed work is left alone', () => {
  // The Phase 2 QA gate's finding. `VaultTask.text` is the whole raw line, so
  // an already-scheduled task must be recognised through its `- [ ] ` prefix.
  // Before `hasPlacement` existed this filter used `DAY_PLANNER_RE` directly
  // and never matched real data — so "Fit this week" would happily propose a
  // *second* placement for work that was already on the board and move it.
  it('does not propose a task whose real line already carries a range', () => {
    const fit = computeFit(
      snapshot({
        tasks: [
          task('- [ ] 09:00 - 10:30 Fix badge alpha', { line: 1 }),
          task('- [ ] Book dentist', { line: 2 }),
        ],
        scheduledLines: [task('- [ ] 09:00 - 10:30 Fix badge alpha', { line: 1 })],
      }),
      settings({ windows: [win('work', [0, 1, 2, 3, 4], 9 * 60, 17 * 60)] }),
      NOW,
    );

    const titles = fit.proposals.map((p) => p.title);
    expect(titles).toContain('Book dentist');
    expect(titles.join(' ')).not.toContain('Fix badge alpha');
  });

  it('excludes it from the committed total too', () => {
    const placed = computeFit(
      snapshot({
        tasks: [task('- [ ] 09:00 - 10:30 Fix badge alpha ~90m', { line: 1 })],
        scheduledLines: [task('- [ ] 09:00 - 10:30 Fix badge alpha ~90m', { line: 1 })],
      }),
      settings({ windows: [win('work', [0, 1, 2, 3, 4], 9 * 60, 17 * 60)] }),
      NOW,
    );
    expect(placed.capacity.committedMin).toBe(0);
  });
});

describe('computeFit — a range that never became a block is still unscheduled', () => {
  // The bug this replaced: a line can carry `09:00 - 10:30` and still not be
  // on the grid — no scheduled date at all, or a date in another week. The
  // old rule read the text, so those tasks were excluded from the rail *and*
  // never became blocks: invisible in both places anyone looks. A real note
  // had eight of them.
  it('fits a timed line that has no date, so it can be given one', () => {
    const orphan = task('- [ ] 09:00 - 10:30 Timed but undated', { line: 1 });
    const fit = computeFit(
      snapshot({ tasks: [orphan], scheduledLines: [] }),
      settings({ windows: [win('work', [0, 1, 2, 3, 4], 9 * 60, 17 * 60)] }),
      NOW,
    );
    expect(fit.proposals.map((p) => p.title).join(' ')).toContain('Timed but undated');
  });

  it('fits a timed line whose date lands in another week', () => {
    const nextWeek = task('- [ ] 12:00 - 14:00 Team sync ⏳ 2026-09-11', { line: 1 });
    const fit = computeFit(
      snapshot({ tasks: [nextWeek], scheduledLines: [] }),
      settings({ windows: [win('work', [0, 1, 2, 3, 4], 9 * 60, 17 * 60)] }),
      NOW,
    );
    expect(fit.proposals.map((p) => p.title).join(' ')).toContain('Team sync');
  });
});
describe('computeReplan — what did not happen, re-fitted', () => {
  // A block on Monday morning, and a clock on Wednesday, so it has plainly
  // passed. `scheduledLines[i]` is the task line `scheduled[i]` came from —
  // that lockstep is how the replan knows whether it was ever ticked.
  function passedWeek(done: boolean, extra: Partial<WeekSnapshot> = {}): WeekSnapshot {
    const start = addDays(WEEK_START, 0);
    start.setMinutes(9 * 60);
    const end = addDays(WEEK_START, 0);
    end.setMinutes(10 * 60);
    const line = done
      ? '- [x] 09:00 - 10:00 Fix badge alpha'
      : '- [ ] 09:00 - 10:00 Fix badge alpha';
    return snapshot({
      scheduled: [
        {
          uid: 'Weekly/2026-W36.md:2',
          title: 'Fix badge alpha',
          start,
          end,
          allDay: false,
          source: 'Weekly/2026-W36.md#L2',
        },
      ],
      scheduledLines: [task(line, { line: 2, done })],
      ...extra,
    });
  }

  const wednesday = (() => {
    const d = addDays(WEEK_START, 2);
    d.setMinutes(8 * 60);
    return d;
  })();

  const week = settings({ windows: [win('work', [0, 1, 2, 3, 4], 9 * 60, 17 * 60)] });

  it('proposes a new slot for a block that passed without being ticked', () => {
    const fit = computeReplan(passedWeek(false), week, wednesday);
    expect(fit.proposals.length).toBeGreaterThan(0);
    expect(fit.proposals.every((p) => p.kind === 'replan')).toBe(true);
  });

  it('proposes nothing for a block that passed and was ticked done', () => {
    const fit = computeReplan(passedWeek(true), week, wednesday);
    expect(fit.proposals).toEqual([]);
  });

  it('does not replan a block that has not happened yet', () => {
    // Same block, but the clock is Monday 08:00 — before it starts.
    const monday = addDays(WEEK_START, 0);
    monday.setMinutes(8 * 60);
    const fit = computeReplan(passedWeek(false), week, monday);
    expect(fit.proposals).toEqual([]);
  });

  it('places the replacement after now, never back where it already failed', () => {
    const fit = computeReplan(passedWeek(false), week, wednesday);
    for (const p of fit.proposals) {
      // Wednesday is day 2; nothing may be offered on Monday or Tuesday.
      expect(p.day).toBeGreaterThanOrEqual(2);
    }
  });

  it('returns the same shape computeFit does, so the view needs no new branch', () => {
    const fit = computeReplan(passedWeek(false), week, wednesday);
    expect(fit).toHaveProperty('gaps');
    expect(fit).toHaveProperty('proposals');
    expect(fit).toHaveProperty('unplaced');
    expect(fit).toHaveProperty('capacity');
  });

  it('proposes nothing when no window is configured', () => {
    const fit = computeReplan(passedWeek(false), settings({ windows: [] }), wednesday);
    expect(fit.proposals).toEqual([]);
  });
});

/**
 * The reported case, end to end: `Write newsletter [due:: 2026-09-03]` was
 * proposed for Friday 4 Sep while Thursday sat free, because it happened to
 * be written below a task that took the slot first. Placement order was file
 * order and nothing anywhere read a due date.
 */
describe('computeFit honours deadlines', () => {
  // One 90-minute slot per weekday: whoever is asked first takes Monday, and
  // so on. That makes the order of the list directly visible in the output.
  const ONE_SLOT_A_DAY = settings({
    windows: [win('work', [0, 1, 2, 3, 4], 9 * 60, 10 * 60 + 30)],
    fitStrategy: 'earliest',
  });

  function dayOf(fit: ReturnType<typeof computeFit>, title: string): number | undefined {
    return fit.proposals.find((p) => p.title.startsWith(title))?.day;
  }

  it('gives the earlier deadline the earlier day, whatever order the note is in', () => {
    const snap = snapshot({
      tasks: [
        task('Written first [due:: 2026-09-04] ~90m', { line: 1 }),
        task('Due sooner [due:: 2026-09-02] ~90m', { line: 2 }),
      ],
    });

    const fit = computeFit(snap, ONE_SLOT_A_DAY, NOW);

    expect(dayOf(fit, 'Due sooner')).toBe(0);
    expect(dayOf(fit, 'Written first')).toBe(1);
  });

  it('does not let a loud priority jump a nearer deadline', () => {
    const snap = snapshot({
      tasks: [
        task('Shouty 🔺 [due:: 2026-12-25] ~90m', { line: 1 }),
        task('Quiet [due:: 2026-09-02] ~90m', { line: 2 }),
      ],
    });

    expect(dayOf(computeFit(snap, ONE_SLOT_A_DAY, NOW), 'Quiet')).toBe(0);
  });

  it('still uses priority to separate tasks due on the same day', () => {
    const snap = snapshot({
      tasks: [
        task('Low 🔽 [due:: 2026-09-04] ~90m', { line: 1 }),
        task('High ⏫ [due:: 2026-09-04] ~90m', { line: 2 }),
      ],
    });

    const fit = computeFit(snap, ONE_SLOT_A_DAY, NOW);
    expect(dayOf(fit, 'High')).toBe(0);
    expect(dayOf(fit, 'Low')).toBe(1);
  });

  // Both strategies read the same ordered list — the balanced one is the
  // default, so a fix that only reached `earliest` would have fixed nothing
  // for almost every user.
  it('applies to the balanced strategy too, not just soonest-first', () => {
    const snap = snapshot({
      tasks: [
        task('Written first [due:: 2026-09-04] ~90m', { line: 1 }),
        task('Due sooner [due:: 2026-09-02] ~90m', { line: 2 }),
      ],
    });
    const spread = settings({
      windows: [win('work', [0, 1, 2, 3, 4], 9 * 60, 10 * 60 + 30)],
      fitStrategy: 'spread',
    });

    const fit = computeFit(snap, spread, NOW);
    const sooner = dayOf(fit, 'Due sooner');
    const later = dayOf(fit, 'Written first');
    expect(sooner).not.toBeUndefined();
    expect(later).not.toBeUndefined();
    expect(sooner!).toBeLessThan(later!);
  });

  it('leaves an all-undated week in the order the author wrote it', () => {
    const snap = snapshot({
      tasks: [
        task('One ~90m', { line: 1 }),
        task('Two ~90m', { line: 2 }),
        task('Three ~90m', { line: 3 }),
      ],
    });

    const fit = computeFit(snap, ONE_SLOT_A_DAY, NOW);
    expect(dayOf(fit, 'One')).toBe(0);
    expect(dayOf(fit, 'Two')).toBe(1);
    expect(dayOf(fit, 'Three')).toBe(2);
  });
});

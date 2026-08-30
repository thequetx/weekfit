import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeekViewRoot } from '../src/views/WeekViewRoot';
import type { WeekViewRootProps } from '../src/views/WeekViewRoot';

// vitest.config.ts doesn't run with `test.globals: true`, so
// @testing-library/react's automatic afterEach(cleanup) never registers —
// without this, each test's DOM piles up on top of the last one instead of
// starting fresh.
afterEach(cleanup);
import { DEFAULT_SETTINGS } from '../src/data/contract';
import type {
  Capacity,
  FitState,
  WeekSnapshot,
  WeekfitSettings,
  WriteResult,
} from '../src/data/contract';
import { addDays, fmtWeekRange, startOfISOWeek } from '../src/lib/week';
import type { CalEvent, SkeletonBlock, VaultTask } from '../src/lib/types';
import type { Gap, Proposal } from '../src/lib/gaps';

// Pinned rather than `new Date()` so the "is `now` inside this week" tests
// don't depend on when the suite happens to run. Monday of this week is the
// snapshot's weekStart throughout.
const NOW = new Date(2026, 7, 31, 10, 0); // 2026-08-31 10:00, a Monday
const WEEK_START = startOfISOWeek(NOW);

function vaultTask(text: string, opts: Partial<VaultTask> = {}): VaultTask {
  return { text, done: false, file: 'Weekly/2026-W36.md', line: 0, ...opts };
}

function calEvent(opts: Partial<CalEvent> & { start: Date; end: Date }): CalEvent {
  return { uid: 'ev1', title: 'Event', allDay: false, ...opts };
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
    // Index-aligned with `scheduled` (contract.ts): `scheduled[i]` came from
    // `scheduledLines[i]`. Tests that set `scheduled` and care about
    // `scheduledLines` provide both explicitly; everything else is fine with
    // an empty pair.
    scheduledLines: [],
    errors: [],
    ...overrides,
  };
}

/** A minimal `Proposal` (from lib/gaps.ts), for Phase 2's ghost tests. */
function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    key: 'Weekly/2026-W36.md:0',
    groupKey: 'Weekly/2026-W36.md:0',
    kind: 'fit',
    file: 'Weekly/2026-W36.md',
    line: 0,
    text: '- [ ] Write report',
    title: 'Write report',
    minutes: 60,
    day: 0,
    startMin: 9 * 60,
    endMin: 10 * 60,
    window: 'work',
    ...overrides,
  };
}

function capacity(overrides: Partial<Capacity> = {}): Capacity {
  return { committedMin: 0, freeMin: 0, overBy: 0, ...overrides };
}

function fitState(overrides: Partial<FitState> = {}): FitState {
  return {
    gaps: [],
    proposals: [],
    unplaced: [],
    capacity: capacity(),
    ...overrides,
  };
}

function writeResult(overrides: Partial<WriteResult> = {}): WriteResult {
  return { written: 0, skipped: [], errors: [], ...overrides };
}

const settings: WeekfitSettings = DEFAULT_SETTINGS;
const noop = () => {};

/**
 * Every Phase 2 prop defaults to its "nothing has happened yet" value —
 * `fit: null`, `fitting: false`, `lastWrite: null`, every callback a no-op —
 * so each test only has to override what it's actually exercising. This is
 * also what keeps this file's Phase 1 tests unchanged in intent even though
 * `WeekViewRootProps` grew several new required props in Phase 2B.
 */
function renderRoot(overrides: Partial<WeekViewRootProps> = {}) {
  const props: WeekViewRootProps = {
    snapshot: snapshot(),
    settings,
    now: NOW,
    onRefresh: noop,
    onSetDue: noop,
    onSetPriority: noop,
    onSetEstimate: noop,
    weekStart: WEEK_START,
    isCurrentWeek: true,
    onPrevWeek: noop,
    onNextWeek: noop,
    onToday: noop,
    fit: null,
    fitting: false,
    lastWrite: null,
    onFit: noop,
    onClearFit: noop,
    onAccept: noop,
    onAcceptAll: noop,
    onDismiss: noop,
    onMoveProposal: noop,
    onToggleGaps: noop,
    onCreateWeekNote: noop,
    onReplan: noop,
    onReview: noop,
    onOpenTask: noop,
    onToggleDone: noop,
    onScheduleTask: noop,
    onTaskMenu: noop,
    onSplitBlock: noop,
    onMoveBlock: noop,
    onUnschedule: noop,
    onOpenSource: noop,
    onResizeBlock: noop,
    onResizeProposal: noop,
    ...overrides,
  };
  return render(<WeekViewRoot {...props} />);
}

describe('WeekViewRoot — loading', () => {
  it('renders a loading state for a null snapshot and does not throw', () => {
    expect(() => renderRoot({ snapshot: null })).not.toThrow();
    expect(screen.getByText('Loading week…')).toBeInTheDocument();
  });
});

describe('WeekViewRoot — empty / error states', () => {
  it('shows a teaching empty state when notePath is null, without throwing', () => {
    expect(() => renderRoot({ snapshot: snapshot({ notePath: null }) })).not.toThrow();
    expect(screen.getByText('Nothing here yet for this week.')).toBeInTheDocument();
    // The empty state has to offer the next action, not just report the
    // absence — a fresh vault otherwise leaves the user to work out that a
    // three-heading note is what's missing.
    expect(screen.getByRole('button', { name: /create this week/i })).toBeInTheDocument();
  });

  it('the empty state’s button asks the plugin to seed the note', () => {
    const onCreateWeekNote = vi.fn();
    renderRoot({ snapshot: snapshot({ notePath: null }), onCreateWeekNote });
    fireEvent.click(screen.getByRole('button', { name: /create this week/i }));
    expect(onCreateWeekNote).toHaveBeenCalledTimes(1);
  });

  it('says so when no availability window is configured, since nothing can be fitted', () => {
    renderRoot({ settings: { ...DEFAULT_SETTINGS, windows: [] } });
    expect(screen.getByText(/no availability windows set/i)).toBeInTheDocument();
  });

  // The daily-notes case. `notePath` reports whether the *weekly* note exists
  // on disk regardless of which mode is in use, so in `daily` mode a fully
  // populated week legitimately has `notePath: null`. Announcing "no weekly
  // note" over the top of a week that plainly has content is both wrong and
  // alarming, and it is exactly the kind of thing a unit test never sees.
  it('stays quiet when notePath is null but the week has content anyway', () => {
    renderRoot({
      snapshot: snapshot({
        notePath: null,
        tasks: [vaultTask('- [ ] Book dentist')],
      }),
    });
    expect(screen.queryByText('No weekly note for this week yet.')).not.toBeInTheDocument();
    expect(screen.getByText('Book dentist')).toBeInTheDocument();
  });

  it('renders a dismissible notice when snapshot.errors is non-empty', () => {
    renderRoot({ snapshot: snapshot({ errors: ['Bad date on line 4'] }) });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Bad date on line 4')).toBeInTheDocument();
  });

  it('does not render an error notice when snapshot.errors is empty', () => {
    renderRoot();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('WeekViewRoot — an empty fit result offers nothing to act on', () => {
  // Reported by Tyler: replan correctly said "nothing passed unfinished",
  // but the board still offered Accept all / Clear ghosts. A fit or replan
  // that places nothing still returns a result object, and the controls were
  // gated on that object existing rather than on it containing anything.
  it('hides Accept all and Clear when a fit produced neither ghosts nor unplaced', () => {
    renderRoot({ fit: fitState() });
    expect(screen.queryByRole('button', { name: /accept all/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^clear/i })).not.toBeInTheDocument();
  });

  it('shows both when there are ghosts', () => {
    renderRoot({ fit: fitState({ proposals: [proposal()] }) });
    expect(screen.getByRole('button', { name: /accept all/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear ghosts/i })).toBeInTheDocument();
  });

  // An unplaced list is a real result worth being able to dismiss, but there
  // is nothing to accept.
  it('offers Clear but not Accept all when everything went unplaced', () => {
    renderRoot({
      fit: fitState({
        unplaced: [{ key: 'k', title: 'Too big', minutes: 600, reason: 'no-gap' }],
      }),
    });
    expect(screen.queryByRole('button', { name: /accept all/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^clear$/i })).toBeInTheDocument();
  });
});
describe('WeekViewRoot — replan and review are reachable from the board', () => {
  // Both used to exist only as commands. A weekly ritual you have to already
  // know about in order to search for it is not discoverable.
  it('the Replan button asks the plugin to replan', () => {
    const onReplan = vi.fn();
    renderRoot({ onReplan });
    fireEvent.click(screen.getByRole('button', { name: /replan/i }));
    expect(onReplan).toHaveBeenCalledTimes(1);
  });

  it('the Review button opens the review, which is where roll-forward lives', () => {
    const onReview = vi.fn();
    renderRoot({ onReview });
    fireEvent.click(screen.getByRole('button', { name: /review week/i }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it('both are present before any fit has run', () => {
    renderRoot({ fit: null });
    expect(screen.getByRole('button', { name: /replan/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review week/i })).toBeInTheDocument();
  });
});
describe('WeekViewRoot — scheduled events', () => {
  it('positions a scheduled event in its own day column', () => {
    const wednesday = addDays(WEEK_START, 2);
    const start = new Date(wednesday);
    start.setHours(9, 0, 0, 0);
    const end = new Date(wednesday);
    end.setHours(10, 30, 0, 0);

    renderRoot({
      snapshot: snapshot({
        scheduled: [calEvent({ uid: 'e1', title: 'Team sync', start, end })],
      }),
    });

    const col = document.querySelector('[data-day="2"]'); // Mon=0 -> Wed=2
    expect(col).not.toBeNull();
    const ev = col!.querySelector('.weekfit-ev');
    expect(ev).not.toBeNull();
    expect(ev!.textContent).toContain('Team sync');

    // Not in any other day column.
    for (const di of [0, 1, 3, 4, 5, 6]) {
      const other = document.querySelector(`[data-day="${di}"]`);
      expect(other!.querySelector('.weekfit-ev')).toBeNull();
    }
  });
});

describe('WeekViewRoot — recurring blocks', () => {
  it('renders settings.blocks behind the grid, in their configured day column', () => {
    const block: SkeletonBlock = {
      name: 'Gym',
      kind: 'gym',
      days: [0], // Monday
      startMin: 6 * 60,
      endMin: 7 * 60,
    };
    renderRoot({ settings: { ...settings, blocks: [block] } });
    const mondayCol = document.querySelector('[data-day="0"]');
    expect(mondayCol).not.toBeNull();
    const sk = mondayCol!.querySelector('.weekfit-sk');
    expect(sk).not.toBeNull();
    expect(sk!.textContent).toContain('Gym');

    // Not drawn into a day it wasn't configured for.
    const tuesdayCol = document.querySelector('[data-day="1"]');
    expect(tuesdayCol!.querySelector('.weekfit-sk')).toBeNull();
  });
});

describe('WeekViewRoot — now-line', () => {
  it('renders the now-line when `now` falls inside the rendered week', () => {
    renderRoot();
    expect(document.querySelector('.weekfit-nowline')).not.toBeNull();
  });

  it('does not render the now-line when `now` falls outside the rendered week', () => {
    renderRoot({ now: addDays(NOW, 30) });
    expect(document.querySelector('.weekfit-nowline')).toBeNull();
  });
});

describe('WeekViewRoot — rail integration', () => {
  it('feeds snapshot.tasks + snapshot.thisweek into the rail', () => {
    renderRoot({
      snapshot: snapshot({
        tasks: [vaultTask('From tasks')],
        thisweek: [vaultTask('From thisweek')],
      }),
    });
    expect(screen.getByText('From tasks')).toBeInTheDocument();
    expect(screen.getByText('From thisweek')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Phase 2B — "Fit this week", ghosts, capacity, and what actually got written
// ---------------------------------------------------------------------------

describe('WeekViewRoot — fit: null (Phase 1 view unchanged)', () => {
  it('renders no ghost or fit-only chrome when fit is null', () => {
    renderRoot();
    expect(document.querySelector('.weekfit-ghost')).toBeNull();
    expect(document.querySelector('.weekfit-capacity')).toBeNull();
    expect(document.querySelector('.weekfit-unplaced')).toBeNull();
    // The button that starts a fit is always present — it's the entry point —
    // but nothing it would produce exists yet.
    expect(screen.getByText('Fit this week')).toBeInTheDocument();
  });
});

describe('WeekViewRoot — "Fit this week"', () => {
  it('calls onFit exactly once when pressed', () => {
    const onFit = vi.fn();
    renderRoot({ onFit });
    fireEvent.click(screen.getByText('Fit this week'));
    expect(onFit).toHaveBeenCalledTimes(1);
  });

  it('disables the button and shows a pending label while fitting', () => {
    renderRoot({ fitting: true });
    const btn = screen.getByText('Fitting…');
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });
});

describe('WeekViewRoot — ghost proposals', () => {
  it('renders a ghost for each proposal, in the right day column, distinguishable from real blocks', () => {
    const wednesday = addDays(WEEK_START, 2);
    const start = new Date(wednesday);
    start.setHours(9, 0, 0, 0);
    const end = new Date(wednesday);
    end.setHours(10, 0, 0, 0);

    const p = proposal({ day: 4, startMin: 14 * 60, endMin: 15 * 60, title: 'Edit video' });

    renderRoot({
      snapshot: snapshot({ scheduled: [calEvent({ uid: 'e1', title: 'Standup', start, end })] }),
      fit: fitState({ proposals: [p] }),
    });

    const ghostCol = document.querySelector('[data-day="4"]');
    expect(ghostCol).not.toBeNull();
    const ghost = ghostCol!.querySelector('.weekfit-ghost');
    expect(ghost).not.toBeNull();
    expect(ghost!.textContent).toContain('Edit video');

    // Not in any other column.
    for (const di of [0, 1, 2, 3, 5, 6]) {
      expect(document.querySelector(`[data-day="${di}"]`)!.querySelector('.weekfit-ghost')).toBeNull();
    }

    // Ghosts and real scheduled blocks carry mutually exclusive classes — a
    // ghost must never be mistaken for something already on the calendar.
    const realEvent = document.querySelector('.weekfit-ev')!;
    expect(realEvent.classList.contains('weekfit-ghost')).toBe(false);
    expect(ghost!.classList.contains('weekfit-ev')).toBe(false);
  });

  it('accepting one group does not remove the other groups\' ghosts', () => {
    const a = proposal({ key: 'A', groupKey: 'A', day: 0, title: 'Task A' });
    const b = proposal({ key: 'B', groupKey: 'B', day: 1, title: 'Task B' });
    const onAccept = vi.fn();
    renderRoot({ fit: fitState({ proposals: [a, b] }), onAccept });

    // The ghost's own action, not the toolbar's "Accept all" — and by class
    // rather than by label, which changes with the block's height.
    fireEvent.click(document.querySelectorAll('.weekfit-ghost__accept')[0]);

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledWith('A');
    // `fit` is owned by the caller and hasn't changed, so both ghosts must
    // still be on screen — this is the ghost-wipe bug, written down.
    expect(screen.getByText('Task A')).toBeInTheDocument();
    expect(screen.getByText('Task B')).toBeInTheDocument();
  });

  it('calls onAccept with the group that was actually clicked', () => {
    const a = proposal({ key: 'A', groupKey: 'A', day: 0, title: 'Task A' });
    const b = proposal({ key: 'B', groupKey: 'B', day: 1, title: 'Task B' });
    const onAccept = vi.fn();
    renderRoot({ fit: fitState({ proposals: [a, b] }), onAccept });

    fireEvent.click(document.querySelectorAll('.weekfit-ghost__accept')[1]);

    expect(onAccept).toHaveBeenCalledWith('B');
  });

  it('"Accept all" calls onAcceptAll once, not once per proposal', () => {
    const a = proposal({ key: 'A', groupKey: 'A', day: 0 });
    const b = proposal({ key: 'B', groupKey: 'B', day: 1 });
    const onAcceptAll = vi.fn();
    renderRoot({ fit: fitState({ proposals: [a, b] }), onAcceptAll });

    fireEvent.click(screen.getByText('Accept all'));

    expect(onAcceptAll).toHaveBeenCalledTimes(1);
  });

  it('dismiss calls onDismiss with only the clicked group\'s key', () => {
    const a = proposal({ key: 'A', groupKey: 'A', day: 0, title: 'Task A' });
    const b = proposal({ key: 'B', groupKey: 'B', day: 1, title: 'Task B' });
    const onDismiss = vi.fn();
    renderRoot({ fit: fitState({ proposals: [a, b] }), onDismiss });

    fireEvent.click(document.querySelectorAll('.weekfit-ghost__dismiss')[1]);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('B');
  });
});

describe('WeekViewRoot — capacity line', () => {
  it('renders "X committed / Yh free"', () => {
    renderRoot({ fit: fitState({ capacity: capacity({ committedMin: 390, freeMin: 840 }) }) });
    expect(screen.getByText(/6\.5h committed \/ 14h free/)).toBeInTheDocument();
  });

  it('adds the over-committed class when overBy > 0', () => {
    renderRoot({
      fit: fitState({ capacity: capacity({ committedMin: 900, freeMin: 480, overBy: 420 }) }),
    });
    const line = document.querySelector('.weekfit-capacity');
    expect(line).not.toBeNull();
    expect(line!.classList.contains('weekfit-capacity--over')).toBe(true);
  });

  it('does not add the over-committed class when overBy is 0', () => {
    renderRoot({ fit: fitState({ capacity: capacity({ committedMin: 60, freeMin: 480 }) }) });
    const line = document.querySelector('.weekfit-capacity');
    expect(line!.classList.contains('weekfit-capacity--over')).toBe(false);
  });

  it('says no availability windows are set, and never "0h free", when freeMin is null', () => {
    renderRoot({ fit: fitState({ capacity: capacity({ committedMin: 120, freeMin: null }) }) });
    expect(screen.getByText(/no availability windows set/i)).toBeInTheDocument();
    expect(screen.queryByText(/0h free/)).not.toBeInTheDocument();
  });
});

describe('WeekViewRoot — gap candidates', () => {
  const gap: Gap = {
    day: 0,
    startMin: 9 * 60,
    endMin: 10 * 60,
    minutes: 60,
    window: 'work',
    windowIndex: 0,
    minBlockMin: 30,
  };

  it('does not render gaps when settings.showGaps is false', () => {
    renderRoot({
      settings: { ...settings, showGaps: false },
      fit: fitState({ gaps: [gap] }),
    });
    expect(document.querySelector('.weekfit-gap')).toBeNull();
  });

  it('renders gaps when settings.showGaps is true', () => {
    renderRoot({
      settings: { ...settings, showGaps: true },
      fit: fitState({ gaps: [gap] }),
    });
    expect(document.querySelector('.weekfit-gap')).not.toBeNull();
  });
});

describe('WeekViewRoot — unplaced tasks', () => {
  it('lists fit.unplaced entries along with a reason', () => {
    renderRoot({
      fit: fitState({
        unplaced: [{ key: 'x', title: 'Giant project', minutes: 600, reason: 'too-many-sessions' }],
      }),
    });
    expect(screen.getByText('Giant project')).toBeInTheDocument();
    expect(screen.getByText(/more than four sittings/i)).toBeInTheDocument();
  });

  it('gives the no-gap reason different wording from too-many-sessions', () => {
    renderRoot({
      fit: fitState({
        unplaced: [{ key: 'x', title: 'Errand', minutes: 30, reason: 'no-gap' }],
      }),
    });
    expect(screen.getByText(/widening a window/i)).toBeInTheDocument();
  });
});

describe('WeekViewRoot — last write result', () => {
  it('shows a visible warning for a line-changed skip', () => {
    renderRoot({
      lastWrite: writeResult({
        skipped: [{ key: 'x', title: 'Write report', reason: 'line-changed' }],
      }),
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/changed since this was proposed/i)).toBeInTheDocument();
    expect(screen.getByText('Write report')).toBeInTheDocument();
  });

  it('renders nothing when the last write had no skips or errors', () => {
    renderRoot({ lastWrite: writeResult({ written: 3 }) });
    expect(document.querySelector('.weekfit-writeresult')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 2C — week navigation
// ---------------------------------------------------------------------------

describe('WeekViewRoot — week navigation', () => {
  it('calls onPrevWeek exactly once when ‹ is pressed', () => {
    const onPrevWeek = vi.fn();
    renderRoot({ onPrevWeek });
    fireEvent.click(screen.getByLabelText('Previous week'));
    expect(onPrevWeek).toHaveBeenCalledTimes(1);
  });

  it('calls onNextWeek exactly once when › is pressed', () => {
    const onNextWeek = vi.fn();
    renderRoot({ onNextWeek });
    fireEvent.click(screen.getByLabelText('Next week'));
    expect(onNextWeek).toHaveBeenCalledTimes(1);
  });

  it('calls onToday exactly once when Today is pressed (not the current week)', () => {
    const onToday = vi.fn();
    renderRoot({ isCurrentWeek: false, onToday });
    fireEvent.click(screen.getByText('Today'));
    expect(onToday).toHaveBeenCalledTimes(1);
  });

  it('disables Today when isCurrentWeek is true', () => {
    renderRoot({ isCurrentWeek: true });
    expect(screen.getByText('Today')).toBeDisabled();
  });

  it('leaves Today enabled when isCurrentWeek is false', () => {
    renderRoot({ isCurrentWeek: false });
    expect(screen.getByText('Today')).not.toBeDisabled();
  });

  it('never fires onToday from a disabled Today button (a browser wouldn\'t dispatch the click, but the wiring must not fake one)', () => {
    const onToday = vi.fn();
    renderRoot({ isCurrentWeek: true, onToday });
    fireEvent.click(screen.getByText('Today'));
    expect(onToday).not.toHaveBeenCalled();
  });

  it('shows the range for a non-current, past week — not the snapshot\'s own week', () => {
    const pastWeek = addDays(WEEK_START, -21); // three weeks before NOW
    renderRoot({
      weekStart: pastWeek,
      isCurrentWeek: false,
      snapshot: snapshot({ weekStart: pastWeek, weekId: '2026-W33' }),
    });
    expect(screen.getByText(fmtWeekRange(pastWeek))).toBeInTheDocument();
    expect(screen.queryByText(fmtWeekRange(WEEK_START))).not.toBeInTheDocument();
  });

  it('renders no now-line for a week in the past, even though `now` is real and non-null', () => {
    const pastWeek = addDays(WEEK_START, -21);
    renderRoot({
      weekStart: pastWeek,
      isCurrentWeek: false,
      snapshot: snapshot({ weekStart: pastWeek }),
    });
    expect(document.querySelector('.weekfit-nowline')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 2C — positioning keys off weekStart, never off the real clock
// ---------------------------------------------------------------------------

describe('WeekViewRoot — positions from weekStart, not the real clock', () => {
  it('places a scheduled block in the right day column for a week in the past', () => {
    // A regression guard for "the view quietly assumes this week": weekStart
    // (and the matching snapshot) point at a week that ended long ago, and a
    // block on that week's Wednesday must still land in Wednesday's column —
    // it must not be computed against today's real date.
    const pastWeek = addDays(WEEK_START, -21);
    const wednesday = addDays(pastWeek, 2);
    const start = new Date(wednesday);
    start.setHours(9, 0, 0, 0);
    const end = new Date(wednesday);
    end.setHours(10, 0, 0, 0);

    renderRoot({
      weekStart: pastWeek,
      isCurrentWeek: false,
      snapshot: snapshot({
        weekStart: pastWeek,
        scheduled: [calEvent({ uid: 'e1', title: 'Old standup', start, end })],
        scheduledLines: [vaultTask('- [ ] Old standup', { line: 3 })],
      }),
    });

    const col = document.querySelector('[data-day="2"]'); // Mon=0 -> Wed=2
    expect(col).not.toBeNull();
    expect(col!.querySelector('.weekfit-ev')?.textContent).toContain('Old standup');

    for (const di of [0, 1, 3, 4, 5, 6]) {
      const other = document.querySelector(`[data-day="${di}"]`);
      expect(other!.querySelector('.weekfit-ev')).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 2C — interacting with a block already on the grid
// ---------------------------------------------------------------------------

describe('WeekViewRoot — real block: click opens the source, drag does not', () => {
  function renderWithEvent(onOpenSource: (uid: string) => void) {
    const wednesday = addDays(WEEK_START, 2);
    const start = new Date(wednesday);
    start.setHours(9, 0, 0, 0);
    const end = new Date(wednesday);
    end.setHours(10, 0, 0, 0);
    renderRoot({
      onOpenSource,
      snapshot: snapshot({
        scheduled: [calEvent({ uid: 'Weekly/2026-W36.md:7', title: 'Team sync', start, end })],
        scheduledLines: [vaultTask('- [ ] Team sync', { line: 7 })],
      }),
    });
    return document.querySelector('.weekfit-ev')! as HTMLElement;
  }

  it('calls onOpenSource with the block\'s uid on a plain click (no movement)', () => {
    const onOpenSource = vi.fn();
    const block = renderWithEvent(onOpenSource);

    fireEvent.pointerDown(block, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(block, { clientX: 100, clientY: 100, pointerId: 1 });

    expect(onOpenSource).toHaveBeenCalledTimes(1);
    expect(onOpenSource).toHaveBeenCalledWith('Weekly/2026-W36.md:7');
  });

  it('does not call onOpenSource when the pointer moves past the drag threshold', () => {
    const onOpenSource = vi.fn();
    const onMoveBlock = vi.fn();
    const block = renderWithEvent(onOpenSource);

    fireEvent.pointerDown(block, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(block, { clientX: 100, clientY: 140, pointerId: 1 }); // past the 4px threshold
    fireEvent.pointerUp(block, { clientX: 100, clientY: 140, pointerId: 1 });

    expect(onOpenSource).not.toHaveBeenCalled();
    void onMoveBlock; // not asserted on here — jsdom gives every rect 0x0, so
    // where exactly the drop lands isn't meaningful in this environment; see
    // the report's "what could not be verified" section.
  });

  it('does not fire onOpenSource for a movement under the 4px threshold (still a click)', () => {
    const onOpenSource = vi.fn();
    const block = renderWithEvent(onOpenSource);

    fireEvent.pointerDown(block, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(block, { clientX: 101, clientY: 102, pointerId: 1 }); // under threshold
    fireEvent.pointerUp(block, { clientX: 101, clientY: 102, pointerId: 1 });

    expect(onOpenSource).toHaveBeenCalledTimes(1);
  });
});

describe('WeekViewRoot — real block: unschedule', () => {
  it('calls onUnschedule with the block\'s uid, and does not also open the source', () => {
    const wednesday = addDays(WEEK_START, 2);
    const start = new Date(wednesday);
    start.setHours(9, 0, 0, 0);
    const end = new Date(wednesday);
    end.setHours(10, 0, 0, 0);
    const onUnschedule = vi.fn();
    const onOpenSource = vi.fn();

    renderRoot({
      onUnschedule,
      onOpenSource,
      snapshot: snapshot({
        scheduled: [calEvent({ uid: 'Weekly/2026-W36.md:9', title: 'Write report', start, end })],
        scheduledLines: [vaultTask('- [ ] Write report', { line: 9 })],
      }),
    });

    fireEvent.click(screen.getByText('Unschedule'));

    expect(onUnschedule).toHaveBeenCalledTimes(1);
    expect(onUnschedule).toHaveBeenCalledWith('Weekly/2026-W36.md:9');
    expect(onOpenSource).not.toHaveBeenCalled();
  });

  it('labels the control in plain language, not an ambiguous symbol', () => {
    const wednesday = addDays(WEEK_START, 2);
    const start = new Date(wednesday);
    start.setHours(9, 0, 0, 0);
    const end = new Date(wednesday);
    end.setHours(10, 0, 0, 0);
    renderRoot({
      snapshot: snapshot({
        scheduled: [calEvent({ uid: 'e1', title: 'Write report', start, end })],
      }),
    });
    expect(screen.getByText('Unschedule')).toBeInTheDocument();
  });
});

describe('WeekViewRoot — ghosts stay visually distinct from real, interactive blocks', () => {
  it('a real block and a ghost never share a class, even though both now drag', () => {
    const wednesday = addDays(WEEK_START, 2);
    const start = new Date(wednesday);
    start.setHours(9, 0, 0, 0);
    const end = new Date(wednesday);
    end.setHours(10, 0, 0, 0);
    const p = proposal({ day: 2, startMin: 14 * 60, endMin: 15 * 60, title: 'Edit video' });

    renderRoot({
      snapshot: snapshot({ scheduled: [calEvent({ uid: 'e1', title: 'Standup', start, end })] }),
      fit: fitState({ proposals: [p] }),
    });

    const realBlock = document.querySelector('.weekfit-ev')!;
    const ghost = document.querySelector('.weekfit-ghost')!;
    expect(realBlock.className).not.toContain('weekfit-ghost');
    expect(ghost.className).not.toContain('weekfit-ev');
    // A real block carries an "Unschedule" control; a ghost carries
    // Accept/Dismiss instead — the two vocabularies never mix.
    expect(realBlock.textContent).toContain('Unschedule');
    expect(ghost.textContent).not.toContain('Unschedule');
  });
});

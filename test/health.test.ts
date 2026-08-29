import { describe, expect, it } from 'vitest';
import {
  REVIEW_HOUR,
  healthLine,
  isReviewTime,
  reviewPrompt,
  weekHealth,
} from '../src/lib/health';
import { DEFAULT_LEAD_MIN, buildUpcoming, leadState } from '../src/lib/upcoming';
import type { CalEvent, SkeletonBlock, VaultTask } from '../src/lib/types';
import type { WeekAudit } from '../src/lib/audit';
import type { Streak } from '../src/lib/streaks';

const task = (text: string, done = false, line = 0): VaultTask => ({
  text,
  done,
  file: 'Weekly/2026-W36.md',
  line,
});

const audit = (planned: number, kept: number): WeekAudit =>
  ({
    rows: [{ key: 'kind:gym', label: 'Gym', plannedMin: planned, keptMin: kept }],
  }) as unknown as WeekAudit;

// ---------------------------------------------------------------------------
// Phase 6 §1 — pre-block escalation
// ---------------------------------------------------------------------------

describe('leadState — the lead window', () => {
  const at = (h: number, m = 0) => new Date(2026, 8, 2, h, m);

  it('is quiet outside the window', () => {
    expect(leadState(at(18, 30), at(18, 0), 15)).toEqual({});
  });

  it('escalates once inside it, counting down in minutes', () => {
    expect(leadState(at(18, 30), at(18, 20), 15)).toEqual({ imminent: true, inMin: 10 });
    expect(leadState(at(18, 30), at(18, 29), 15)).toEqual({ imminent: true, inMin: 1 });
  });

  it('clears at the block start — there is nothing to dismiss', () => {
    // A countdown that has reached zero has said everything it has to say.
    expect(leadState(at(18, 30), at(18, 30), 15)).toEqual({});
    expect(leadState(at(18, 30), at(18, 45), 15)).toEqual({});
  });

  it('treats lead 0 as "never escalate this block"', () => {
    expect(leadState(at(18, 30), at(18, 29), 0)).toEqual({});
  });

  it('opens exactly on the boundary minute, not a minute early', () => {
    expect(leadState(at(18, 30), at(18, 15), 15)).toMatchObject({ imminent: true });
    expect(leadState(at(18, 30), at(18, 14), 15)).toEqual({});
  });

  it('compares instants, so a DST Sunday cannot fire it an hour out', () => {
    // Sydney springs forward 02:00 -> 03:00 on Sun 4 Oct 2026. A block later
    // that day is still exactly its lead window away in real time.
    const start = new Date(2026, 9, 4, 14, 0);
    const now = new Date(start.getTime() - 10 * 60_000);
    expect(leadState(start, now, 15)).toEqual({ imminent: true, inMin: 10 });
  });
});

describe('buildUpcoming carries the flag', () => {
  const GYM: SkeletonBlock = {
    name: 'Gym',
    kind: 'gym',
    days: [0, 1, 2, 3, 4],
    startMin: 6 * 60,
    endMin: 7 * 60,
  };

  it('marks a block imminent inside the default lead', () => {
    const now = new Date(2026, 8, 7, 5, 50); // Mon 05:50, gym at 06:00
    const [next] = buildUpcoming([], [GYM], now, 1);
    expect(next).toMatchObject({ label: 'Gym', imminent: true, inMin: 10 });
  });

  it('leaves it alone outside the lead', () => {
    const now = new Date(2026, 8, 7, 5, 0);
    const [next] = buildUpcoming([], [GYM], now, 1);
    expect(next.imminent).toBeUndefined();
  });

  it('honours a per-block lead, including 0', () => {
    const now = new Date(2026, 8, 7, 5, 50);
    expect(buildUpcoming([], [{ ...GYM, leadMin: 30 }], now, 1)[0].inMin).toBe(10);
    expect(buildUpcoming([], [{ ...GYM, leadMin: 0 }], now, 1)[0].imminent).toBeUndefined();
    // …and 5 is narrower than the 10 minutes remaining, so it stays quiet.
    expect(buildUpcoming([], [{ ...GYM, leadMin: 5 }], now, 1)[0].imminent).toBeUndefined();
  });

  it('defaults to 15 minutes when a block says nothing', () => {
    expect(DEFAULT_LEAD_MIN).toBe(15);
  });

  it('never escalates a real calendar event — the lead is a skeleton idea', () => {
    // Escalation says "your recurring block is about to start". A one-off
    // meeting is not that, and flagging every event would make the HUD shout.
    const ev: CalEvent = {
      uid: 'a',
      title: 'Dentist',
      start: new Date(2026, 8, 7, 6, 0),
      end: new Date(2026, 8, 7, 7, 0),
      allDay: false,
    };
    const now = new Date(2026, 8, 7, 5, 55);
    expect(buildUpcoming([ev], [], now, 1)[0].imminent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 6 §3 — week health
// ---------------------------------------------------------------------------

describe('weekHealth', () => {
  const streaks: Streak[] = [
    { kind: 'gym', label: 'Gym', done: 3, target: 5 },
    { kind: 'stream', label: 'Stream', done: 4, target: 4 },
  ];

  it('adds up the four numbers worth a glance', () => {
    const h = weekHealth(
      [task('Ship it', true), task('Rest', false, 1)],
      [task('A'), task('B', true, 1), task('C', false, 2)],
      streaks,
      audit(720, 540),
    );
    expect(h).toEqual({
      intentionsDone: 1,
      intentionsTotal: 2,
      keptMin: 540,
      plannedMin: 720,
      streaksKept: 7,
      streaksTotal: 9,
      unplanned: 2,
    });
  });

  it('reads zero hours when the week has never been audited', () => {
    const h = weekHealth([], [], [], null);
    expect(h.keptMin).toBe(0);
    expect(h.plannedMin).toBe(0);
  });
});

describe('healthLine', () => {
  it('reads as a sentence, not a dashboard', () => {
    const h = weekHealth(
      [task('One', true), task('Two', false, 1), task('Three', false, 2)],
      [task('A'), task('B', false, 1)],
      [{ kind: 'gym', label: 'Gym', done: 3, target: 5 }],
      audit(720, 540),
    );
    expect(healthLine(h)).toBe('1/3 intentions  ·  9h of 12h kept  ·  3/5 blocks  ·  2 unplanned');
  });

  it('drops the segments with nothing to say rather than glowing 0/0 at you', () => {
    expect(healthLine(weekHealth([], [], [], null))).toBe('');
    const onlyIntentions = weekHealth([task('One', true)], [], [], null);
    expect(healthLine(onlyIntentions)).toBe('1/1 intentions');
  });
});

describe('the Sunday review prompt', () => {
  it('asks on Sunday evening and not before', () => {
    expect(isReviewTime(new Date(2026, 8, 6, REVIEW_HOUR))).toBe(true); // Sun 17:00
    expect(isReviewTime(new Date(2026, 8, 6, 21, 30))).toBe(true);
    expect(isReviewTime(new Date(2026, 8, 6, 16, 59))).toBe(false);
    expect(isReviewTime(new Date(2026, 8, 5, 21, 0))).toBe(false); // Saturday
    expect(isReviewTime(new Date(2026, 8, 7, 21, 0))).toBe(false); // Monday
  });

  it('says which week is ending and how it went', () => {
    const h = weekHealth([task('One', true), task('Two', false, 1)], [], [], null);
    // It names the hotkey rather than asking an open question: the overlay it
    // appears on hides the moment you reach for the mouse, so 'review?' had no
    // path to the review (bug #24).
    expect(reviewPrompt('2026-W36', h)).toBe(
      'W36 ends today  ·  1/2 intentions  ·  Ctrl+Alt+W to review',
    );
  });

  it('still asks when no intentions were set', () => {
    expect(reviewPrompt('2026-W36', weekHealth([], [], [], null))).toBe(
      'W36 ends today  ·  Ctrl+Alt+W to review',
    );
  });
});

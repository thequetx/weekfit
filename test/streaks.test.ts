import { describe, expect, it } from 'vitest';
import { claimSlots, computeStreaks, matchSlot } from '../src/lib/streaks';
import { startOfISOWeek } from '../src/lib/week';
import type { CalEvent, SkeletonBlock } from '../src/lib/types';

const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min);

const WEEK_START = startOfISOWeek(at(2026, 8, 24)); // Mon 24 Aug 2026

const ev = (uid: string, title: string, day: number, h: number, min = 0): CalEvent => ({
  uid,
  title,
  start: at(2026, 8, 24 + day, h, min),
  end: at(2026, 8, 24 + day, h + 1, min),
  allDay: false,
});

const GYM: SkeletonBlock = {
  name: 'Gym',
  kind: 'gym',
  days: [0, 1, 2, 3, 4],
  startMin: 6 * 60,
  endMin: 7 * 60,
};
const STREAM: SkeletonBlock = {
  name: 'Twitch Stream',
  kind: 'stream',
  days: [0, 1, 3, 4],
  startMin: 18 * 60 + 30,
  endMin: 21 * 60 + 30,
};
const GROCERY: SkeletonBlock = {
  name: 'Grocery Run',
  kind: 'errand',
  days: [6],
  startMin: 14 * 60,
  endMin: 15 * 60,
};

describe('computeStreaks', () => {
  it('counts one slot per matching event', () => {
    const events = [ev('a', 'Gym', 0, 6), ev('b', 'Gym', 2, 6), ev('c', 'Gym', 4, 6)];
    expect(computeStreaks(WEEK_START, events, [GYM])).toEqual([
      { kind: 'gym', label: 'Gym', done: 3, target: 5 },
    ]);
  });

  it('drops kinds with fewer than two slots — one-a-week things are not streaks', () => {
    expect(computeStreaks(WEEK_START, [], [GROCERY])).toEqual([]);
  });

  it('merges slots from several blocks sharing a kind', () => {
    const extra: SkeletonBlock = { ...GROCERY, name: 'Second Run', days: [2] };
    const out = computeStreaks(WEEK_START, [], [GROCERY, extra]);
    expect(out).toEqual([{ kind: 'errand', label: 'Errand', done: 0, target: 2 }]);
  });

  it('titleizes a hyphenated kind', () => {
    const prep: SkeletonBlock = {
      name: 'Meal Prep',
      kind: 'meal-prep',
      days: [2, 6],
      startMin: 15 * 60,
      endMin: 17 * 60,
    };
    expect(computeStreaks(WEEK_START, [], [prep])[0].label).toBe('Meal Prep');
  });

  it('sorts by target descending, so the big commitments lead', () => {
    const out = computeStreaks(WEEK_START, [], [STREAM, GYM]);
    expect(out.map((s) => s.kind)).toEqual(['gym', 'stream']);
  });

  describe('the ±90 minute window', () => {
    it('accepts an event that slipped by up to 90 minutes', () => {
      expect(computeStreaks(WEEK_START, [ev('a', 'Gym', 0, 7, 30)], [GYM])[0].done).toBe(1);
      expect(computeStreaks(WEEK_START, [ev('a', 'Gym', 0, 4, 30)], [GYM])[0].done).toBe(1);
    });

    it('rejects one that slipped further', () => {
      expect(computeStreaks(WEEK_START, [ev('a', 'Gym', 0, 7, 31)], [GYM])[0].done).toBe(0);
      expect(computeStreaks(WEEK_START, [ev('a', 'Gym', 0, 4, 29)], [GYM])[0].done).toBe(0);
    });

    it('will not match an event on the wrong day', () => {
      // Saturday has no gym slot; 06:00 Saturday must not satisfy Friday's.
      expect(computeStreaks(WEEK_START, [ev('a', 'Gym', 5, 6)], [GYM])[0].done).toBe(0);
    });

    it('will not match an event in another week', () => {
      const nextWeek: CalEvent = {
        uid: 'x',
        title: 'Gym',
        start: at(2026, 8, 31, 6),
        end: at(2026, 8, 31, 7),
        allDay: false,
      };
      expect(computeStreaks(WEEK_START, [nextWeek], [GYM])[0].done).toBe(0);
    });

    it('ignores all-day events', () => {
      const allDay: CalEvent = { ...ev('a', 'Gym', 0, 6), allDay: true };
      expect(computeStreaks(WEEK_START, [allDay], [GYM])[0].done).toBe(0);
    });
  });

  it('does not double-count two events landing in the same slot', () => {
    const events = [ev('a', 'Gym', 0, 6), ev('b', 'Gym again', 0, 6, 15)];
    expect(computeStreaks(WEEK_START, events, [GYM])[0].done).toBe(1);
  });

  it('lets one event satisfy two slots when they are within 90 min of each other', () => {
    // Documenting the current behaviour: the match is per-slot, so a single
    // event 90 min from two slots on the same day counts for both. The real
    // skeleton has no two same-kind slots that close on one day.
    const tight: SkeletonBlock[] = [
      { name: 'A', kind: 'gym', days: [0], startMin: 6 * 60, endMin: 7 * 60 },
      { name: 'B', kind: 'gym', days: [0], startMin: 7 * 60, endMin: 8 * 60 },
    ];
    expect(computeStreaks(WEEK_START, [ev('a', 'Gym', 0, 6, 30)], tight)[0]).toEqual({
      kind: 'gym',
      label: 'Gym',
      done: 2,
      target: 2,
    });
  });

  it('counts a real event even when this app booked it', () => {
    // Phase 4 §5 put `matchSlot` behind both the streak rail and the audit, and
    // briefly made both refuse blocks carrying a `taskId`. The audit needs that
    // (it counts accepted blocks as planned time of their own, so crediting one
    // to a skeleton slot as well counts the hour twice) — a streak does not. A
    // gym session that happened is a gym session that happened, and `Gym 4/5`
    // because one of the five was booked through the Planner is a wrong number.
    // Reachable: accepting a proposal for a task whose line already carries a
    // `🆔` creates exactly such an event.
    const mine: CalEvent = { ...ev('a', 'Gym', 0, 6), taskId: 'wd-1' };
    expect(computeStreaks(WEEK_START, [mine], [GYM])[0].done).toBe(1);
  });

  it('lets the audit, and only the audit, refuse this app own blocks', () => {
    const mine: CalEvent = { ...ev('a', 'Gym', 0, 6), taskId: 'wd-1' };
    const slot = { day: 0, startMin: 6 * 60 };
    expect(matchSlot(WEEK_START, slot, [mine])).not.toBeNull();
    expect(matchSlot(WEEK_START, slot, [mine], { skipAppBlocks: true })).toBeNull();
  });

  describe('claimSlots — one event, at most one slot', () => {
    // The shipped skeleton really does put these an hour apart, and NEAR_MS is
    // ninety minutes: `Grocery Run` sun 14:00–15:00, `Meal Prep` sun 15:00–17:00.
    const MEAL: SkeletonBlock = {
      name: 'Meal Prep',
      kind: 'meal-prep',
      days: [6],
      startMin: 15 * 60,
      endMin: 17 * 60,
    };

    it('does not let one real event keep two adjacent skeleton slots', () => {
      // Sunday, one three-hour "Groceries + batch cook". Asked slot by slot,
      // both claim it and the retrospective reports 360 minutes kept out of 180
      // minutes lived — in a number Phase 5 persists into frontmatter.
      const shop: CalEvent = {
        uid: 'a',
        title: 'Groceries + batch cook',
        start: at(2026, 8, 30, 14),
        end: at(2026, 8, 30, 17),
        allDay: false,
      };
      const slots = [
        { day: 6, startMin: 14 * 60 },
        { day: 6, startMin: 15 * 60 },
      ];
      expect(matchSlot(WEEK_START, slots[0], [shop])).not.toBeNull();
      expect(matchSlot(WEEK_START, slots[1], [shop])).not.toBeNull();

      const claimed = claimSlots(WEEK_START, slots, [shop]);
      expect(claimed.filter(Boolean)).toHaveLength(1);
      // Nearest slot wins — it starts exactly on the grocery run.
      expect(claimed[0]?.uid).toBe('a');
      expect(claimed[1]).toBeNull();
    });

    it('gives each slot its own event when there are enough to go round', () => {
      const shop = {
        uid: 'a',
        title: 'Groceries',
        start: at(2026, 8, 30, 14),
        end: at(2026, 8, 30, 15),
        allDay: false,
      };
      const cook = {
        uid: 'b',
        title: 'Meal prep',
        start: at(2026, 8, 30, 15),
        end: at(2026, 8, 30, 17),
        allDay: false,
      };
      const slots = [
        { day: 6, startMin: 14 * 60 },
        { day: 6, startMin: 15 * 60 },
      ];
      expect(claimSlots(WEEK_START, slots, [shop, cook]).map((e) => e?.uid)).toEqual([
        'a',
        'b',
      ]);
    });

    it('does not depend on the order the calendar arrived in', () => {
      const a = {
        uid: 'a',
        title: 'One',
        start: at(2026, 8, 30, 14),
        end: at(2026, 8, 30, 15),
        allDay: false,
      };
      const b = {
        uid: 'b',
        title: 'Two',
        start: at(2026, 8, 30, 15),
        end: at(2026, 8, 30, 16),
        allDay: false,
      };
      const slots = [
        { day: 6, startMin: 14 * 60 },
        { day: 6, startMin: 15 * 60 },
      ];
      expect(claimSlots(WEEK_START, slots, [a, b]).map((e) => e?.uid)).toEqual(
        claimSlots(WEEK_START, slots, [b, a]).map((e) => e?.uid),
      );
    });

  });

  it('returns nothing when there is no skeleton at all', () => {
    expect(computeStreaks(WEEK_START, [ev('a', 'Gym', 0, 6)], [])).toEqual([]);
  });
});

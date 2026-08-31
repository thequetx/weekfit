import { describe, expect, it } from 'vitest';
import { deltaIcsEvents, hashIcsEvent, nextIcsState, snapshotOf } from '../src/data/icsState';
import type { IcsState } from '../src/data/contract';
import type { CalEvent } from '../src/lib/types';

function ev(overrides: Partial<CalEvent> = {}): CalEvent {
  return {
    uid: 'uid-1',
    title: 'Dentist',
    start: new Date(2026, 8, 2, 9, 0),
    end: new Date(2026, 8, 2, 9, 30),
    allDay: false,
    ...overrides,
  };
}

describe('hashIcsEvent', () => {
  it('is stable for the same inputs', () => {
    const a = hashIcsEvent('Dentist', '2026-09-02T09:00:00.000Z', '2026-09-02T09:30:00.000Z');
    const b = hashIcsEvent('Dentist', '2026-09-02T09:00:00.000Z', '2026-09-02T09:30:00.000Z');
    expect(a).toBe(b);
  });

  it('is sensitive to a title change', () => {
    const a = hashIcsEvent('Dentist', '2026-09-02T09:00:00.000Z', '2026-09-02T09:30:00.000Z');
    const b = hashIcsEvent('Dentist!', '2026-09-02T09:00:00.000Z', '2026-09-02T09:30:00.000Z');
    expect(a).not.toBe(b);
  });

  it('is sensitive to a time change', () => {
    const a = hashIcsEvent('Dentist', '2026-09-02T09:00:00.000Z', '2026-09-02T09:30:00.000Z');
    const b = hashIcsEvent('Dentist', '2026-09-02T10:00:00.000Z', '2026-09-02T09:30:00.000Z');
    expect(a).not.toBe(b);
  });

  it('does not collide across a naive field-concatenation boundary', () => {
    // "AB" + "C" vs "A" + "BC" — a hash built by simple string concatenation
    // without separators would collide here.
    const a = hashIcsEvent('AB', 'C', 'end');
    const b = hashIcsEvent('A', 'BC', 'end');
    expect(a).not.toBe(b);
  });

  it('returns 8 lowercase hex characters', () => {
    const h = hashIcsEvent('x', 'y', 'z');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('snapshotOf', () => {
  it('captures title, ISO start/end, and a matching hash', () => {
    const snap = snapshotOf(ev());
    expect(snap.title).toBe('Dentist');
    expect(snap.timeStart).toBe(new Date(2026, 8, 2, 9, 0).toISOString());
    expect(snap.timeEnd).toBe(new Date(2026, 8, 2, 9, 30).toISOString());
    expect(snap.hash).toBe(hashIcsEvent(snap.title, snap.timeStart, snap.timeEnd));
  });
});

describe('deltaIcsEvents', () => {
  it('classifies an untouched event as unchanged', () => {
    const fresh = ev();
    const prev: IcsState = { 'uid-1': snapshotOf(fresh) };
    const delta = deltaIcsEvents(prev, [fresh], ['uid-1']);
    expect(delta.unchanged).toEqual(['uid-1']);
    expect(delta.updated).toEqual([]);
    expect(delta.removed).toEqual([]);
  });

  it('classifies a moved-time event as updated, carrying old and new ranges', () => {
    const original = ev();
    const prev: IcsState = { 'uid-1': snapshotOf(original) };
    const moved = ev({ start: new Date(2026, 8, 2, 11, 0), end: new Date(2026, 8, 2, 11, 30) });

    const delta = deltaIcsEvents(prev, [moved], ['uid-1']);
    expect(delta.unchanged).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.updated).toHaveLength(1);
    expect(delta.updated[0]).toMatchObject({
      uid: 'uid-1',
      title: 'Dentist',
      newTitle: 'Dentist',
      oldStart: original.start.toISOString(),
      newStart: moved.start.toISOString(),
    });
  });

  it('classifies a retitled event as updated', () => {
    const original = ev();
    const prev: IcsState = { 'uid-1': snapshotOf(original) };
    const retitled = ev({ title: 'Dentist (rescheduled)' });

    const delta = deltaIcsEvents(prev, [retitled], ['uid-1']);
    expect(delta.updated).toHaveLength(1);
    expect(delta.updated[0].title).toBe('Dentist'); // the old, saved title
    expect(delta.updated[0].newTitle).toBe('Dentist (rescheduled)');
  });

  it('classifies an event dropped from the feed as removed, carrying the old title', () => {
    const original = ev();
    const prev: IcsState = { 'uid-1': snapshotOf(original) };
    const delta = deltaIcsEvents(prev, [], ['uid-1']);
    expect(delta.removed).toEqual([{ uid: 'uid-1', title: 'Dentist' }]);
    expect(delta.unchanged).toEqual([]);
    expect(delta.updated).toEqual([]);
  });

  it('treats a marker with no prior snapshot (first sight) as updated, not a crash', () => {
    const fresh = ev();
    const delta = deltaIcsEvents({}, [fresh], ['uid-1']);
    expect(delta.updated).toHaveLength(1);
    expect(delta.updated[0].title).toBe(''); // nothing saved yet to show
    expect(delta.updated[0].newTitle).toBe('Dentist');
  });

  it('classifies a tracked uid absent from both prev and fresh as removed, not a crash', () => {
    const delta = deltaIcsEvents({}, [], ['uid-ghost']);
    expect(delta.removed).toEqual([{ uid: 'uid-ghost', title: '' }]);
  });

  it('returns all-empty for empty inputs', () => {
    const delta = deltaIcsEvents({}, [], []);
    expect(delta).toEqual({ unchanged: [], updated: [], removed: [] });
  });

  it('never classifies an untracked uid, even if it appears in prev or fresh', () => {
    const fresh = ev({ uid: 'uid-untracked' });
    const prev: IcsState = { 'uid-untracked': snapshotOf(fresh) };
    const delta = deltaIcsEvents(prev, [fresh], []);
    expect(delta).toEqual({ unchanged: [], updated: [], removed: [] });
  });
});

describe('nextIcsState', () => {
  it('keeps a fresh snapshot for a tracked uid still in the feed', () => {
    const fresh = ev();
    const next = nextIcsState({}, [fresh], ['uid-1']);
    expect(next).toEqual({ 'uid-1': snapshotOf(fresh) });
  });

  it('drops a tracked uid no longer in the feed', () => {
    const prev: IcsState = { 'uid-1': snapshotOf(ev()) };
    const next = nextIcsState(prev, [], ['uid-1']);
    expect(next).toEqual({});
  });

  it('never stores an untracked event, even if it is in fresh', () => {
    const fresh = ev({ uid: 'uid-untracked' });
    const next = nextIcsState({}, [fresh], []);
    expect(next).toEqual({});
  });

  it('returns an empty object for empty inputs', () => {
    expect(nextIcsState({}, [], [])).toEqual({});
  });
});

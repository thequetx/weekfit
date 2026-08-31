// Pure delta-tracking for the calendar feed. Zero Obsidian imports, on
// purpose: this is the part of "did the feed change since last time" that
// has nothing to do with the vault, so it's testable with nothing but `node`
// (see test/icsState.test.ts), the same split `src/data/parse.ts` already
// draws between pure parsing and `vaultRepo.ts`'s I/O.
//
// The question this file answers, every refresh, for every `[ics-uid::]`
// marker actually present in the vault (`trackedUids` — never "every event in
// the feed", only the ones a user chose to convert into a task): is the event
// behind that marker unchanged, moved/retitled, or gone from the feed
// entirely? `deltaIcsEvents` classifies; `nextIcsState` is what gets persisted
// once the caller has acted on that classification.

import type { CalEvent } from '../lib/types';
import type { IcsDelta, IcsEventSnapshot, IcsState } from './contract';

/**
 * FNV-1a, 32-bit, returned as 8 hex characters.
 *
 * MD5 was the obvious first choice here. Two reasons that's not what's here: a
 * `platform: 'browser'` esbuild bundle (this plugin's own config) has no
 * `crypto` module to import, and the review guidelines forbid reaching for
 * Node builtins in one anyway; and the hash is never displayed, transmitted,
 * or compared against anything from outside this file — it only ever answers
 * "does this event still look like the one I saved last time", against a copy
 * of itself computed the same way. FNV-1a needs nothing but string indexing
 * and 32-bit math, and collision resistance at that bar is more than this
 * question needs.
 */
export function hashIcsEvent(title: string, start: string, end: string): string {
  // JSON-joined rather than concatenated, so a title ending where the next
  // field's text happens to begin can't produce the same string (and
  // therefore the same hash) as a differently-split title/start/end. A raw
  // separator byte would do the same job, but it would make this file read
  // as binary to git and grep.
  const input = JSON.stringify([title, start, end]);
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV prime, via Math.imul so the multiply stays a 32-bit operation
    // instead of silently promoting to a float and losing the high bits.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** The persisted shape of one live `CalEvent` — what gets compared next time
 *  around. Times are ISO strings (not `Date`s) because that's what survives a
 *  round trip through `data.json` unchanged. */
export function snapshotOf(ev: CalEvent): IcsEventSnapshot {
  const timeStart = ev.start.toISOString();
  const timeEnd = ev.end.toISOString();
  return { title: ev.title, timeStart, timeEnd, hash: hashIcsEvent(ev.title, timeStart, timeEnd) };
}

/**
 * Classify every tracked uid against the freshly-fetched feed.
 *
 * `trackedUids` is the vault's own list — every `[ics-uid::]` marker actually
 * found on a checkbox line right now — not `Object.keys(prev)`, so a marker
 * the user deleted by hand (with `prev` still holding a stale entry for it,
 * or without ever having one) is never classified at all: it isn't tracked
 * any more, and this function only ever speaks about what's tracked.
 */
export function deltaIcsEvents(prev: IcsState, fresh: CalEvent[], trackedUids: string[]): IcsDelta {
  const freshByUid = new Map(fresh.map((ev) => [ev.uid, ev]));

  const unchanged: string[] = [];
  const updated: IcsDelta['updated'] = [];
  const removed: IcsDelta['removed'] = [];

  for (const uid of trackedUids) {
    const freshEv = freshByUid.get(uid);
    const prevSnap = prev[uid];

    if (!freshEv) {
      // Gone from the feed. A tracked uid with no history at all (never in
      // `prev`, and now not in `fresh` either) still has to land somewhere
      // rather than throw — `removed` with an empty title is the honest
      // answer when there's truly nothing to say about it.
      removed.push({ uid, title: prevSnap?.title ?? '' });
      continue;
    }

    const freshSnap = snapshotOf(freshEv);
    if (prevSnap && prevSnap.hash === freshSnap.hash) {
      unchanged.push(uid);
      continue;
    }

    // Either the hash moved (retitled and/or rescheduled) or this is the
    // first refresh since the marker was created (`prevSnap` absent) — both
    // are "updated" from the vault's point of view: there's a fresh
    // start/end/title to reconcile against what the task line currently says.
    updated.push({
      uid,
      title: prevSnap?.title ?? '',
      newTitle: freshSnap.title,
      oldStart: prevSnap?.timeStart ?? '',
      oldEnd: prevSnap?.timeEnd ?? '',
      newStart: freshSnap.timeStart,
      newEnd: freshSnap.timeEnd,
    });
  }

  return { unchanged, updated, removed };
}

/**
 * The state to persist after a refresh. Only ever holds an entry for a uid
 * that is both tracked (has a marker in the vault) and still in the feed —
 * a tracked uid the feed dropped is removed here too, and an event nobody
 * converted into a task is never stored at all (the spec is explicit: this is
 * a record of what the user is tracking, not a cache of the whole feed).
 */
export function nextIcsState(prev: IcsState, fresh: CalEvent[], trackedUids: string[]): IcsState {
  const freshByUid = new Map(fresh.map((ev) => [ev.uid, ev]));
  const out: IcsState = {};
  for (const uid of trackedUids) {
    const freshEv = freshByUid.get(uid);
    if (freshEv) out[uid] = snapshotOf(freshEv);
  }
  return out;
}

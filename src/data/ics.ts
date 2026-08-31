import ICAL from 'ical.js';
import { requestUrl } from 'obsidian';
import type { CalEvent } from '../lib/types';

/**
 * Fetch an iCalendar file and return concrete event occurrences that overlap
 * [rangeStart, rangeEnd). Recurring events are expanded; RECURRENCE-ID overrides
 * are applied. Times are converted to the local timezone via toJSDate().
 */
export async function loadCalendar(
  url: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<CalEvent[]> {
  // `requestUrl` is Obsidian's answer to `fetch` — a plain browser `fetch`
  // would be blocked by CORS against most calendar hosts, and the review
  // guidelines forbid it outright. `throw: false` keeps this branch shaped
  // like the original fetch-based check: read `.status` ourselves rather than
  // catching the thrown error the default behaviour would produce.
  const res = await requestUrl({ url, throw: false });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`calendar feed returned ${res.status}`);
  }

  const jcal = ICAL.parse(res.text);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents('vevent');

  const masters: ICAL.Event[] = [];
  const exceptions: ICAL.Event[] = [];
  for (const v of vevents) {
    const ev = new ICAL.Event(v);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.push(ev);
  }
  for (const ex of exceptions) {
    const master = masters.find((m) => m.uid === ex.uid);
    if (master) master.relateException(ex);
  }

  const startMs = rangeStart.getTime();
  const endMs = rangeEnd.getTime();
  const out: CalEvent[] = [];

  for (const master of masters) {
    if (master.isRecurring()) {
      const iter = master.iterator();
      let next: ICAL.Time | null;
      let guard = 0;
      while ((next = iter.next()) && guard++ < 1000) {
        if (next.toJSDate().getTime() > endMs) break;
        const det = master.getOccurrenceDetails(next);
        const s = det.startDate.toJSDate();
        const e = det.endDate.toJSDate();
        if (e.getTime() < startMs) continue;
        out.push(makeEvent(det.item, s, e));
      }
    } else {
      const s = master.startDate.toJSDate();
      const e = master.endDate.toJSDate();
      if (e.getTime() < startMs || s.getTime() > endMs) continue;
      out.push(makeEvent(master, s, e));
    }
  }

  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  return out;
}

function makeEvent(ev: ICAL.Event, start: Date, end: Date): CalEvent {
  return {
    uid: ev.uid,
    title: ev.summary || '(untitled)',
    description: ev.description || undefined,
    start,
    end,
    allDay: ev.startDate?.isDate === true,
  };
}

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
const EIGHT_WEEKS_MS = 8 * 7 * 24 * 60 * 60 * 1000;

/**
 * The public entry point for the rest of the plugin. `loadCalendar` above is
 * the pure-ish ported parser (window in, events out, throws on failure); this
 * wraps it with the two things a caller on the grid actually needs: a fixed
 * window relative to `now` (spec §2.1 — 2 weeks back, 8 forward, asymmetric
 * because the past is for "did I keep this" and the future is for planning
 * further out than a single week), and a promise that never rejects — a
 * calendar feed is optional, and a flaky network or a bad URL must never stop
 * the week from rendering.
 */
export async function fetchIcsEvents(url: string, now: Date = new Date()): Promise<CalEvent[]> {
  if (!url || !url.trim()) return [];

  const rangeStart = new Date(now.getTime() - TWO_WEEKS_MS);
  const rangeEnd = new Date(now.getTime() + EIGHT_WEEKS_MS);

  try {
    return await loadCalendar(url, rangeStart, rangeEnd);
  } catch (err) {
    console.warn(
      `Weekfit: could not load the calendar feed (${err instanceof Error ? err.message : String(err)})`,
    );
    return [];
  }
}

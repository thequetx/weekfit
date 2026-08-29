import ICAL from 'ical.js';
import type { CalEvent } from './types';

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
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(`calendar ${res.status} — run \`npm run sync\` to download it`);
  }

  const jcal = ICAL.parse(await res.text());
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

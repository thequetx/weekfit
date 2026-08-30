// Relative dates for the due-date menu.
//
// Calendar dates, never instants: a due date is a day someone wrote down, so
// everything here works in the machine's local timezone and formats with
// `getFullYear`/`getMonth`/`getDate` rather than `toISOString`, which would
// shift the answer by a day for anyone east or west of UTC at the wrong hour.
// That is the same reasoning `IntentionsRail`'s `todayIso` already carries.

/** Local-time `YYYY-MM-DD`. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function atMidnight(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function plusDays(d: Date, days: number): Date {
  const out = atMidnight(d);
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * The next given weekday **strictly after** today (1 = Monday … 7 = Sunday,
 * ISO numbering).
 *
 * Strictly after on purpose: "this Friday" chosen *on* a Friday means the
 * coming one, not today. Someone who means today has "Today" one row above,
 * and a menu item that silently resolves to today once a week is the kind of
 * thing you only notice after you have missed a deadline.
 */
export function nextWeekday(from: Date, isoWeekday: number): Date {
  const base = atMidnight(from);
  // getDay(): 0 = Sunday. ISO: 7 = Sunday.
  const current = base.getDay() === 0 ? 7 : base.getDay();
  const ahead = ((isoWeekday - current + 7) % 7) || 7;
  return plusDays(base, ahead);
}

export interface DateChoice {
  label: string;
  date: string;
}

/**
 * What the due-date menu offers, in order. Built from a `now` parameter rather
 * than reading the clock, like everything else in `src/data/`.
 *
 * Kept short deliberately — a menu you have to read is slower than the note.
 * Anything else is one click further on, behind "Pick a date…".
 */
export function dueChoices(now: Date): DateChoice[] {
  const all: DateChoice[] = [
    { label: 'Today', date: isoDate(atMidnight(now)) },
    { label: 'Tomorrow', date: isoDate(plusDays(now, 1)) },
    { label: 'This Friday', date: isoDate(nextWeekday(now, 5)) },
    { label: 'Next Monday', date: isoDate(nextWeekday(now, 1)) },
  ];

  // Named days collide with the relative ones about twice a week — on a
  // Sunday "Tomorrow" and "Next Monday" are the same date, and on a Thursday
  // so are "Tomorrow" and "This Friday". Two menu items that do exactly the
  // same thing is a menu that makes you stop and work out whether they do.
  // Only "Tomorrow" can ever collide (the two named days are different
  // weekdays, and both are strictly after today), so the earlier label always
  // wins and what survives is the more immediate way of saying it.
  const seen = new Set<string>();
  const unique = all.filter((c) => !seen.has(c.date) && seen.add(c.date));

  // Then chronologically, because the written order isn't. From a Saturday,
  // "This Friday" is nearly a week out and "Next Monday" is in two days — a
  // menu read top to bottom has to run in time order or the reader has to
  // decode each label to know which is sooner.
  return unique.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The durations the menu offers, in minutes. They are all multiples of the
 *  planner's own 30-minute grid or its natural halves, so nothing offered
 *  here gets snapped to something else the moment it is placed. */
export const DURATION_CHOICES = [15, 30, 45, 60, 90, 120, 180] as const;

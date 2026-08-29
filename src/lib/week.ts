export const MS_DAY = 86_400_000;

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Midnight on the Monday of the ISO week containing `d` (local time). */
export function startOfISOWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const mondayIndex = (x.getDay() + 6) % 7; // Sun=0 -> 6, Mon=1 -> 0
  x.setDate(x.getDate() - mondayIndex);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function addWeeks(d: Date, n: number): Date {
  return addDays(d, n * 7);
}

/** ISO-8601 week id, e.g. "2026-W36". */
export function isoWeekId(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const ftDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDay + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * MS_DAY));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 0..6 for which column of `weekStart`'s week a date falls in (else <0 or >6). */
export function dayIndex(d: Date, weekStart: Date): number {
  const a = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((b.getTime() - a.getTime()) / MS_DAY);
}

export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function sameDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function fmtClock(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = ((h + 11) % 12) + 1;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

export function fmtHourLabel(h: number): string {
  const hh = h % 24;
  if (hh === 0) return '12am';
  if (hh === 12) return 'noon';
  return hh < 12 ? `${hh}am` : `${hh - 12}pm`;
}

/** "6:30am" from minutes-since-midnight. */
export function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = ((h + 11) % 12) + 1;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

/** "31 Aug – 6 Sep" for the week starting at `weekStart`. */
export function fmtWeekRange(weekStart: Date): string {
  const end = addDays(weekStart, 6);
  const a = `${weekStart.getDate()} ${MONTHS[weekStart.getMonth()]}`;
  const b = `${end.getDate()} ${MONTHS[end.getMonth()]}`;
  return `${a} – ${b}`;
}

export function fmtLongDay(d: Date): string {
  const dow = DAY_NAMES[(d.getDay() + 6) % 7];
  return `${dow} ${d.getDate()} ${MONTHS[d.getMonth()]}`.toUpperCase();
}

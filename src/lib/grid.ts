import { GRID } from '../config';

export const startHour = GRID.startHour;
export const endHour = GRID.endHour;
export const pxPerHour = GRID.pxPerHour;

export const bodyHeight = (endHour - startHour) * pxPerHour;

/** Y offset (px) within a day column for a given minutes-since-midnight value. */
export function yForMinutes(min: number): number {
  return ((min - startHour * 60) / 60) * pxPerHour;
}

/** Inverse of yForMinutes — a click/drop Y (px) → minutes since midnight,
 *  snapped to 30 min and clamped to the visible range. */
export function minutesForY(y: number): number {
  const raw = (y / pxPerHour) * 60 + startHour * 60;
  const snapped = Math.round(raw / 30) * 30;
  return Math.min(Math.max(snapped, startHour * 60), endHour * 60 - 30);
}

/** Hour numbers shown as grid lines / gutter labels. */
export const gridHours = Array.from(
  { length: endHour - startHour },
  (_, i) => startHour + i,
);

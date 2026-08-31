// Turning a read-only calendar event into a task line — "drag an ICS event
// onto the rail". Kept as its own small, pure file rather
// than folded into `writer.ts`: that file's own header is explicit that it is
// "the only module in this plugin that writes to the vault", and this file
// never touches the vault at all — it only builds the *text* of a line.
// Landing that line is `appendUnderHeading` (writer.ts), the same write path
// `CaptureModal`/`buildCaptureLine` already use for a hand-typed capture —
// this is the calendar-event-shaped sibling of that, not a second writer.

import { dayPlannerRange } from '../lib/source';
import { minutesOfDay, sameDate } from '../lib/week';
import type { CalEvent } from '../lib/types';

/**
 * `ev`'s clock range for a capture line — same-day end -> its real end time;
 * an event that runs past midnight -> the bottom of the day it starts on.
 * Deliberately mirrors `eventMinutes` in `components/EventBlock.tsx` (the
 * formula the block itself is drawn with) rather than importing it: this is
 * `src/data/`, and reaching into `src/components/` from here would be the
 * layering backwards for one shared formula.
 */
function clockRange(ev: CalEvent): { startMin: number; endMin: number } {
  const startMin = minutesOfDay(ev.start);
  const endMin = sameDate(ev.start, ev.end) ? minutesOfDay(ev.end) : 24 * 60;
  return { startMin, endMin };
}

/**
 * `- [ ] HH:MM - HH:MM <title> [ics-uid:: <uid>]` — the exact shape
 * `findIcsLinks` (parse.ts) already knows how to find again, and
 * `icsLinkTitle` (writer.ts) already knows how to strip back down to a plain
 * title.
 *
 * Deliberately carries **no** `⏳`/`[scheduled::]` date. This is a drop onto
 * the *rail* (the week's unscheduled pool), not onto the grid, so it should
 * land unscheduled — and it does: `scheduledEvents` (parse.ts) can't resolve
 * a day for a Day Planner range with no note-date and no `⏳`, so the line
 * never becomes a block, and `isRailTask` (data/sessions.ts) — which asks
 * "did this line actually make it onto the grid", not "does the text happen
 * to carry a time range" — is explicit that exactly this state is what
 * "still unscheduled" means. Placing it for real (giving it a day, so it
 * becomes a block) is left to the normal placement flow: drag it from the
 * rail onto the grid by hand, or run "Fit this week" — not this function.
 */
export function icsCaptureLine(ev: CalEvent): string {
  const { startMin, endMin } = clockRange(ev);
  const range = dayPlannerRange(startMin, endMin);
  return `- [ ] ${range} ${ev.title} [ics-uid:: ${ev.uid}]`;
}

/**
 * Same pattern as `ICS_UID_RE` in `data/parse.ts`'s (unexported)
 * `findIcsLinks` — reproduced here rather than imported, the same call
 * `writer.ts`'s own `ICS_UID_STRIP_RE` already makes for the identical
 * reason: that regex belongs to a file this wave doesn't touch, and this is
 * one more reader of the same marker, not a second definition of it.
 */
const ICS_UID_RE = /[[(]\s*ics-uid\s*::\s*([^\])]+?)\s*[\])]/i;

/**
 * The `uid` a `[ics-uid::]` marker on a task line points at, or `null` if the
 * line carries none. Used by `WeekViewRoot` to work out which `icsEvents`
 * have *already* been captured as a task (spec §2.4, point 3: "that event
 * stops being drawn as an ICS block on the grid"). The feed itself has no
 * idea a task now exists for one of its events — a fresh fetch keeps
 * returning it unchanged — so it's this marker, already sitting on a real
 * task line in the snapshot the view already has, that says "don't draw this
 * one as read-only any more".
 */
export function icsUidOf(text: string): string | null {
  const m = ICS_UID_RE.exec(text);
  return m ? m[1].trim() : null;
}

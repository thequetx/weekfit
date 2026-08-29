import { yForMinutes } from '../lib/grid';
import { minutesOfDay } from '../lib/week';

export interface NowLineProps {
  now: Date;
}

/**
 * A line at the current time, on whichever day column it belongs to.
 *
 * week-dashboard's original (14 lines) owned its own `setInterval` and read
 * `new Date()` directly — a global reach the porting rules ask to strip.
 * `WeekViewRoot` already receives a `now: Date` prop and is the one place
 * that decides *whether* a now-line belongs on this week at all (Phase 1B
 * §2); handing that same value down here as a prop keeps this component a
 * pure function of it, which is also what makes "does the line show up in
 * the right place for a given `now`" a deterministic thing to assert in a
 * test rather than a race against a real clock.
 */
export function NowLine({ now }: NowLineProps) {
  return <div className="weekfit-nowline" style={{ top: yForMinutes(minutesOfDay(now)) }} />;
}

import { fmtHours } from '../lib/duration';
import type { Capacity } from '../data/contract';

export interface CapacityLineProps {
  capacity: Capacity;
}

/**
 * The one line whose whole job is making over-commitment visible.
 *
 * `6.5h committed / 14h free` when there's room; the over-committed styling
 * (`--color-red`, same convention as the now-line and the overdue marker)
 * kicks in only once `overBy > 0` — this is the thing no competitor has, so it
 * has to actually read as alarming when it fires and quiet otherwise.
 *
 * `freeMin === null` means no availability window is configured at all, which
 * is a different statement from "zero free hours": rendering `0h free` next
 * to any committed time would paint every unconfigured week crimson for no
 * reason. Said out loud instead, pointing at settings.
 */
export function CapacityLine({ capacity }: CapacityLineProps) {
  const committed = fmtHours(capacity.committedMin);

  if (capacity.freeMin === null) {
    return (
      <p className="weekfit-capacity">
        <span className="weekfit-capacity__figures">{committed} committed</span>
        <span className="weekfit-capacity__nowindows">
          {' '}
          — no availability windows set. Add one in settings to see how much you can fit.
        </span>
      </p>
    );
  }

  const free = fmtHours(capacity.freeMin);
  const over = capacity.overBy > 0;

  return (
    <p className={`weekfit-capacity${over ? ' weekfit-capacity--over' : ''}`}>
      <span className="weekfit-capacity__figures">
        {committed} committed / {free} free
      </span>
      {over && <span className="weekfit-capacity__overby"> — {fmtHours(capacity.overBy)} over</span>}
    </p>
  );
}

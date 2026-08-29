import { fmtEstimate } from '../lib/duration';
import type { Unplaced, UnplacedReason } from '../lib/gaps';

export interface UnplacedListProps {
  unplaced: Unplaced[];
}

/** The two reasons want different responses from Tyler, so they're worded
 *  differently rather than both collapsing to "didn't fit". */
const REASON_TEXT: Record<UnplacedReason, string> = {
  'no-gap': 'no gap anywhere this week was big enough — try widening a window in settings',
  'too-many-sessions': 'would take more than four sittings to fit — try breaking it into smaller tasks',
};

/**
 * "Fit this week" doesn't only place tasks; it also fails to place some, and
 * that half of the answer is the useful half — swallowing it would look like
 * success. Rendered whenever `fit.unplaced` is non-empty.
 */
export function UnplacedList({ unplaced }: UnplacedListProps) {
  if (unplaced.length === 0) return null;

  return (
    <div className="weekfit-unplaced" role="status">
      <h3 className="weekfit-unplaced__heading">Didn&rsquo;t fit</h3>
      <ul className="weekfit-unplaced__list">
        {unplaced.map((u) => (
          <li key={u.key} className="weekfit-unplaced__item">
            <span className="weekfit-unplaced__title">{u.title}</span>
            <span className="weekfit-unplaced__minutes">({fmtEstimate(u.minutes)})</span>
            <span className="weekfit-unplaced__reason">{REASON_TEXT[u.reason]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Spreading a week's work across it, rather than front-loading it.
 *
 * The ported engine's gap preference is, after matching a task's `#tag` to a
 * window, strictly **earliest day, then earliest time**. So every task piles
 * into Monday until Monday is full, then Tuesday. On a week with real capacity
 * that produces a brutal Monday and an empty Friday, which is a plan almost
 * nobody wants.
 *
 * `beatsFor` lives in `src/lib/gaps.ts`, which is a byte-for-byte port and not
 * ours to change. So the balancing happens a level up: place one task at a
 * time, each into the day with the **most** free time remaining, consuming the
 * pool as we go. The engine still does every placement — this only decides
 * which day's gaps it is offered.
 *
 * A task too big for any single day still falls back to the whole pool, where
 * `placeItems` splits it across days exactly as before.
 */
import { gapFits, placeItems } from '../lib/gaps';
import type { Gap, FitResult, PlaceItem, Proposal, Unplaced } from '../lib/gaps';

/** Free minutes left on each day of the pool. */
function capacityByDay(gaps: Gap[]): Map<number, number> {
  const byDay = new Map<number, number>();
  for (const g of gaps) {
    byDay.set(g.day, (byDay.get(g.day) ?? 0) + Math.max(0, g.endMin - g.startMin));
  }
  return byDay;
}

/**
 * The pool with `[startMin, endMin)` on `day` taken out. A placement can only
 * ever sit inside one gap, so at most one is split in two.
 */
function consume(gaps: Gap[], day: number, startMin: number, endMin: number): Gap[] {
  const out: Gap[] = [];
  for (const g of gaps) {
    if (g.day !== day || endMin <= g.startMin || startMin >= g.endMin) {
      out.push(g);
      continue;
    }
    if (startMin > g.startMin) {
      out.push({ ...g, endMin: startMin, minutes: startMin - g.startMin });
    }
    if (endMin < g.endMin) {
      out.push({ ...g, startMin: endMin, minutes: g.endMin - endMin });
    }
  }
  return out;
}

/**
 * Days in the order this task should be offered them: most free time first, so
 * work lands where there is most room rather than wherever comes first in the
 * week. Ties break on the earlier day, which keeps the result deterministic.
 */
function daysByRoom(gaps: Gap[]): number[] {
  return [...capacityByDay(gaps).entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([day]) => day);
}

/**
 * Place `items` one at a time, each into the roomiest day that can hold it.
 *
 * Returns the same `FitResult` shape `placeItems` does, so every caller and
 * every renderer downstream is unchanged.
 */
export function placeSpread(items: PlaceItem[], gaps: Gap[]): FitResult {
  let pool = gaps.map((g) => ({ ...g }));
  const proposals: Proposal[] = [];
  const unplaced: Unplaced[] = [];

  for (const item of items) {
    let landed = false;

    for (const day of daysByRoom(pool)) {
      const dayGaps = pool.filter((g) => g.day === day);
      // `gapFits` is the capacity question: has any gap on this day room for
      // the whole item. (`snapToGap` is the *drag* question — how near a drop
      // point is to a legal start — and measuring from 00:00 puts every gap
      // out of its reach, which silently sent every task to the fallback and
      // undid the whole rebalance.)
      if (!dayGaps.some((g) => gapFits(g, item.minutes))) continue;

      const attempt = placeItems([item], dayGaps);
      if (attempt.proposals.length === 0) continue;

      for (const p of attempt.proposals) {
        proposals.push(p);
        pool = consume(pool, p.day, p.startMin, p.endMin);
      }
      landed = true;
      break;
    }

    if (landed) continue;

    // No single day can hold it. Hand the whole remaining pool to the engine,
    // which is where splitting across days lives — the behaviour this function
    // deliberately does not reimplement.
    const fallback = placeItems([item], pool);
    for (const p of fallback.proposals) {
      proposals.push(p);
      pool = consume(pool, p.day, p.startMin, p.endMin);
    }
    unplaced.push(...fallback.unplaced);
  }

  return { proposals, unplaced };
}

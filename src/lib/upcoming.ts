import { addDays, sameDate } from './week';
import type { CalEvent, SkeletonBlock } from './types';

export interface Upcoming {
  when: Date;
  label: string;
  kind: string;
  /**
   * Phase 6 §1 — this block starts within its `lead:` window, so the HUD row
   * escalates: crimson keyline, larger type, a live countdown in place of the
   * static time.
   *
   * **Passive by construction.** No toast, no focus steal, nothing outside the
   * panel already on screen ([[Decisions]] §9). A toast during a stream lands on
   * a captured display, in exactly the block Tyler can't act on — so the flag
   * changes how an existing row looks and nothing else.
   */
  imminent?: boolean;
  /** Minutes until it starts, for the countdown. Only set while imminent. */
  inMin?: number;
}

/** Default `lead:` when a block doesn't set one. 15 minutes is enough warning
 *  to finish a thought and not so much that the row sits red for an hour. */
export const DEFAULT_LEAD_MIN = 15;

/**
 * Merge real events + the next 2 days of skeleton blocks into one upcoming list.
 * A skeleton block is dropped when a real event already covers that slot (same
 * day, start within 90 min) — the skeleton is background structure, not a
 * duplicate line item.
 */
export function buildUpcoming(
  events: CalEvent[],
  skeleton: SkeletonBlock[],
  now: Date,
  limit = 6,
): Upcoming[] {
  const items: Upcoming[] = events
    .filter((e) => e.end >= now)
    .map((e) => ({ when: e.start, label: e.title, kind: 'calendar' }));

  const NEAR_MS = 90 * 60 * 1000;

  for (let d = 0; d < 2; d++) {
    const day = addDays(now, d);
    const col = (day.getDay() + 6) % 7;
    for (const b of skeleton) {
      if (!b.days.includes(col)) continue;
      const when = new Date(day);
      when.setHours(Math.floor(b.startMin / 60), b.startMin % 60, 0, 0);
      if (when < now) continue;

      const covered = items.some(
        (it) =>
          it.kind === 'calendar' &&
          sameDate(it.when, when) &&
          Math.abs(it.when.getTime() - when.getTime()) <= NEAR_MS,
      );
      if (!covered) {
        // Phase 6 §1 — `lead: 0` disables escalation for a block entirely, which
        // is why this reads the field rather than defaulting a missing zero.
        const lead = b.leadMin == null ? DEFAULT_LEAD_MIN : b.leadMin;
        items.push({ when, label: b.name, kind: b.kind, ...leadState(when, now, lead) });
      }
    }
  }

  return items.sort((a, b) => a.when.getTime() - b.when.getTime()).slice(0, limit);
}

/**
 * Whether a block is inside its lead window, and how long is left.
 *
 * Epoch milliseconds, never wall-clock fields — the same rule the rest of this
 * codebase follows for "has this time arrived", so an escalation doesn't fire an
 * hour early or late on a DST Sunday.
 *
 * Escalation **clears at the block's start time**: there is no dismissal and no
 * state to manage, because a countdown that has reached zero has said everything
 * it has to say.
 */
export function leadState(
  when: Date,
  now: Date,
  leadMin: number,
): { imminent?: boolean; inMin?: number } {
  if (!leadMin || leadMin <= 0) return {};
  const ms = when.getTime() - now.getTime();
  // `<= 0`, not `< 0`: the escalation clears *at* the start time. A row reading
  // "in 0m" is a countdown that has already said everything it has to say.
  if (ms <= 0 || ms > leadMin * 60_000) return {};
  return { imminent: true, inMin: Math.max(1, Math.ceil(ms / 60_000)) };
}

/** Placeholder rows for verifying HUD / layout resize (`?rows=N`, Ctrl+Alt+Shift+H). */
export function syntheticUpcoming(n: number, from: Date): Upcoming[] {
  const kinds = ['calendar', 'stream', 'gym', 'meal-prep'];
  return Array.from({ length: n }, (_, i) => ({
    when: new Date(from.getTime() + (i + 1) * 45 * 60 * 1000),
    label: `Sample item ${i + 1}`,
    kind: kinds[i % kinds.length],
  }));
}


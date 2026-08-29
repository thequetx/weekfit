// Week health at a glance — Phase 6 §3.
//
// The ambient view lists what's *next*. It never says how the week is *going*,
// which is the one thing a week dashboard should answer in a two-second glance.
//
// Every number here is already computed elsewhere (`lib/audit.ts`,
// `lib/streaks.ts`, the vault read); this only picks the four worth a glance and
// words them. Rendered as one line of large type, not a grid of tiles — the
// ambient layer's whole argument is restraint borrowed from the smart-mirror
// family, and a dashboard of KPIs on your wallpaper is the thing it is
// deliberately not.

import { fmtHours } from './duration';
import type { WeekAudit } from './audit';
import type { Streak } from './streaks';
import type { VaultTask } from './types';

export interface WeekHealth {
  intentionsDone: number;
  intentionsTotal: number;
  keptMin: number;
  plannedMin: number;
  streaksKept: number;
  streaksTotal: number;
  unplanned: number;
}

export function weekHealth(
  intentions: VaultTask[],
  tasks: VaultTask[],
  streaks: Streak[],
  audit: WeekAudit | null,
): WeekHealth {
  return {
    intentionsDone: intentions.filter((t) => t.done).length,
    intentionsTotal: intentions.length,
    keptMin: audit?.rows.reduce((n, r) => n + r.keptMin, 0) ?? 0,
    plannedMin: audit?.rows.reduce((n, r) => n + r.plannedMin, 0) ?? 0,
    streaksKept: streaks.reduce((n, s) => n + s.done, 0),
    streaksTotal: streaks.reduce((n, s) => n + s.target, 0),
    unplanned: tasks.filter((t) => !t.done).length,
  };
}

/**
 * The health line: `3/5 intentions · 9h of 12h kept · 7/9 blocks · 4 unplanned`.
 *
 * Segments with nothing to say are dropped rather than shown as zeros — a week
 * with no intentions set shouldn't have `0/0` glowing at it from the wall.
 */
export function healthLine(h: WeekHealth): string {
  const parts: string[] = [];
  if (h.intentionsTotal > 0) {
    parts.push(`${h.intentionsDone}/${h.intentionsTotal} intentions`);
  }
  if (h.plannedMin > 0) {
    parts.push(`${fmtHours(h.keptMin)} of ${fmtHours(h.plannedMin)} kept`);
  }
  if (h.streaksTotal > 0) parts.push(`${h.streaksKept}/${h.streaksTotal} blocks`);
  if (h.unplanned > 0) parts.push(`${h.unplanned} unplanned`);
  return parts.join('  ·  ');
}

/**
 * Sunday evening, the ambient view stops reporting and asks instead — which is
 * the moment the weekly ritual either happens or it doesn't.
 *
 * Sunday is day 0 of the ISO week's *end*, so `getDay() === 0`; "evening"
 * starts at 17:00, late enough that the day is essentially spent and early
 * enough to still act on it. Both are read from local wall-clock fields on
 * purpose: this is a question about which evening it is, not about an instant.
 */
export const REVIEW_HOUR = 17;

export function isReviewTime(now: Date): boolean {
  return now.getDay() === 0 && now.getHours() >= REVIEW_HOUR;
}

/**
 * `W36 ends today · 3/5 intentions · Ctrl+Alt+W to review`
 *
 * It names the hotkey rather than asking "review?" and leaving you to work out
 * how. The ambient overlay is click-through *and* hides on any input, so the
 * question used to vanish the instant you reached for the mouse to answer it
 * (bug #24) — a prompt with no path to the thing it prompts. The hotkey is the
 * path, so the prompt says it.
 */
export function reviewPrompt(weekId: string, h: WeekHealth): string {
  const shortId = weekId.replace(/^\d{4}-/, '');
  const intent =
    h.intentionsTotal > 0 ? `${h.intentionsDone}/${h.intentionsTotal} intentions` : null;
  return [`${shortId} ends today`, intent, 'Ctrl+Alt+W to review'].filter(Boolean).join('  ·  ');
}

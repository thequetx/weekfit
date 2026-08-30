// Editing the three fields the plugin has always read and never written:
// due date, priority, and our own `~90m` duration.
//
// Until now Weekfit wrote exactly two things to a task line — the Day Planner
// range, and the `✅` completion stamp. Both live behind the same discipline
// and this file joins them: clear the old value in *both* flavours, trim, then
// append the new one in the flavour the line is already written in.
//
// It is deliberately here and not in `src/lib/taskmeta.ts`, which is a
// byte-for-byte vendored port and not ours to change. Everything it needs from
// there is already exported.

import {
  MAX_ESTIMATE_MINUTES,
  MIN_ESTIMATE_MINUTES,
  PRIORITY_EMOJI,
  parseTaskMeta,
  type MetaFlavour,
  type PriorityName,
} from '../lib/taskmeta';
import { splitTaskPrefix } from './dayplanner';

/**
 * Which spelling to write a new field in.
 *
 * `parseTaskMeta` already decides this and documents the rule: inline only
 * when the line is mostly inline, and anything else — including a line with no
 * metadata at all — is emoji. Reusing it rather than inventing a second answer
 * is the point; a line must not come back in a different dialect than it went
 * in, and `withCompletion` resolves it exactly this way.
 */
function flavourOf(body: string): MetaFlavour {
  return parseTaskMeta(body).flavour === 'inline' ? 'inline' : 'emoji';
}

/**
 * Tidy up after a clear. Mirrors `clearCompletion`'s own trailing steps.
 *
 * Only ever run against a task line's **body**: collapsing runs of whitespace
 * across a whole line eats its leading indentation, and an indented line is
 * exactly what splitting writes for each sitting of a task. Every exported
 * function below splits the prefix off first so a caller cannot get this
 * wrong — the one place that discipline was left to the caller is the bug
 * `writer.ts` carries a comment about.
 */
function tidy(body: string): string {
  return body.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, '');
}

/** Apply a body-level transform to a whole line, indentation intact. */
function onBody(line: string, fn: (body: string) => string): string {
  const { prefix, body } = splitTaskPrefix(String(line ?? ''));
  return prefix + fn(body);
}

function append(body: string, raw: string): string {
  const base = tidy(body).replace(/\s+$/, '');
  return base.length ? `${base} ${raw}` : raw;
}

// ---------------------------------------------------------------------------
// Due date
// ---------------------------------------------------------------------------

/** The same loose either-bracket shape `taskmeta.ts`'s own `inlineRe` builds.
 *  Reproduced rather than imported so `src/lib/` stays untouched. */
const DUE_CLEAR_INLINE = /[[(]\s*due\s*::\s*[^\])]*?\s*[\])]/i;

/** `📅`, `📆` and `🗓` are all read as "due" by the Tasks plugin, so clearing
 *  has to catch all three even though this file only ever writes `📅`. A
 *  trailing variation selector is the same field typed differently. */
const DUE_CLEAR_EMOJI = /[📅📆🗓]️?(?:\s*\d{4}-\d{2}-\d{2})?/u;

export function clearDue(line: string): string {
  return onBody(line, (body) =>
    tidy(body.replace(DUE_CLEAR_INLINE, ' ').replace(DUE_CLEAR_EMOJI, ' ')),
  );
}

/** Set the due date, or clear it with `null`. ISO `YYYY-MM-DD`. */
export function withDue(line: string, date: string | null): string {
  if (date == null) return clearDue(line);
  return onBody(line, (body) => {
    const raw = flavourOf(body) === 'inline' ? `[due:: ${date}]` : `📅 ${date}`;
    return append(tidy(body.replace(DUE_CLEAR_INLINE, ' ').replace(DUE_CLEAR_EMOJI, ' ')), raw);
  });
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

const PRIORITY_CLEAR_INLINE = /[[(]\s*priority\s*::\s*[^\])]*?\s*[\])]/i;
const PRIORITY_CLEAR_EMOJI = /(?:🔺|⏫|🔼|🔽|⏬)️?/u;

export function clearPriority(line: string): string {
  return onBody(line, (body) =>
    tidy(body.replace(PRIORITY_CLEAR_INLINE, ' ').replace(PRIORITY_CLEAR_EMOJI, ' ')),
  );
}

/**
 * Set the priority. `'none'` clears it rather than writing a marker — the
 * standard has no glyph for the middle, and an explicit `[priority:: none]`
 * would sort identically while adding noise to the line.
 */
export function withPriority(line: string, level: PriorityName): string {
  if (level === 'none') return clearPriority(line);
  return onBody(line, (body) => {
    const raw =
      flavourOf(body) === 'inline' ? `[priority:: ${level}]` : PRIORITY_EMOJI[level];
    return append(
      tidy(body.replace(PRIORITY_CLEAR_INLINE, ' ').replace(PRIORITY_CLEAR_EMOJI, ' ')),
      raw,
    );
  });
}

// ---------------------------------------------------------------------------
// Duration — ours, not the standard's
// ---------------------------------------------------------------------------

const EST_CLEAR_INLINE = /[[(]\s*est\s*::\s*[^\])]*?\s*[\])]/i;

/** Mirrors `EST_TILDE_RE` in `taskmeta.ts`, including the trailing guard that
 *  stops `~90mx` counting as an estimate. */
const EST_CLEAR_TILDE =
  /(?<=^|\s)~\d+(?:\.\d+)?\s*(?:m|min|mins|minute|minutes|h|hr|hrs|hour|hours)(?![~\w])/i;

/**
 * The canonical written form. Deliberately **not** `fmtEstimate`, which
 * renders 90 as `1h 30m` — a space the `~` parser stops at, so the line would
 * come back as `~1h` with a stray `30m` in the title. Whole hours read better
 * and round-trip; everything else stays in minutes, which always does.
 */
export function estimateRaw(minutes: number, flavour: 'tilde' | 'inline'): string {
  const m = Math.round(minutes);
  const value = m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`;
  return flavour === 'inline' ? `[est:: ${value}]` : `~${value}`;
}

export function clearEstimate(line: string): string {
  return onBody(line, (body) =>
    tidy(body.replace(EST_CLEAR_INLINE, ' ').replace(EST_CLEAR_TILDE, ' ')),
  );
}

/**
 * Set the duration, or clear it with `null`.
 *
 * A value outside `taskmeta.ts`'s own sanity rails is refused by returning the
 * line untouched — the parser would ignore it anyway, and writing a number the
 * reader discards produces a line that shows one duration and plans another.
 */
export function withEstimate(line: string, minutes: number | null): string {
  if (minutes == null) return clearEstimate(line);
  const m = Math.round(minutes);
  if (!Number.isFinite(m) || m < MIN_ESTIMATE_MINUTES || m > MAX_ESTIMATE_MINUTES) {
    return String(line ?? '');
  }
  return onBody(line, (body) => {
    // The estimate has its own third spelling: `~90m` is this plugin's, and
    // it is what the docs advertise, so a line with no inline metadata gets
    // the tilde rather than `[est:: …]`.
    const inline = parseTaskMeta(body).fields['wd:est']?.flavour === 'inline';
    const raw = estimateRaw(m, inline ? 'inline' : 'tilde');
    return append(tidy(body.replace(EST_CLEAR_INLINE, ' ').replace(EST_CLEAR_TILDE, ' ')), raw);
  });
}

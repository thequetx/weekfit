// The line transform — the one place a proposal turns into an edit to a real
// task line. Pure and heavily tested: a bug here silently mangles a line the
// user cares about, and `src/data/writer.ts` trusts this file completely.
//
// Two things get written, in this order, and nothing else:
//   1. the Day Planner range, at the front of the body (`lib/source.ts`)
//   2. the scheduled date, in whichever flavour the line already uses
//      (mirroring `withCompletion`/`clearCompletion` in `lib/taskmeta.ts` —
//      same "clear then re-stamp" shape, so ticking^Wplacing twice never
//      stacks two dates and un-placing takes the old one away).
//
// Nothing here touches `🆔`, `🔁`, `🏁`, priority, or any other field. A line
// with a trailing `🔁 every week` recurrence keeps it untouched by
// construction: this file never matches on it.

import { DAY_PLANNER_RE, withDayPlannerRange } from '../lib/source';
import { parseTaskMeta } from '../lib/taskmeta';
import type { MetaFlavour } from '../lib/taskmeta';

// ---------------------------------------------------------------------------
// 1. Split the line into its prefix and its body
// ---------------------------------------------------------------------------

/** Leading whitespace + list marker (`-` or `*`) + checkbox + the whitespace
 *  right after it. Deliberately more permissive than `taskmeta.ts`'s own
 *  `CHECKBOX_RE` (which only knows `-`), because a writer has to round-trip
 *  whatever bullet Tyler actually used, not just the one flavour that regex
 *  was written for.
 *
 *  A line that doesn't match at all (no checkbox — malformed input, or a
 *  bare range with nothing else on it) gets an empty prefix and the whole
 *  line as its body, so this never throws. */
const PREFIX_RE = /^(\s*[-*]\s\[[ xX]\])(\s*)/;

interface Split {
  prefix: string;
  body: string;
}

/** Exported so the writer can apply a transform to a task line's *body* and
 *  put the prefix back untouched. `clearCompletion` in the ported
 *  `taskmeta.ts` collapses any run of two or more spaces — including leading
 *  indentation — so ticking an indented sub-task through it would de-indent
 *  the line and quietly break the parent/child structure splitting writes. */
export function splitTaskPrefix(line: string): Split {
  return splitPrefix(line);
}

function splitPrefix(line: string): Split {
  const m = PREFIX_RE.exec(line);
  if (!m) return { prefix: '', body: line };
  const prefix = m[0];
  return { prefix, body: line.slice(prefix.length) };
}

// ---------------------------------------------------------------------------
// 2. The scheduled date field — mirrors withCompletion/clearCompletion
// ---------------------------------------------------------------------------

/** `[[(]scheduled::…[])]`, the same loose either-bracket shape `taskmeta.ts`'s
 *  own (unexported) `inlineRe` builds for every inline field. Reproduced here
 *  rather than imported so `src/lib/` stays untouched and unexported. */
const SCHEDULED_CLEAR_INLINE = /[[(]\s*(?:scheduled)\s*::\s*([^\])]*?)\s*[\])]/i;

/** `⏳ 2026-09-04` or `⌛ 2026-09-04` — the Tasks plugin accepts either glyph
 *  for "scheduled" on read, so clearing has to catch both even though this
 *  file only ever *writes* `⏳`. A trailing variation selector (`⏳️`) is the
 *  same field typed differently and must clear the same way. */
const SCHEDULED_CLEAR_EMOJI = /[⏳⌛]️?(?:\s*\d{4}-\d{2}-\d{2})?/u;

/** Remove any scheduled-date stamp, in either flavour. Placing a task twice
 *  must not stack two dates, and re-placing on a different day has to take
 *  the old one away first. */
function clearScheduled(text: string): string {
  return String(text ?? '')
    .replace(SCHEDULED_CLEAR_INLINE, ' ')
    .replace(SCHEDULED_CLEAR_EMOJI, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/, '');
}

function scheduledRaw(date: string, flavour: MetaFlavour): string {
  return flavour === 'inline' ? `[scheduled:: ${date}]` : `⏳ ${date}`;
}

/** Stamp a scheduled date onto a line's body, in the requested flavour —
 *  mirrors `withCompletion`'s "clear, trim, append" shape exactly. */
function withScheduled(text: string, date: string, flavour: MetaFlavour): string {
  const base = clearScheduled(text).replace(/\s+$/, '');
  return `${base} ${scheduledRaw(date, flavour)}`;
}

// ---------------------------------------------------------------------------
// The transform
// ---------------------------------------------------------------------------

export interface ApplyPlacementOptions {
  /** `HH:MM - HH:MM`, from `dayPlannerRange` in `lib/source.ts` — or `null` to
   *  strip an existing range and leave the body with none, unscheduling the
   *  task and returning it to the rail. */
  range: string | null;
  /** ISO date to stamp as `⏳`/`[scheduled::]`, or `null` to leave the line's
   *  existing scheduled date (if any) exactly as it is — the daily-note case,
   *  where the note's own date already says which day it is, and the
   *  unschedule case, where an existing `⏳` (ours or the user's own) is left
   *  alone: this file only ever *adds* one, never removes one on unschedule. */
  scheduledDate: string | null;
}

/**
 * Apply one placement to one task line: the Day Planner range at the front of
 * the body, and — when given — the scheduled date. Everything else on the
 * line, including the checkbox prefix, survives byte-identically.
 *
 * `range: null` unschedules: the leading range is stripped and nothing takes
 * its place, exactly like `withDayPlannerRange(body, null)`. Pair it with
 * `scheduledDate: null` to also leave any existing `⏳`/`[scheduled::]` alone
 * — this file only ever adds that stamp, never removes one, whether it's ours
 * or the user's own hand-typed date. There is no way to tell the two apart
 * from the line alone, which is exactly why unscheduling never tries.
 *
 * Idempotent: calling this twice with the same `text` and `opts` produces the
 * same result as calling it once, because both the range and the scheduled
 * date are cleared before being re-stamped rather than appended blindly.
 */
export function applyPlacement(text: string, opts: ApplyPlacementOptions): string {
  const raw = String(text ?? '');
  const { prefix, body } = splitPrefix(raw);

  let newBody = withDayPlannerRange(body, opts.range);

  if (opts.scheduledDate != null) {
    // The line's own flavour, from the *whole* line — a malformed or
    // non-`-`-bulleted checkbox doesn't change where the metadata lives.
    // No metadata at all (a plain `- [ ] Book dentist`) defaults to emoji,
    // the plugin's own default.
    const flavour: MetaFlavour = parseTaskMeta(raw).flavour === 'inline' ? 'inline' : 'emoji';
    newBody = withScheduled(newBody, opts.scheduledDate, flavour);
  }

  return prefix + newBody;
}

/**
 * Does this task line already carry a Day Planner time range?
 *
 * **Do not call `DAY_PLANNER_RE.test()` on a `VaultTask.text` directly.** That
 * regex is anchored at `^` and is documented as matching a task line's *body* —
 * but `VaultTask.text` is the whole raw line, checkbox prefix and all
 * (`src/data/parse.ts` stores `lines[i]` verbatim). So the anchored test is
 * always false on real vault data, and a caller that used it would treat every
 * already-scheduled task as unscheduled: the rail would list work that is
 * already placed, and "Fit this week" would propose moving it.
 *
 * That bug shipped in Phase 1 and survived a green test, because the test's
 * fixture passed a bare body rather than a real line. This helper exists so
 * there is exactly one right answer to the question and nowhere to get it
 * wrong — it strips the prefix first, then asks.
 */
export function hasPlacement(text: string): boolean {
  return DAY_PLANNER_RE.test(splitPrefix(String(text ?? '')).body);
}

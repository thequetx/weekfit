// One parser for a task line — Phase 5 §1, "tolerant, read-mostly".
//
// The Obsidian Tasks standard has **two spellings, not two ecosystems**: the
// plugin has written a Dataview inline-field flavour (`[due:: 2026-09-04]`)
// since v3.3.0, selectable in its own settings, alongside the emoji flavour
// (`📅 2026-09-04`). So this file reads both, always, regardless of which one
// the rest of the line uses.
//
// Three rules govern everything here:
//
//   1. **Parse it if it's there; never require it.** A plain `- [ ] Buy milk`
//      comes back with an empty field map and its title untouched. That is the
//      property that made this safe to ship over Tyler's existing notes, and
//      it has its own tests.
//   2. **Read almost everything, write almost nothing.** `✅`/`[completion::]`
//      is the only field the dashboard ever writes (Tier 2). `🔁` recurrence
//      and `🏁` on-completion are read so the app can *stay out of their way* —
//      a recurring task belongs to the Tasks plugin, and if the dashboard also
//      acted on it one task would become two.
//   3. **Match the flavour already on the line.** For a line the dashboard
//      creates from nothing, use emoji — the plugin's default, with complete
//      support where the Dataview flavour's is explicitly "partial".
//
// `wd:est` is the one field here that is *ours* rather than the standard's
// (Phase 4 §1): Obsidian Tasks closed both duration requests "not planned", so
// there was nothing to defer to. It keeps its `wd:` namespace so the next
// reader can see at a glance which half of this file is a standard.
//
// Pure: no DOM, no IPC, no clock. `electron/vault.cjs` carries a mirrored copy
// for the main process (it can't import ESM); test/taskmeta.test.ts asserts the
// two agree, line for line, over the same table.

import { DEPENDS_ON_RE, TASK_ID_RE } from './taskid';

/** Which spelling a field was written in. `tilde` is the estimate's own
 *  emoji-side flavour (`~90m`); it counts as emoji when deciding what to
 *  write back. */
export type MetaFlavour = 'emoji' | 'inline';
export type EstimateFlavour = 'tilde' | 'inline';

/** Sanity rails on a hand-typed estimate. Outside them the value is treated as
 *  a typo and falls through to the next rung down the ladder, rather than
 *  producing a zero-height block (`~0m`) or a year-long one (`~9999h`). */
export const MIN_ESTIMATE_MINUTES = 5;
export const MAX_ESTIMATE_MINUTES = 12 * 60;

/**
 * The key an estimate is filed under. Deliberately namespaced: `wd:` says out
 * loud that this is the Week Dashboard's own field and *not* part of the
 * Obsidian Tasks standard, so a future reader doesn't go hunting for it in the
 * Tasks docs.
 */
export const EST_FIELD = 'wd:est';

export interface EstimateField {
  minutes: number;
  raw: string; // as written, e.g. "~90m" or "[est:: 1.5h]"
  flavour: EstimateFlavour;
}

/** The six date fields of the standard, in the order the plugin lists them. */
export const DATE_FIELDS = [
  'due',
  'scheduled',
  'start',
  'completion',
  'cancelled',
  'created',
] as const;
export type DateFieldName = (typeof DATE_FIELDS)[number];

/** The five written priorities plus the unwritten middle one. `none` is never
 *  a field on the line — it's what a line without a priority *means*. */
export const PRIORITIES = ['highest', 'high', 'medium', 'none', 'low', 'lowest'] as const;
export type PriorityName = (typeof PRIORITIES)[number];

/** Sort order, most urgent first. `none` sits between medium and low, which is
 *  the plugin's own ordering — an unmarked task is not the least urgent one. */
export const PRIORITY_RANK: Record<PriorityName, number> = {
  highest: 0,
  high: 1,
  medium: 2,
  none: 3,
  low: 4,
  lowest: 5,
};

/** The glyph for a priority, for a marker in the rail. `none` has none. */
export const PRIORITY_EMOJI: Record<PriorityName, string> = {
  highest: '🔺',
  high: '⏫',
  medium: '🔼',
  none: '',
  low: '🔽',
  lowest: '⏬',
};

export interface DateField {
  date: string; // YYYY-MM-DD, as written
  flavour: MetaFlavour;
  raw: string;
}

export interface PriorityField {
  level: PriorityName;
  rank: number;
  flavour: MetaFlavour;
  raw: string;
}

/** `🔁 every week when done`. **Read-only.** Nothing in this app writes or
 *  rewrites one; see the header. */
export interface RecurrenceField {
  rule: string;
  flavour: MetaFlavour;
  raw: string;
}

/** `🏁 delete`. Read so it can be stripped from the title, and for no other
 *  reason — the dashboard never acts on it. */
export interface OnCompletionField {
  value: string;
  flavour: MetaFlavour;
  raw: string;
}

export interface TaskMeta {
  /** Display title: the checkbox, every parsed field and every id stripped
   *  out. A malformed field is left in place, so the typo stays visible. */
  title: string;
  dates: Partial<Record<DateFieldName, DateField>>;
  priority?: PriorityField;
  recurrence?: RecurrenceField;
  onCompletion?: OnCompletionField;
  /** Obsidian Tasks' own `🆔` / `⛔` (Phase 4 §3). */
  id: string | null;
  dependsOn: string[];
  /** Namespaced extensions. One key, and it is ours: `wd:est`. */
  fields: { 'wd:est'?: EstimateField };
  /** The flavour the line is written in, or null when it carries no metadata
   *  at all. What `withCompletion` matches. */
  flavour: MetaFlavour | null;
  /** False for a line with nothing on it but words — the safe-to-ship case. */
  hasMeta: boolean;
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

/** Every emoji signifier, as a class body. Used to bound the one field whose
 *  value is free text (`🔁 every week`) so it stops at the next field instead
 *  of swallowing the rest of the line. */
const SIGNIFIERS = '📅📆🗓⏳⌛🛫✅❌➕🔺⏫🔼🔽⏬🆔⛔🏁🔁';

/** Emoji are often typed with a trailing variation selector; `📅️` and
 *  `📅` are the same field. */
const VS = '\\uFE0F?';

/** Alternates the plugin itself accepts for two of the dates. */
const DATE_EMOJI: Record<DateFieldName, string> = {
  due: '📅📆🗓',
  scheduled: '⏳⌛',
  start: '🛫',
  completion: '✅',
  cancelled: '❌',
  created: '➕',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function emojiDateRe(glyphs: string): RegExp {
  return new RegExp(`[${glyphs}]${VS}\\s*(\\d{4}-\\d{2}-\\d{2})`, 'u');
}

/** `[due:: 2026-09-04]`, and Dataview's parenthesised `(due:: …)` flavour. */
function inlineRe(name: string): RegExp {
  return new RegExp(`[[(]\\s*(?:${name})\\s*::\\s*([^\\])]*?)\\s*[\\])]`, 'i');
}

const DATE_RE = Object.fromEntries(
  DATE_FIELDS.map((f) => [f, { emoji: emojiDateRe(DATE_EMOJI[f]), inline: inlineRe(f) }]),
) as Record<DateFieldName, { emoji: RegExp; inline: RegExp }>;

const PRIORITY_EMOJI_RE = /(🔺|⏫|🔼|🔽|⏬)️?/u;
const PRIORITY_BY_GLYPH: Record<string, PriorityName> = {
  '🔺': 'highest',
  '⏫': 'high',
  '🔼': 'medium',
  '🔽': 'low',
  '⏬': 'lowest',
};
const PRIORITY_INLINE_RE = inlineRe('priority');

/** The rule runs to the next signifier, an inline field or a tag — never to
 *  the end of the line, or `🔁 every week #home` would lose the tag. */
const RECURRENCE_EMOJI_RE = new RegExp(`🔁${VS}\\s*([^${SIGNIFIERS}\\[(#]*)`, 'u');
const RECURRENCE_INLINE_RE = inlineRe('repeat|recurrence');

const ON_COMPLETION_EMOJI_RE = new RegExp(`🏁${VS}\\s*(keep|delete|ignore)?`, 'iu');
const ON_COMPLETION_INLINE_RE = inlineRe('onCompletion');

/** `wd:est` rung B: `~90m`, `~1.5h`, `~45 mins`.
 *  The lookbehind keeps `~~strikethrough~~` out — a doubled tilde is markdown,
 *  a lone one isn't — and the lookahead stops `~90m~~` from being half-eaten. */
const EST_TILDE_RE =
  /(?<=^|\s)~(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)(?![~\w])/i;
/** `wd:est` rung C: `[est:: 90m]`. */
const EST_INLINE_RE = inlineRe('est');

/** A bare duration value, as written in the yaml or inside an inline field. */
const VALUE_RE = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/i;

/** The checklist prefix, when a whole raw line is handed in rather than the
 *  text of one. Mirrors `CHECK_RE` in electron/vault.cjs. */
const CHECKBOX_RE = /^\s*-\s\[[ xX]\]\s+/;

/** `✅ 2026-09-04`, `✅` — the write side has to clear a bare one too. */
const COMPLETION_CLEAR_EMOJI = /✅️?(?:\s*\d{4}-\d{2}-\d{2})?/u;
const COMPLETION_CLEAR_INLINE = inlineRe('completion');

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function normaliseMinutes(minutes: number): number | null {
  if (!Number.isFinite(minutes)) return null;
  const rounded = Math.round(minutes);
  if (rounded < MIN_ESTIMATE_MINUTES || rounded > MAX_ESTIMATE_MINUTES) return null;
  return rounded;
}

/**
 * `"90m"` / `"1.5h"` / `"45"` / `90` → minutes, or null if it isn't a duration
 * this app will act on. A bare number means minutes (yaml writes `90`, not
 * `"90m"`, if the quotes are left off).
 */
export function parseDurationValue(raw: unknown): number | null {
  if (typeof raw === 'number') return normaliseMinutes(raw);
  const m = String(raw ?? '').trim().match(VALUE_RE);
  if (!m) return null;
  const n = Number(m[1]);
  const hours = (m[2] ?? 'm').toLowerCase().startsWith('h');
  return normaliseMinutes(hours ? n * 60 : n);
}

interface Cut {
  start: number;
  end: number;
}

function cutOf(m: RegExpMatchArray | null): Cut | null {
  return m && m.index !== undefined ? { start: m.index, end: m.index + m[0].length } : null;
}

/** Remove every parsed field from the line in one pass and tidy the seams.
 *  One pass rather than a chain of `.replace()`s so the match offsets stay
 *  valid — the old code excised as it went and each cut moved the next one. */
function applyCuts(text: string, cuts: Cut[]): string {
  if (!cuts.length) return text.trim();
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const c of sorted) {
    if (c.start < at) continue; // already inside a cut we took
    out += text.slice(at, c.start);
    at = c.end;
  }
  out += text.slice(at);
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Read every field off a task line, in both flavours, and hand back the title
 * with all of them removed.
 *
 * Accepts either a raw `- [ ] …` line or just its text; the checkbox is
 * stripped either way, so the main process (which has raw lines) and the
 * renderer (which has `VaultTask.text`) get identical answers.
 */
export function parseTaskMeta(text: string): TaskMeta {
  const src = String(text ?? '').replace(CHECKBOX_RE, '');
  const cuts: Cut[] = [];
  let emojiHits = 0;
  let inlineHits = 0;

  const keep = (m: RegExpMatchArray, flavour: MetaFlavour) => {
    const c = cutOf(m);
    if (c) cuts.push(c);
    if (flavour === 'emoji') emojiHits++;
    else inlineHits++;
  };

  // --- the six dates ------------------------------------------------------
  const dates: Partial<Record<DateFieldName, DateField>> = {};
  for (const name of DATE_FIELDS) {
    const em = src.match(DATE_RE[name].emoji);
    if (em) {
      dates[name] = { date: em[1], flavour: 'emoji', raw: em[0] };
      keep(em, 'emoji');
    }
    const im = src.match(DATE_RE[name].inline);
    // A malformed value (`[due:: soon]`) is left in the title on purpose, the
    // same way a malformed estimate is: the typo stays where Tyler can see it.
    if (im && ISO_DATE.test(im[1].trim())) {
      if (!dates[name]) dates[name] = { date: im[1].trim(), flavour: 'inline', raw: im[0] };
      keep(im, 'inline');
    }
  }

  // --- priority -----------------------------------------------------------
  let priority: PriorityField | undefined;
  const pe = src.match(PRIORITY_EMOJI_RE);
  if (pe) {
    const level = PRIORITY_BY_GLYPH[pe[1]];
    priority = { level, rank: PRIORITY_RANK[level], flavour: 'emoji', raw: pe[0] };
    keep(pe, 'emoji');
  }
  const pi = src.match(PRIORITY_INLINE_RE);
  if (pi) {
    const word = pi[1].trim().toLowerCase();
    const level = (word === 'normal' ? 'none' : word) as PriorityName;
    if ((PRIORITIES as readonly string[]).includes(level)) {
      if (!priority) {
        priority = { level, rank: PRIORITY_RANK[level], flavour: 'inline', raw: pi[0] };
      }
      keep(pi, 'inline');
    }
  }

  // --- recurrence and on-completion: read, strip, never act ---------------
  let recurrence: RecurrenceField | undefined;
  const re_ = src.match(RECURRENCE_EMOJI_RE);
  if (re_) {
    recurrence = { rule: re_[1].trim(), flavour: 'emoji', raw: re_[0].trimEnd() };
    keep(re_, 'emoji');
  }
  const ri = src.match(RECURRENCE_INLINE_RE);
  if (ri) {
    if (!recurrence) recurrence = { rule: ri[1].trim(), flavour: 'inline', raw: ri[0] };
    keep(ri, 'inline');
  }

  let onCompletion: OnCompletionField | undefined;
  const oe = src.match(ON_COMPLETION_EMOJI_RE);
  if (oe) {
    onCompletion = { value: (oe[1] ?? '').toLowerCase(), flavour: 'emoji', raw: oe[0].trimEnd() };
    keep(oe, 'emoji');
  }
  const oi = src.match(ON_COMPLETION_INLINE_RE);
  if (oi) {
    if (!onCompletion) {
      onCompletion = { value: oi[1].trim().toLowerCase(), flavour: 'inline', raw: oi[0] };
    }
    keep(oi, 'inline');
  }

  // --- id / dependsOn (Phase 4 §3) ----------------------------------------
  let id: string | null = null;
  const idm = src.match(TASK_ID_RE);
  if (idm) {
    id = idm[1];
    keep(idm, 'emoji');
  }
  let dependsOn: string[] = [];
  const dm = src.match(DEPENDS_ON_RE);
  if (dm) {
    dependsOn = (dm[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    keep(dm, 'emoji');
  }

  // --- wd:est, ours (Phase 4 §1) ------------------------------------------
  // The named inline field wins when both are present — it's the more
  // deliberate of the two — but both are stripped either way.
  let est: EstimateField | undefined;
  const ei = src.match(EST_INLINE_RE);
  if (ei) {
    const minutes = parseDurationValue(ei[1]);
    if (minutes != null) {
      est = { minutes, raw: ei[0], flavour: 'inline' };
      keep(ei, 'inline');
    }
  }
  const et = src.match(EST_TILDE_RE);
  if (et) {
    const minutes = parseDurationValue(`${et[1]}${et[2]}`);
    if (minutes != null) {
      if (!est) est = { minutes, raw: et[0], flavour: 'tilde' };
      keep(et, 'emoji');
    }
  }

  // Which spelling to write back in. Inline only when the line is mostly
  // inline; anything else — including a line with no metadata at all — is
  // emoji, the plugin's default.
  const flavour: MetaFlavour | null =
    emojiHits === 0 && inlineHits === 0 ? null : inlineHits > emojiHits ? 'inline' : 'emoji';

  return {
    title: applyCuts(src, cuts),
    dates,
    priority,
    recurrence,
    onCompletion,
    id,
    dependsOn,
    fields: est ? { [EST_FIELD]: est } : {},
    flavour,
    hasMeta: cuts.length > 0,
  };
}

/** The display title alone — the rail, the ghost block and the Google event
 *  summary all want exactly this string. */
export function taskTitle(text: string): string {
  return parseTaskMeta(text).title;
}

/**
 * Does this line belong to the Tasks plugin's recurrence machinery?
 *
 * The one question `rollWeek` asks. A recurring line is **not** rolled: moving
 * it both duplicates it (the plugin regenerates the next instance itself) and
 * fights whatever `🏁` says should happen next.
 */
export function isRecurring(text: string): boolean {
  return Boolean(parseTaskMeta(text).recurrence);
}

// ---------------------------------------------------------------------------
// The write side — Tier 2, and deliberately all of it
// ---------------------------------------------------------------------------

/** `✅ 2026-09-04` or `[completion:: 2026-09-04]`. */
export function completionRaw(date: string, flavour: MetaFlavour): string {
  return flavour === 'inline' ? `[completion:: ${date}]` : `✅ ${date}`;
}

/** Remove any completion stamp, in either flavour. Ticking twice must not
 *  stack two dates, and unticking has to take the old one away. */
export function clearCompletion(text: string): string {
  return String(text ?? '')
    .replace(COMPLETION_CLEAR_INLINE, ' ')
    .replace(COMPLETION_CLEAR_EMOJI, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/, '');
}

/**
 * Stamp a completion date on a line, in the line's own flavour — the *only*
 * field this app writes. `🔁` and `🏁` are untouched by construction: nothing
 * here goes near them.
 */
export function withCompletion(text: string, date: string): string {
  const flavour = parseTaskMeta(text).flavour === 'inline' ? 'inline' : 'emoji';
  const base = clearCompletion(text).replace(/\s+$/, '');
  return `${base} ${completionRaw(date, flavour)}`;
}

// ---------------------------------------------------------------------------
// Sorting — Phase 5 §1's "priority, then due date"
// ---------------------------------------------------------------------------

/** An unwritten priority is `none`, which is a real rank, not a missing one. */
export function priorityRank(meta: TaskMeta): number {
  return meta.priority ? meta.priority.rank : PRIORITY_RANK.none;
}

/**
 * Rail order: most urgent priority first, then soonest due date, then whatever
 * order the caller already had. Undated tasks come after dated ones at the same
 * priority — a date is a commitment and an absent one isn't "the year 3000".
 *
 * Returns 0 for a genuine tie, so a stable sort keeps file order underneath.
 */
export function compareMeta(a: TaskMeta, b: TaskMeta): number {
  const pr = priorityRank(a) - priorityRank(b);
  if (pr !== 0) return pr;
  const ad = a.dates.due?.date ?? null;
  const bd = b.dates.due?.date ?? null;
  if (ad && bd) return ad < bd ? -1 : ad > bd ? 1 : 0;
  if (ad) return -1;
  if (bd) return 1;
  return 0;
}

/** Past its due date. Crimson in the rail — the one thing there allowed to be,
 *  because crimson already means "now" on the grid's now-line. */
export function isOverdue(meta: TaskMeta, todayIso: string): boolean {
  const due = meta.dates.due;
  return Boolean(due && due.date < todayIso);
}

/** `2026-09-04` → `4 Sep`. The rail has ~40px for this. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDue(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return date;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
}

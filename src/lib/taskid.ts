// Task identity — Phase 4 §3, "sessions share a task id".
//
// A task split across several sittings needs one id the sessions can agree on.
// Unlike a *duration* (Phase 4 §1, where Obsidian Tasks closed both requests
// "not planned" and left nothing to defer to), an id **is** part of the Tasks
// standard: `🆔 dg1st4` names a task and `⛔ dg1st4` says another task depends
// on it. So this file defers rather than inventing:
//
//   - the shared id is the task's own `🆔`, written on the task line, visible
//     in the markdown, and reusable by anything else that reads the vault;
//   - the calendar side carries the same string in
//     `extendedProperties.private.wdTaskId`, because a Google event has nowhere
//     standard to put it. That is the one bespoke half, and it is bespoke only
//     because Google has no `🆔`.
//
// `⛔` (dependsOn) is *read* here — enough to keep it out of a block title, and
// enough for `dependsOn` to be available to Phase 5's fuller parser — but it is
// deliberately **not** used to link sessions. Sessions of one task are not
// separate tasks that block each other; bending `⛔` into "same job, later
// sitting" would mean writing something into the vault that every other Tasks
// reader would interpret wrongly. One `🆔`, N calendar blocks.
//
// Pure: no DOM, no IPC, no clock.

// Phase 5 §1 note: `lib/taskmeta.ts` is now the one parser for a whole task
// line, and it reads `🆔`/`⛔` through the two regexes below rather than running
// `stripTaskIdFields` as a second pass over an already-stripped title. The
// helpers here stay because they are the id's own vocabulary — `newTaskId` and
// `withTaskId` are what `ensureTaskId` is built on — but nothing should strip a
// display title twice; call `parseTaskMeta` (or `taskTitle`) instead.

/** The Obsidian Tasks id alphabet — letters, digits, `-` and `_`. */
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Length of a generated id. Six is what the Tasks plugin's own "generate
 *  unique id" command produces, so a hand-written one and ours look alike. */
export const TASK_ID_LENGTH = 6;

/** `🆔 dg1st4` — the Tasks standard's id field. */
export const TASK_ID_RE = /🆔\s*([A-Za-z0-9_-]+)/;

/** `⛔ dg1st4,abc123` — the Tasks standard's dependsOn field (comma separated).
 *  Ids are joined by commas, never by bare spaces: a looser class would let
 *  `⛔ abc123 Edit the video` swallow the rest of the title. */
export const DEPENDS_ON_RE = /⛔\s*([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)?/;

/**
 * The calendar-side link. A Google event has no `🆔`, so the same string rides
 * in a private extended property — namespaced `wd` for the same reason `wd:est`
 * is (Phase 4 §1): so a future reader can see at a glance which half of this is
 * a standard and which half is ours.
 */
export const TASK_ID_PROP = 'wdTaskId';
/** 1-based index of this block among the task's sessions. */
export const SESSION_PROP = 'wdSession';
/** How many sessions the task was split into. */
export const SESSIONS_PROP = 'wdSessions';

/** The `🆔` written on a task line, or null. */
export function parseTaskId(text: string): string | null {
  const m = String(text ?? '').match(TASK_ID_RE);
  return m ? m[1] : null;
}

/** The ids listed in a task line's `⛔`. Read-only — §3 never writes one. */
export function parseDependsOn(text: string): string[] {
  const m = String(text ?? '').match(DEPENDS_ON_RE);
  if (!m || !m[1]) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Strip `🆔`/`⛔` out of a display title. They're bookkeeping, not the name of
 * the work: a ghost block reading "Edit video A 🆔 dg1st4" would be the id
 * leaking onto the board and, worse, into the Google event's summary.
 */
export function stripTaskIdFields(text: string): string {
  return String(text ?? '')
    .replace(TASK_ID_RE, ' ')
    .replace(DEPENDS_ON_RE, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Add a `🆔 <id>` to a task line that has none. Returns the line unchanged if
 *  one is already there — the existing id always wins, because something else
 *  in the vault may already depend on it. */
export function withTaskId(text: string, id: string): string {
  const line = String(text ?? '');
  if (TASK_ID_RE.test(line)) return line;
  return `${line.replace(/\s+$/, '')} 🆔 ${id}`;
}

/**
 * A fresh id. `rand` is injectable so the tests get a deterministic one — the
 * app passes nothing and gets `Math.random`.
 *
 * Six random characters out of 62 is ~5.7e10 possibilities; a vault with a few
 * hundred ids is nowhere near a birthday problem, and `ensureTaskId` on the
 * vault side never overwrites an id that already exists, so the worst case is a
 * duplicate that a human can see and change.
 */
export function newTaskId(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < TASK_ID_LENGTH; i++) {
    out += ID_CHARS[Math.floor(rand() * ID_CHARS.length) % ID_CHARS.length];
  }
  return out;
}

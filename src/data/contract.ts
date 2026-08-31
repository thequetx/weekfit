/**
 * The seam between the vault adapter and the view.
 *
 * `src/lib/` is ported verbatim from week-dashboard and must stay that way, so
 * everything here is expressed in the shapes `lib/types.ts` already defines.
 * The adapter's whole job is to turn Obsidian's `Vault` + `MetadataCache` into
 * these, and the view's whole job is to render them. Neither imports the other.
 */
import type {
  VaultTask,
  CalEvent,
  SkeletonBlock,
  AvailabilityWindow,
  DurationMap,
} from '../lib/types';

/**
 * One week, as read from the vault. Phase 1 is **read-only** — nothing in the
 * plugin writes until Phase 2, which is what makes this the safe place to get
 * reading right.
 */
export interface WeekSnapshot {
  /** ISO week id, `2026-W36`. */
  weekId: string;
  /** Local midnight on the Monday. Every `day` index in `lib/` is relative to
   *  this — see `dayIndex(d, weekStart)` in `lib/week.ts`. */
  weekStart: Date;
  /** The weekly note backing this week, or null when it doesn't exist yet.
   *  Absence is a normal state, not an error: the view says so and carries on. */
  notePath: string | null;
  /** From `## Intentions` in the weekly note. */
  intentions: VaultTask[];
  /** From `## Tasks` — the week's committed pool. */
  tasks: VaultTask[];
  /** `#thisweek`-tagged checkbox lines swept from the configured folders. */
  thisweek: VaultTask[];
  /**
   * Existing commitments, synthesised from Day Planner `HH:MM - HH:MM` lines
   * already in the vault. This is what replaces Google Calendar as the `events`
   * argument to `computeGaps` and `fitTasks` — so a line the user (or Day
   * Planner, or the desktop app) already wrote blocks a gap correctly, with no
   * change to the engine.
   *
   * `uid` is `${file}:${line}`; `source` is `formatSource(file, line)` from
   * `lib/source.ts`. `allDay` is always false.
   */
  scheduled: CalEvent[];
  /**
   * The raw task lines behind `scheduled`, in the same order — `scheduled[i]`
   * came from `scheduledLines[i]`.
   *
   * A `CalEvent` carries a `source` (`path#Lline`) but not the text of the
   * line it was read from, and the writer refuses to touch a line whose text
   * no longer matches what was read. So re-timing or unscheduling a block on
   * the grid is only possible if the snapshot kept the line — without this,
   * every such edit would be refused as `line-changed`.
   */
  scheduledLines: VaultTask[];
  /**
   * Every ICS event fetched for this week, whether or not it also went into
   * `scheduled`. It always goes into `scheduled` when
   * `icsEventsBusy` is on — that's what makes it reserve a gap. It is *always*
   * carried here regardless of the toggle, because the grid still needs to
   * draw it (as a non-reserving event) when busy is off, and because a
   * consumer wanting "every calendar event this week" for its own reasons
   * shouldn't have to reach into `scheduled` and guess which entries came from
   * the feed. `[]` when there's no feed configured, the feed failed, or the
   * week's frontmatter `status` is `reviewed` (no ICS merge for a closed week).
   */
  icsEvents: CalEvent[];
  /** Non-fatal read problems — a malformed date, an unreadable file. Surfaced
   *  once in the view rather than thrown, because a bad line in one note must
   *  never stop the week from rendering. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// ICS delta tracking (data layer only; no UI here)
// ---------------------------------------------------------------------------

/** One tracked event as of the last successful refresh. Persisted in the
 *  plugin's own data.json (NOT a vault file — see `WeekfitSettings.icsState`
 *  above). */
export interface IcsEventSnapshot {
  title: string;
  timeStart: string; // ISO 8601
  timeEnd: string; // ISO 8601
  hash: string;
}

/** Keyed by the `[ics-uid:: …]` value carried on the task line. */
export type IcsState = Record<string, IcsEventSnapshot>;

export interface IcsDelta {
  unchanged: string[]; // uids
  updated: Array<{
    uid: string;
    title: string; // the title on the task line's snapshot (for display)
    newTitle: string;
    oldStart: string;
    oldEnd: string;
    newStart: string;
    newEnd: string;
  }>;
  removed: Array<{ uid: string; title: string }>;
}

/** One `[ics-uid:: …]` (or `(ics-uid:: …)`) marker found on a checkbox line —
 *  the vault-side half of the link between a task and a tracked calendar
 *  event. `text` is the whole raw line, same convention as `VaultTask.text`,
 *  so a writer can verify it hasn't changed before touching it. */
export interface IcsLink {
  uid: string;
  path: string;
  line: number;
  text: string;
}

/** Where the adapter looks for a task's home note. */
export type NoteMode = 'weekly' | 'daily' | 'auto';

/**
 * Persisted to `data.json` via `PluginSettingTab` — the Obsidian-native answer,
 * chosen over a config note in Build Plan decision 3.
 */
export interface WeekfitSettings {
  /** `auto` prefers weekly when a weekly note exists, else daily. */
  noteMode: NoteMode;
  /** Ignored while `usePeriodicNotes` is true and Periodic Notes is installed. */
  weeklyFolder: string;
  weeklyFormat: string; // moment format, e.g. 'YYYY-[W]WW'
  dailyFolder: string;
  dailyFormat: string; // e.g. 'YYYY-MM-DD'
  /** Defer note location to the Periodic Notes plugin when it's installed
   *  (Build Plan decision 1). Falls back to core Daily Notes, then to the
   *  fields above. */
  usePeriodicNotes: boolean;
  /** Folders the `#thisweek` sweep walks. `[]` means the whole vault. */
  taskFolders: string[];
  /** Never swept, whatever `taskFolders` says. Planning notes are full of
   *  checkboxes that are not this week's tasks. */
  excludeFolders: string[];
  /** Recurring commitments drawn behind the week. Phase 1 renders them; the
   *  Phase 2 settings UI edits them. */
  blocks: SkeletonBlock[];
  /** When work *could* happen. `computeGaps` returns nothing without at least
   *  one, so the defaults ship with one rather than a dead first run. */
  windows: AvailabilityWindow[];
  /** The duration ladder's rung A — per-`#tag` defaults, so an un-annotated
   *  vault still gets sized tasks. */
  durations: DurationMap;
  /** Gap candidates drawn faintly behind the grid. Off by default. */
  showGaps: boolean;
  /**
   * How "Fit this week" distributes work.
   *
   * `earliest` is the ported engine's own rule — soonest day first, which
   * fills Monday before it touches Tuesday. `spread` offers each task the day
   * with the most room left, so a week with real capacity comes back balanced
   * rather than front-loaded.
   */
  fitStrategy: 'spread' | 'earliest';
  /**
   * A read-only iCalendar feed URL (spec §1.4) — `https://…/basic.ics`, the
   * kind of link most calendar providers publish. `''` means no feed
   * configured, which is a normal state, not an error: everything ICS-shaped
   * is simply skipped.
   */
  icsUrl: string;
  /**
   * Spec §2.3. On: calendar events block scheduling gaps like any other
   * commitment, going into both `WeekSnapshot.scheduled` and `.icsEvents`. Off:
   * they're still fetched and shown (via `.icsEvents`), but never reserve
   * time — they're informational only.
   */
  icsEventsBusy: boolean;
  /**
   * Epoch ms of the last successful (or attempted) calendar fetch. Used to
   * rate-limit refreshes (see `ICS_REFRESH_RATE_LIMIT_MS` in main.ts) so a
   * slow or misbehaving feed can't be hammered on every render.
   */
  icsLastRefresh: number;
  /**
   * The last-known snapshot of every tracked calendar event, keyed by its
   * `[ics-uid::]` marker. This is deliberately **not** a vault file: a
   * `.weekfit/ics-state.json` was the obvious place, but Obsidian's
   * directory reviewers flag plugins that create dot-folders in the vault
   * root or reach for `vault.adapter` directly, and `saveData`/`loadData`
   * (which this plugin already uses for every other setting) is the
   * sanctioned store for exactly this kind of plugin-private state — no new
   * IO layer needed. So it lives here, in `data.json`, instead.
   */
  icsState: IcsState;
}

export const DEFAULT_SETTINGS: WeekfitSettings = {
  noteMode: 'auto',
  weeklyFolder: 'Weekly',
  weeklyFormat: 'YYYY-[W]WW',
  dailyFolder: '',
  dailyFormat: 'YYYY-MM-DD',
  usePeriodicNotes: true,
  taskFolders: [],
  excludeFolders: ['Action Plan', 'Templates', '_Template'],
  blocks: [],
  // One window, so "Fit this week" does something on a vault that has never
  // heard of this plugin. Weekdays, 9-5, half an hour the smallest worth
  // proposing.
  windows: [
    { name: 'work', days: [0, 1, 2, 3, 4], startMin: 9 * 60, endMin: 17 * 60, minBlockMin: 30 },
  ],
  durations: { defaultMinutes: 60, byKind: {} },
  showGaps: false,
  // Front-loading is what the raw engine does and it is rarely what anyone
  // wants to look at, so the balanced pass is the default.
  fitStrategy: 'spread',
  icsUrl: '',
  // Calendar events are real commitments by default — the toggle is there
  // for the person who wants them visible but not competing for gaps.
  icsEventsBusy: true,
  icsLastRefresh: 0,
  icsState: {},
};

// ---------------------------------------------------------------------------
// Phase 2 — fitting and writing
// ---------------------------------------------------------------------------

import type { Gap, Proposal, Unplaced } from '../lib/gaps';

/** The one line whose whole job is making over-commitment visible. */
export interface Capacity {
  /** Everything unscheduled, sized by the duration ladder. */
  committedMin: number;
  /** Free minutes inside the availability windows. `null` when no window is
   *  configured at all, which is a different statement from "zero free". */
  freeMin: number | null;
  /** `committedMin - freeMin`, floored at 0. Non-zero is the crimson case. */
  overBy: number;
}

/** The result of pressing "Fit this week" — ghosts, not commitments. Nothing
 *  here has touched the vault; accepting is what writes. */
export interface FitState {
  gaps: Gap[];
  proposals: Proposal[];
  unplaced: Unplaced[];
  capacity: Capacity;
  /**
   * The uid of a block these ghosts are about to become — set when a split is
   * pending. The grid stops drawing it while the ghosts are up, because a
   * ghost sitting on top of the block it replaces reads as two commitments
   * rather than one being reconsidered.
   */
  replacing?: string;
}

/**
 * Why one proposal didn't get written. Said out loud rather than silently
 * dropped — the same discipline `Unplaced` applies to fitting.
 */
export interface WriteSkip {
  key: string;
  title: string;
  reason:
    /** The line moved or changed since the snapshot was read. The write is
     *  refused rather than applied to whatever is there now. */
    | 'line-changed'
    | 'file-missing'
    /** The target line is no longer a checkbox. */
    | 'not-a-task'
    /** The group needs more than one sitting. One line cannot carry two time
     *  ranges, and splitting is Phase 4 — so this is refused, not fudged. */
    | 'needs-splitting';
}

export interface WriteResult {
  written: number;
  skipped: WriteSkip[];
  errors: string[];
}

/**
 * One line edit: set, change, or remove a Day Planner placement.
 *
 * Generalises what accepting a proposal does, so re-timing a block already on
 * the grid and dragging a ghost onto it go through the **same** verified write
 * path rather than growing a second one.
 */
export interface PlacementEdit {
  file: string;
  line: number;
  /** The line as it was when read. The write is refused if it no longer
   *  matches — the note may have changed since, and guessing is not an
   *  option. */
  expectedText: string;
  /** `null` unschedules: the range comes off and the task returns to the rail. */
  range: string | null;
  /** `null` leaves any existing scheduled date exactly as it is. We only ever
   *  *add* one; a `⏳` the user wrote themselves is theirs, not ours to
   *  remove. */
  scheduledDate: string | null;
  /** For the skip report, when one is refused. */
  title: string;
}

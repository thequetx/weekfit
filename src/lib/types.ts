export type Mode = 'planner' | 'ambient' | 'hud' | 'capture';

export interface CalEvent {
  uid: string;
  title: string;
  description?: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /** Phase 4 §3 — the source task's Obsidian Tasks `🆔`, carried on the Google
   *  event as `extendedProperties.private.wdTaskId`. Present only on blocks the
   *  app accepted from a proposal; every session of one task shares it. */
  taskId?: string;
  /** 1-based session index and total, for the `2/3` badge. Both absent on a
   *  task that fitted in one sitting. */
  session?: number;
  sessions?: number;
  /** Phase 5 §5 — the vault line this block was booked from, as
   *  `<vault-relative path>#L<0-indexed line>`, carried on the Google event as
   *  `extendedProperties.private.wdSource`. Absent on every event that didn't
   *  come from a task. Parse it with `parseSource` in `lib/source.ts`. */
  source?: string;
  /** Phase 6 §2 — what happened in this block, once a focus session ended:
   *  `kept` | `cut` | `skipped`. Absent on everything that was never focused,
   *  which is the overwhelming majority. */
  outcome?: FocusOutcome;
}

/** The one question a focus session asks when it finishes. Three answers, one
 *  click — anything longer and it stops being worth answering. */
export type FocusOutcome = 'kept' | 'cut' | 'skipped';

/** A block the HUD is currently counting down. Held in the main process so all
 *  three windows agree on it, and so starting one from the planner reaches the
 *  HUD without the two windows talking to each other. */
export interface FocusSession {
  uid: string;
  title: string;
  start: string; // ISO
  end: string; // ISO
}

/** A checklist item read from the Obsidian vault. `line` is a 0-indexed line. */
export interface VaultTask {
  text: string;
  done: boolean;
  file: string; // vault-relative, forward slashes
  line: number;
}

/** The calendar-side link stamped on a session block (Phase 4 §3). Mirrors
 *  `extendedProperties.private.wd*` in electron/google.cjs. */
export interface SessionProps {
  taskId?: string;
  session?: number;
  sessions?: number;
  /** Phase 5 §5 — `<path>#L<line>` for the vault line this block was booked
   *  from. Stamped on its own, without a `taskId`, for the common case of a
   *  task that fitted in one sitting and never needed an id. */
  source?: string;
  /** Phase 6 §2 — the answer to the focus session's one question. */
  outcome?: FocusOutcome;
}

export interface TaskRef {
  file: string;
  line: number;
  done: boolean;
}

export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
}

/** State of the main-process calendar sync loop, behind the freshness chip. */
export interface CalSyncStatus {
  lastSyncAt: number | null; // ms; last *successful* sync
  lastError: string | null; // message from the last failed attempt
  tokenGone: boolean; // a 410 that hasn't been recovered from yet
  syncing: boolean;
  count: number; // events currently in the local store
  synced: boolean; // has ever completed a sync
}

export interface VaultWeek {
  weekId: string;
  notePath: string | null; // null if the weekly note doesn't exist yet
  weeklyDir: string;
  /** The vault folder's own name — what `obsidian://open?vault=…` wants
   *  (Phase 5 §5). Absent in the plain-browser fallback. */
  vaultName?: string;
  intentions: VaultTask[]; // from `## Intentions`
  tasks: VaultTask[]; // from `## Tasks`
  thisweek: VaultTask[]; // `#thisweek`-tagged lines elsewhere in the vault
  // The main-process file watcher gave up (a vault path that never came back),
  // so vault changes now only arrive on the slow rescan — minutes, not seconds.
  watchDegraded?: boolean;
}

/** A recurring "week skeleton" block from week-skeleton.yaml, normalised. */
export interface SkeletonBlock {
  name: string;
  kind: string; // gym | stream | errand | meal-prep | content | block
  days: number[]; // 0 = Monday ... 6 = Sunday
  startMin: number; // minutes since midnight
  endMin: number;
  note?: string;
  /**
   * Phase 6 §1 — how many minutes before this block starts the HUD row should
   * escalate. Absent falls back to `DEFAULT_LEAD_MIN` (15); `0` turns it off
   * for this block. Editable in the skeleton editor like everything else here.
   */
  leadMin?: number;
}

/** The `durations:` map from week-skeleton.yaml — rung A of Phase 4 §1.
 *  `byKind` is keyed by the lowercased `#tag` written on a task line; the
 *  reserved `default:` key becomes `defaultMinutes` (60m, today's behaviour). */
export interface DurationMap {
  defaultMinutes: number;
  byKind: Record<string, number>; // tag/kind -> minutes
}

/** A named availability window from `windows:` — Phase 4 §2's time map.
 *  Borrowed from Skedpal's Time Maps: "when *could* this kind of work happen",
 *  as opposed to `blocks:`, which is "what is already happening". */
export interface AvailabilityWindow {
  name: string; // deep | admin | content | errands — matched against task #tags
  days: number[]; // 0 = Monday ... 6 = Sunday
  startMin: number; // minutes since midnight
  endMin: number;
  /** Shortest interval worth proposing inside this window. A 20-minute sliver
   *  of a deep-work morning isn't deep work — it's noise on the board. */
  minBlockMin: number;
}

/** Everything week-skeleton.yaml carries, normalised. */
export interface SkeletonDoc {
  blocks: SkeletonBlock[];
  durations: DurationMap;
  windows: AvailabilityWindow[];
  /** Carried through untouched so a save from the editor can't drop it. */
  timezone?: string;
  /**
   * Phase 5 §3 — the folders the `#thisweek` sweep walks, relative to the
   * vault. `[]` means the whole vault; `undefined` means the file has no
   * opinion and `WD_TASK_FOLDERS` still applies. Read in the main process, not
   * here — the renderer only ever edits it.
   */
  taskFolders?: string[];
}

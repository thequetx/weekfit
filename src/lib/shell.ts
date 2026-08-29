// Thin wrapper over the Electron preload bridge (`window.wd`). Every call is a
// no-op in a plain browser tab, so components can call these unconditionally.

import type { AuditSummary } from './audit';
import type {
  CalEvent,
  CalSyncStatus,
  FocusOutcome,
  FocusSession,
  GoogleStatus,
  TaskRef,
  VaultTask,
  VaultWeek,
} from './types';

const wd = typeof window !== 'undefined' ? window.wd : undefined;

export const isElectron = Boolean(wd?.isElectron);

export function hidePlanner(): void {
  wd?.hidePlanner();
}

export function quitApp(): void {
  wd?.quit();
}

export function resizeHud(height: number): void {
  wd?.resizeHud(height);
}

/** Debug: subscribe to the Ctrl+Alt+Shift+H "cycle HUD row count" event.
 *  Returns an unsubscribe fn (a no-op outside Electron). */
export function onHudDebugCycle(cb: () => void): () => void {
  return wd?.onHudDebugCycle?.(cb) ?? (() => {});
}

/** Read the weekly note + `#thisweek` sweep for an ISO week id (e.g. "2026-W36").
 *  Returns null in a plain browser or when the vault isn't reachable. */
export async function readVaultWeek(weekId: string): Promise<VaultWeek | null> {
  if (!wd?.readWeek) return null;
  try {
    return (await wd.readWeek(weekId)) as VaultWeek | null;
  } catch {
    return null;
  }
}

/** Flip a checkbox in place in its markdown file. Returns whether it stuck. */
export async function toggleVaultTask(ref: TaskRef): Promise<boolean> {
  if (!wd?.toggleTask) return false;
  try {
    return await wd.toggleTask(ref);
  } catch {
    return false;
  }
}

/**
 * Phase 5 §5 — write the Day Planner range onto the line a block was booked
 * from (`range: null` takes it off again).
 *
 * Best-effort by design: the vault may be unavailable, or the anchor may point
 * at a line that has since moved. Neither is worth failing the calendar write
 * that prompted it, so this reports and never throws.
 */
export async function setTaskSchedule(ref: {
  file: string;
  line: number;
  range: string | null;
  title?: string | null;
}): Promise<boolean> {
  if (!wd?.setSchedule) return false;
  try {
    const r = await wd.setSchedule(ref);
    return Boolean(r?.ok);
  } catch {
    return false;
  }
}

/**
 * Phase 5 §6 — the open items in `Backlog.md`'s holding pen. Empty outside
 * Electron, which is also what a vault with no backlog file looks like: the tab
 * renders its own "nothing here yet" rather than an error.
 */
export async function readBacklog(): Promise<VaultTask[]> {
  if (!wd?.readBacklog) return [];
  try {
    const r = await wd.readBacklog();
    return r.ok && Array.isArray(r.items) ? r.items : [];
  } catch {
    return [];
  }
}

/** Quick capture: append one line to the holding pen. */
export async function appendBacklog(text: string): Promise<boolean> {
  if (!wd?.appendBacklog) return false;
  try {
    return Boolean((await wd.appendBacklog(text))?.ok);
  } catch {
    return false;
  }
}

/** Move a backlog item into a week's `## Tasks` — vault to vault, no calendar. */
export async function moveBacklogToWeek(
  line: number,
  text: string,
  weekId: string,
): Promise<boolean> {
  if (!wd?.moveToWeek) return false;
  try {
    return Boolean((await wd.moveToWeek({ line, text, weekId }))?.ok);
  } catch {
    return false;
  }
}

/** Dismiss the quick-capture window. */
export function hideCapture(): void {
  void wd?.hideCapture?.();
}

// ---- focus mode (Phase 6 §2) ----------------------------------------------

/** The block currently being counted down, or null. */
export async function focusGet(): Promise<FocusSession | null> {
  if (!wd?.focusGet) return null;
  try {
    return (await wd.focusGet()) as FocusSession | null;
  } catch {
    return null;
  }
}

/** Start counting a block down in the HUD (which is shown if it was hidden). */
export async function focusStart(session: FocusSession): Promise<boolean> {
  if (!wd?.focusStart) return false;
  try {
    return Boolean((await wd.focusStart(session))?.ok);
  } catch {
    return false;
  }
}

export async function focusEnd(): Promise<void> {
  try {
    await wd?.focusEnd?.();
  } catch {
    /* nothing to end */
  }
}

/** Every window follows the same session — the planner starts it, the HUD shows
 *  it, and neither has to know about the other. */
export function onFocusChange(cb: (s: FocusSession | null) => void): () => void {
  return wd?.onFocusChange?.(cb) ?? (() => {});
}

/**
 * Write the focus session's answer onto the event itself, where the Phase 4 §5
 * retrospective reads it back.
 *
 * Returns *why* it failed, not just that it did: answering "kept" while the
 * calendar is disconnected used to record nothing and say nothing (bug #25),
 * which quietly loses the one piece of data the whole feature exists to collect.
 */
export async function setEventOutcome(
  id: string,
  outcome: FocusOutcome,
): Promise<{ ok: boolean; reason?: string }> {
  if (!wd?.calOutcome) return { ok: false, reason: 'desktop app only' };
  try {
    const r = await wd.calOutcome({ id, outcome });
    if (r?.ok) return { ok: true };
    return {
      ok: false,
      reason: r?.needsAuth ? 'calendar not connected' : r?.error || 'write failed',
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Tell the main process a block just entered its lead window, so it can bring
 *  the HUD up if it's hidden. Fire-and-forget. */
export function reportImminent(key: string): void {
  void wd?.hudImminent?.(key);
}

/** Open a note in Obsidian. No-op outside Electron. */
export async function openNote(uri: string): Promise<boolean> {
  if (!wd?.openNote) return false;
  try {
    const r = await wd.openNote(uri);
    return Boolean(r?.ok);
  } catch {
    return false;
  }
}

/**
 * Phase 4 §3 — make sure a task line carries an Obsidian Tasks `🆔`, and say
 * what it is. Returns null outside Electron or on failure, which the caller
 * reads as "no shared id available"; the sessions are still created, they just
 * aren't linked. Half a feature beats a swallowed accept.
 */
export async function ensureTaskId(
  file: string,
  line: number,
  id: string,
): Promise<string | null> {
  if (!wd?.ensureTaskId) return null;
  try {
    const r = await wd.ensureTaskId({ file, line, id });
    return r.ok && r.id ? r.id : null;
  } catch {
    return null;
  }
}

/** Phase 4 §4 — record an accepted replan in the weekly note's `## Review`.
 *  Returns how many times this task has now been replanned this week. */
export async function noteReplan(weekId: string, title: string): Promise<number> {
  if (!wd?.noteReplan) return 0;
  try {
    const r = await wd.noteReplan({ weekId, title });
    return r.ok && typeof r.count === 'number' ? r.count : 0;
  } catch {
    return 0;
  }
}

/** Phase 4 §5 — the `- Audit:` rows already in a week's `## Review`. Asked of
 *  the *previous* week so the Review flow can say "down 3h on W35"; an empty
 *  list is the normal answer for a week that was never reviewed. */
export async function readAudit(weekId: string): Promise<AuditSummary[]> {
  if (!wd?.readAudit) return [];
  try {
    const r = await wd.readAudit(weekId);
    return r.ok && Array.isArray(r.rows) ? r.rows : [];
  } catch {
    return [];
  }
}

/** Weekly review: roll unchecked `## Tasks` into next week's note, record §5's
 *  planned-vs-actual rows under `## Review`, and — Phase 5 §2 — the same week's
 *  numbers in the note's frontmatter, where `Weekly.base` can table them. */
export async function rollWeek(
  weekId: string,
  audit: string[] = [],
  streaks: Array<{ name: string; kept: number; slots: number }> = [],
): Promise<{
  ok: boolean;
  rolled?: number;
  nextId?: string;
  flagged?: Array<{ title: string; count: number }>;
  audited?: number;
  /** Phase 5 §1 — open lines left where they were because they carry `🔁`.
   *  A recurring task is the Tasks plugin's to regenerate, not ours to move. */
  recurring?: number;
  error?: string;
}> {
  if (!wd?.rollWeek) return { ok: false, error: 'desktop app only' };
  try {
    return await wd.rollWeek(weekId, { audit, streaks });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Subscribe to the main process's vault file-watcher (electron/vault.cjs).
 *  Fires in every window, so an edit made in Obsidian reaches the planner, the
 *  ambient overlay and the HUD at the same time — this is what replaced the
 *  per-renderer vault poll. No-op in a plain browser. */
export function onVaultChange(cb: () => void): () => void {
  return wd?.onVaultChange?.(cb) ?? (() => {});
}

/** Create `<weeklyDir>/<weekId>.md` from the template. */
export async function createWeekNote(weekId: string): Promise<boolean> {
  if (!wd?.createWeek) return false;
  try {
    return (await wd.createWeek(weekId)).ok;
  } catch {
    return false;
  }
}

// ---- week skeleton (recurring blocks) -----------------------------------

export async function readSkeletonYaml(): Promise<string | null> {
  if (!wd?.skeletonRead) return null;
  try {
    const r = await wd.skeletonRead();
    return r.ok ? r.yaml : null;
  } catch {
    return null;
  }
}

export async function writeSkeletonYaml(yaml: string): Promise<boolean> {
  if (!wd?.skeletonWrite) return false;
  try {
    return (await wd.skeletonWrite(yaml)).ok;
  } catch {
    return false;
  }
}

export function openSkeletonEditor(): void {
  wd?.openSkeletonEditor?.();
}

export function onSkeletonChange(cb: () => void): () => void {
  return wd?.onSkeletonChange?.(cb) ?? (() => {});
}

// ---- Google Calendar ------------------------------------------------------

export async function googleStatus(): Promise<GoogleStatus> {
  if (!wd?.googleStatus) return { configured: false, connected: false, email: null };
  try {
    return await wd.googleStatus();
  } catch {
    return { configured: false, connected: false, email: null };
  }
}

export async function connectGoogle(): Promise<{ ok: boolean; error?: string }> {
  if (!wd?.connectGoogle) return { ok: false, error: 'desktop app only' };
  try {
    return await wd.connectGoogle();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function disconnectGoogle(): Promise<void> {
  try {
    await wd?.disconnectGoogle?.();
  } catch {
    /* ignore */
  }
}

export function onGoogleChange(cb: () => void): () => void {
  return wd?.onGoogleChange?.(cb) ?? (() => {});
}

/** Create an event via the Calendar API. Returns the created event, or null
 *  (not connected / plain browser / failure). */
export async function createEvent(ev: {
  summary: string;
  start: Date;
  end: Date;
  /** Phase 4 §3 — links this block to its task and says which session it is. */
  props?: { taskId?: string; session?: number; sessions?: number; source?: string };
}): Promise<CalEvent | null> {
  if (!wd?.calInsert) return null;
  try {
    const r = await wd.calInsert({
      summary: ev.summary,
      start: ev.start.toISOString(),
      end: ev.end.toISOString(),
      ...(ev.props ? { props: ev.props } : {}),
    });
    if (!r.ok) return null;
    return toCalEvent(r.event);
  } catch {
    return null;
  }
}

/** One wire event (electron/google.cjs `toWireEvent`) → a `CalEvent`. Shared by
 *  the insert reply and the range read so the §3 session fields can't be
 *  carried by one path and dropped by the other. */
function toCalEvent(e: Record<string, unknown>): CalEvent {
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined);
  return {
    uid: String(e.uid),
    title: String(e.title),
    description: e.description ? String(e.description) : undefined,
    start: new Date(String(e.start)),
    end: new Date(String(e.end)),
    allDay: Boolean(e.allDay),
    taskId: e.taskId ? String(e.taskId) : undefined,
    session: num(e.session),
    sessions: num(e.sessions),
  };
}

/** Move an existing event to a new time (events.patch). */
export async function moveEvent(
  uid: string,
  start: Date,
  end: Date,
): Promise<boolean> {
  if (!wd?.calPatch) return false;
  try {
    const r = await wd.calPatch({
      id: uid,
      start: start.toISOString(),
      end: end.toISOString(),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Delete an event (events.delete). */
export async function deleteEvent(uid: string): Promise<boolean> {
  if (!wd?.calDelete) return false;
  try {
    const r = await wd.calDelete(uid);
    return r.ok;
  } catch {
    return false;
  }
}

function toSyncStatus(raw: Record<string, unknown>): CalSyncStatus {
  return {
    lastSyncAt: typeof raw.lastSyncAt === 'number' ? raw.lastSyncAt : null,
    lastError: raw.lastError ? String(raw.lastError) : null,
    tokenGone: Boolean(raw.tokenGone),
    syncing: Boolean(raw.syncing),
    count: Number(raw.count) || 0,
    synced: Boolean(raw.synced),
  };
}

/** State of the main-process sync loop (freshness chip). Null in a plain
 *  browser, or when Google isn't configured — there's no store either way. */
export async function calendarSyncStatus(): Promise<CalSyncStatus | null> {
  if (!wd?.calStatus) return null;
  try {
    const raw = await wd.calStatus();
    return raw ? toSyncStatus(raw) : null;
  } catch {
    return null;
  }
}

/** Subscribe to the main process's per-sync push. Fires for every window, so
 *  the planner / ambient / HUD all see the same deltas at the same time. */
export function onCalendarChange(cb: (sync: CalSyncStatus) => void): () => void {
  return wd?.onCalendarChange?.((raw) => cb(toSyncStatus(raw))) ?? (() => {});
}

/** Events for a range out of the main process's local sync store (not the
 *  network — see electron/calstore.cjs), so this is instant and works offline.
 *  - CalEvent[]   — connected, events served from the store
 *  - 'needs-auth' — Electron but not connected
 *  - null         — no API available (plain browser) → caller falls back to .ics */
export async function loadEventsViaApi(
  timeMin: Date,
  timeMax: Date,
): Promise<CalEvent[] | 'needs-auth' | null> {
  if (!wd?.calList) return null;
  try {
    const r = await wd.calList({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
    });
    if (r.ok) return r.events.map(toCalEvent);
    return r.needsAuth ? 'needs-auth' : null;
  } catch {
    return null;
  }
}

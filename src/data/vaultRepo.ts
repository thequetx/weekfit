// The vault adapter — Obsidian's `Vault` + `MetadataCache` turned into the
// shapes `src/lib/` already understands. This is the only file in Phase 1
// that touches the real Obsidian API for I/O; everything parsing-shaped is
// pushed down into `src/data/parse.ts` (pure) so it's testable without it.
//
// Phase 1 is read-only: every path below is a `cachedRead`. Nothing here ever
// calls `vault.modify` / `vault.create` / `vault.process`. That's not an
// accident of what got built first — it's the property that makes this phase
// safe to run against Tyler's real vault.

import { moment as obsidianMoment, TFile } from 'obsidian';
import type { App, EventRef, TAbstractFile } from 'obsidian';
import { isoWeekId, startOfISOWeek, addDays } from '../lib/week';
import type { CalEvent, VaultTask } from '../lib/types';
import type { WeekfitSettings } from './contract';
import type { WeekSnapshot } from './contract';
import { resolveNoteLocations } from './periodicNotes';
import { findIcsLinks, parseSections, parseTasksIn, scheduledEvents, sweepTagged } from './parse';
import type { IcsLink } from './contract';
// Aliased so `VaultRepo.fetchIcsEvents` (the settings-aware wrapper other
// callers use) doesn't collide with the module-level function it delegates
// to.
import { fetchIcsEvents as loadIcsFeed } from './ics';

const THISWEEK_TAG = 'thisweek';
const DEBOUNCE_MS = 300;

/** How long a fetched calendar feed is reused before the next `readWeek` goes
 *  back to the network. Matches the refresh command's own hourly limit, so the
 *  two never disagree about how fresh "fresh" is. */
const ICS_CACHE_MS = 60 * 60 * 1000;

// `obsidian.d.ts` types `moment` via `import * as Moment from 'moment'; export
// const moment: typeof Moment`. Under this project's `esModuleInterop` +
// `moduleResolution: "bundler"`, that produces a namespace type with no call
// signature here even though the runtime value Obsidian hands over — its own
// already-configured moment instance — is the real callable function. The
// cast is purely a type-level workaround for that interop quirk; the value
// itself is untouched, and never reimplemented or re-bundled.
const momentFn = obsidianMoment as unknown as (date: Date) => { format(fmt: string): string };

function taskKey(t: { file: string; line: number }): string {
  return `${t.file}:${t.line}`;
}

/** Vault-relative folder match: `folder` matches `path` itself or anything
 *  nested under it. `''` matches everything (vault root, or "no filter"). */
function pathUnderFolder(path: string, folder: string): boolean {
  const p = path.replace(/\\/g, '/');
  const f = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (f === '') return true;
  return p === f || p.startsWith(`${f}/`);
}

export class VaultRepo {
  constructor(
    private readonly app: App,
    private readonly getSettings: () => WeekfitSettings,
  ) {}

  /** Last successful feed fetch, reused by every `readWeek` inside
   *  {@link ICS_CACHE_MS}. See `fetchIcsEvents` for why this is not
   *  optional. */
  private icsCache: { url: string; fetchedAt: number; events: CalEvent[] } | null = null;

  /**
   * The single entry point: everything a rendered week needs, read fresh from
   * the vault. `weekStart` is normalised to local midnight Monday internally,
   * so a caller handing over any day in the week still gets the right note.
   */
  async readWeek(weekStartIn: Date): Promise<WeekSnapshot> {
    const settings = this.getSettings();
    const weekStart = startOfISOWeek(weekStartIn);
    const weekId = isoWeekId(weekStart);
    const locations = resolveNoteLocations(this.app, settings);

    const errors: string[] = [];
    let intentions: VaultTask[] = [];
    let tasks: VaultTask[] = [];
    const events: CalEvent[] = [];
    // Kept strictly in lockstep with `events` — `scheduledLines[i]` is the raw
    // line `events[i]` came from. Every push below happens in the same call,
    // from the same `scheduledEvents` result, so the two arrays can never
    // drift apart (see `ScheduledEventsResult.lines` in parse.ts).
    const scheduledLines: VaultTask[] = [];

    // --- the weekly note -----------------------------------------------
    const weeklyPath = this.notePathFor(weekStart, locations.weekly.folder, locations.weekly.format);
    const weeklyFile = this.asFile(this.app.vault.getAbstractFileByPath(weeklyPath));
    const notePath = weeklyFile ? weeklyFile.path : null;

    if (weeklyFile && settings.noteMode !== 'daily') {
      const content = await this.safeRead(weeklyFile.path, errors);
      if (content != null) {
        const sections = parseSections(content);
        const intentionsRange = sections['intentions'];
        const tasksRange = sections['tasks'];
        if (intentionsRange) {
          intentions = intentions.concat(
            parseTasksIn(content, weeklyFile.path, intentionsRange.start, intentionsRange.end),
          );
        }
        if (tasksRange) {
          tasks = tasks.concat(
            parseTasksIn(content, weeklyFile.path, tasksRange.start, tasksRange.end),
          );
        }

        const sched = scheduledEvents(content, weeklyFile.path, null, weekStart);
        events.push(...sched.events);
        scheduledLines.push(...sched.lines);
        if (sched.unresolved > 0) {
          const plural = sched.unresolved !== 1;
          errors.push(
            `${sched.unresolved} timed line${plural ? 's' : ''} in ${weeklyFile.name} ${plural ? 'have' : 'has'} no date — add ⏳ YYYY-MM-DD or move them to a daily note`,
          );
        }
      }
    }

    // --- the week's seven daily notes ------------------------------------
    // 'weekly' mode never looks at daily notes; 'daily' and 'auto' both do —
    // 'auto' on top of the weekly note above, so a task or a Day Planner line
    // written into either place is seen.
    if (settings.noteMode !== 'weekly') {
      for (let i = 0; i < 7; i++) {
        const dayDate = addDays(weekStart, i);
        const dayPath = this.notePathFor(dayDate, locations.daily.folder, locations.daily.format);
        const dayFile = this.asFile(this.app.vault.getAbstractFileByPath(dayPath));
        if (!dayFile) continue;

        const content = await this.safeRead(dayFile.path, errors);
        if (content == null) continue;

        const sections = parseSections(content);
        const intentionsRange = sections['intentions'];
        const tasksRange = sections['tasks'];
        if (intentionsRange) {
          intentions = intentions.concat(
            parseTasksIn(content, dayFile.path, intentionsRange.start, intentionsRange.end),
          );
        }
        if (tasksRange) {
          tasks = tasks.concat(
            parseTasksIn(content, dayFile.path, tasksRange.start, tasksRange.end),
          );
        }

        // A daily note's own date always resolves its Day Planner lines —
        // rule 1 of scheduledEvents — so `unresolved` is never non-zero here.
        const sched = scheduledEvents(content, dayFile.path, dayDate, weekStart);
        events.push(...sched.events);
        scheduledLines.push(...sched.lines);
      }
    }

    // --- the #thisweek sweep --------------------------------------------
    const known = new Set([...intentions, ...tasks].map(taskKey));
    let thisweek: VaultTask[] = [];
    try {
      thisweek = (await this.sweepThisWeek(settings)).filter((t) => !known.has(taskKey(t)));
    } catch (err) {
      errors.push(`#thisweek sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // --- the calendar feed ------------------------------------------------
    //
    // A `reviewed` week is closed — the note is done being written, and the
    // whole point of ICS here is to help *plan* the week, so there's nothing
    // for it to do once review has happened. Skipped entirely rather than
    // fetched-and-ignored, so a reviewed week never pays the network cost.
    const reviewedStatus = weeklyFile
      ? this.app.metadataCache.getFileCache(weeklyFile)?.frontmatter?.status
      : undefined;
    const icsEvents: CalEvent[] = reviewedStatus === 'reviewed' ? [] : await this.fetchIcsEvents();

    // `icsEvents` is always carried on the snapshot (see the field doc in
    // contract.ts); it only also joins `scheduled` — and therefore reserves
    // gaps via computeGaps — when the busy toggle is on. Appended *after* the
    // Day Planner events collected above, deliberately: several consumers
    // (`review.ts`, `planner.ts`) pair `scheduled[i]` with `scheduledLines[i]`
    // or build a same-length array from `scheduledLines` alone, and none of
    // them index past `scheduledLines.length` — but keeping ICS events at the
    // tail, past every real line, means a consumer that ever did would find
    // "no matching line" rather than "the wrong line".
    if (settings.icsEventsBusy) events.push(...icsEvents);

    return {
      weekId,
      weekStart,
      notePath,
      intentions,
      tasks,
      thisweek,
      scheduled: events,
      scheduledLines,
      icsEvents,
      errors,
    };
  }

  /**
   * The plugin's one calendar feed, if configured. Delegates to
   * `data/ics.ts`'s module-level `fetchIcsEvents`, which never
   * throws — a bad or empty URL, a network failure, or a malformed feed all
   * come back as `[]` so a broken calendar setting never stops the week from
   * rendering.
   *
   * ⚠️ **Cached, and it has to be.** `readWeek` calls this, and `readWeek`
   * runs on every debounced vault change — so without a cache, typing in any
   * note in the vault would put an HTTPS request to the user's calendar
   * provider on the wire every 300ms. That is the "server hammering" the
   * hourly limit on the *refresh command* was meant to prevent, arriving by
   * the back door: that limit governs reconciling `[ics-uid::]` markers, not
   * drawing the feed on the grid. A calendar does not change often enough for
   * a re-read of the same week to be worth a round trip, so the cache holds
   * for {@link ICS_CACHE_MS} and the explicit command bypasses it with
   * `force`.
   *
   * Keyed on the URL, so changing the setting takes effect immediately rather
   * than showing the old calendar for an hour.
   */
  async fetchIcsEvents(force = false): Promise<CalEvent[]> {
    const settings = this.getSettings();
    const url = settings.icsUrl?.trim();
    if (!url) {
      this.icsCache = null;
      return [];
    }

    const cached = this.icsCache;
    if (
      !force &&
      cached &&
      cached.url === url &&
      Date.now() - cached.fetchedAt < ICS_CACHE_MS
    ) {
      return cached.events;
    }

    const events = await loadIcsFeed(url);
    this.icsCache = { url, fetchedAt: Date.now(), events };
    return events;
  }

  /**
   * Fires `cb` (debounced ~300ms, so a save-storm from typing collapses into
   * one refresh) on any vault or metadata change. Returns an unsubscribe that
   * releases every `EventRef` — this is the plugin's entire file-watcher
   * subsystem, deliberately this small (the desktop app's own watcher caused
   * four of its nineteen bugs).
   */
  onChange(cb: () => void): () => void {
    let timer: number | null = null;
    const trigger = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        cb();
      }, DEBOUNCE_MS);
    };

    const refs: EventRef[] = [
      this.app.vault.on('modify', trigger),
      this.app.vault.on('create', trigger),
      this.app.vault.on('delete', trigger),
      this.app.vault.on('rename', trigger),
      this.app.metadataCache.on('changed', trigger),
    ];

    return () => {
      if (timer != null) window.clearTimeout(timer);
      for (const ref of refs) this.app.vault.offref(ref);
    };
  }

  // -----------------------------------------------------------------------
  // internals
  // -----------------------------------------------------------------------

  private notePathFor(date: Date, folder: string, format: string): string {
    return notePathFor(date, folder, format);
  }

  private asFile(f: TAbstractFile | null): TFile | null {
    return f instanceof TFile ? f : null;
  }

  /** `cachedRead`, never `read` — display reads only. Never throws: a bad or
   *  vanished file becomes one line in `errors` and the week still renders. */
  private async safeRead(path: string, errors: string[]): Promise<string | null> {
    try {
      const file = this.asFile(this.app.vault.getAbstractFileByPath(path));
      if (!file) return null;
      return await this.app.vault.cachedRead(file);
    } catch (err) {
      errors.push(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * `#thisweek`-tagged checkbox lines across `taskFolders` (empty = whole
   * vault), minus `excludeFolders` and any `Handoff Log.md`.
   *
   * Narrows with `metadataCache.getFileCache(f)?.tags` before reading
   * anything, so a large vault costs one cache lookup per markdown file
   * rather than a `cachedRead` of every note — only files that actually carry
   * the tag get read.
   */
  /**
   * Every open task in the configured folders — the backlog.
   *
   * Deliberately **narrower than "every checkbox in the vault"**. The vault
   * convention that shaped the `#thisweek` sweep warns that planning notes,
   * handoff logs and templates are full of checkboxes that are not anybody's
   * tasks; dumping all of them into a view would make the backlog the noisiest
   * surface in the plugin and the first thing a user turns off. So this honours
   * exactly the same folder rules as the sweep.
   *
   * When `taskFolders` is empty the sweep means "the whole vault", which is
   * right for a targeted `#thisweek` search and wrong here — so the backlog
   * reports `unscoped` instead, and the view asks the user to name some
   * folders rather than showing them a thousand rows.
   */
  async readBacklog(limit = 300): Promise<{
    tasks: VaultTask[];
    /** No `taskFolders` set, so nothing was swept. */
    unscoped: boolean;
    /** More matched than `limit`; the view says so rather than pretending. */
    truncated: boolean;
    errors: string[];
  }> {
    const settings = this.getSettings();
    const folders = settings.taskFolders ?? [];
    const excludes = settings.excludeFolders ?? [];
    const errors: string[] = [];

    if (folders.length === 0) {
      return { tasks: [], unscoped: true, truncated: false, errors };
    }

    const files = this.app.vault.getMarkdownFiles().filter((f) => {
      const path = f.path.replace(/\\/g, '/');
      if (path.endsWith('Handoff Log.md')) return false;
      if (excludes.some((ex) => pathUnderFolder(path, ex))) return false;
      return folders.some((fo) => pathUnderFolder(path, fo));
    });

    const out: VaultTask[] = [];
    let truncated = false;
    for (const f of files) {
      if (out.length >= limit) {
        truncated = true;
        break;
      }
      try {
        const content = await this.app.vault.cachedRead(f);
        out.push(...parseTasksIn(content, f.path, 0, Number.MAX_SAFE_INTEGER).filter((t) => !t.done));
      } catch {
        errors.push(`Could not read ${f.path}`);
      }
    }

    return { tasks: out.slice(0, limit), unscoped: false, truncated, errors };
  }

  /**
   * Markdown files honouring `taskFolders`/`excludeFolders` the same way the
   * `#thisweek` sweep always has: `taskFolders: []` means "the whole vault"
   * here (unlike `readBacklog`, which treats an empty scope as "ask the user
   * to configure folders" rather than defaulting to everything — a
   * deliberately different policy, so it keeps its own filter rather than
   * sharing this one). Extracted so the `#thisweek` sweep and the
   * `[ics-uid::]` scan walk the vault exactly the same way instead of growing
   * two copies of this filter that could drift apart.
   */
  private filesInScope(settings: WeekfitSettings): TFile[] {
    const folders = settings.taskFolders ?? [];
    const excludes = settings.excludeFolders ?? [];

    return this.app.vault.getMarkdownFiles().filter((f) => {
      const path = f.path.replace(/\\/g, '/');
      if (path.endsWith('Handoff Log.md')) return false;
      if (excludes.some((ex) => pathUnderFolder(path, ex))) return false;
      if (folders.length > 0 && !folders.some((fo) => pathUnderFolder(path, fo))) return false;
      return true;
    });
  }

  private async sweepThisWeek(settings: WeekfitSettings): Promise<VaultTask[]> {
    const target = `#${THISWEEK_TAG}`.toLowerCase();

    const candidates = this.filesInScope(settings).filter((f) => {
      const cache = this.app.metadataCache.getFileCache(f);
      const tags = cache?.tags ?? [];
      return tags.some((t) => String(t?.tag ?? '').toLowerCase() === target);
    });

    const out: VaultTask[] = [];
    for (const f of candidates) {
      try {
        const content = await this.app.vault.cachedRead(f);
        out.push(...sweepTagged(content, f.path, THISWEEK_TAG));
      } catch {
        // An unreadable file during the sweep is skipped, not fatal — the
        // rest of the week still has to render.
      }
    }
    return out;
  }

  /**
   * Every `[ics-uid::]` marker in the vault, i.e. every task the
   * user has already converted from a calendar event. This is the "tracked
   * uids" list `icsState.ts`'s `deltaIcsEvents`/`nextIcsState` need: not
   * "every event in the feed", only the ones with a task line to reconcile.
   *
   * Unlike `[ics-uid::]`, this marker carries no Obsidian tag to narrow the
   * file list by cache first — a Dataview inline field isn't indexed that
   * way — so every in-scope file is read. Same non-fatal discipline as the
   * `#thisweek` sweep: a file that fails to read is dropped, not thrown.
   */
  async readIcsLinks(): Promise<IcsLink[]> {
    const settings = this.getSettings();
    const files = this.filesInScope(settings);

    const out: IcsLink[] = [];
    for (const f of files) {
      try {
        const content = await this.app.vault.cachedRead(f);
        out.push(...findIcsLinks(content, f.path));
      } catch {
        // Unreadable file — skipped, same as everywhere else in this class.
      }
    }
    return out;
  }
}

/**
 * The vault-relative path of the periodic note for `date`, given a folder and
 * a moment format. Exported because the plugin needs to answer "is this file
 * the daily note for that day?" when deciding whether a written line needs
 * its own `⏳` date — and a second, subtly different copy of this beside it
 * in `main.ts` is exactly the kind of duplication that drifts.
 */
export function notePathFor(date: Date, folder: string, format: string): string {
  const name = momentFn(date).format(format);
  const cleanFolder = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return cleanFolder ? `${cleanFolder}/${name}.md` : `${name}.md`;
}

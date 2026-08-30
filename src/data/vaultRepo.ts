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
import { parseSections, parseTasksIn, scheduledEvents, sweepTagged } from './parse';

const THISWEEK_TAG = 'thisweek';
const DEBOUNCE_MS = 300;

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

    return {
      weekId,
      weekStart,
      notePath,
      intentions,
      tasks,
      thisweek,
      scheduled: events,
      scheduledLines,
      errors,
    };
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

  private async sweepThisWeek(settings: WeekfitSettings): Promise<VaultTask[]> {
    const folders = settings.taskFolders ?? [];
    const excludes = settings.excludeFolders ?? [];
    const target = `#${THISWEEK_TAG}`.toLowerCase();

    const files = this.app.vault.getMarkdownFiles().filter((f) => {
      const path = f.path.replace(/\\/g, '/');
      if (path.endsWith('Handoff Log.md')) return false;
      if (excludes.some((ex) => pathUnderFolder(path, ex))) return false;
      if (folders.length > 0 && !folders.some((fo) => pathUnderFolder(path, fo))) return false;
      return true;
    });

    const candidates = files.filter((f) => {
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

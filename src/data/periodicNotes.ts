// Deferring note location to the Periodic Notes plugin (Build Plan decision 1).
//
// Neither Periodic Notes nor Obsidian's core Daily Notes plugin ships types,
// and their internals are not part of any stable API — so every step below is
// wrapped in optional chaining *and* try/catch. A property access that throws
// (a future version replacing a plain object with a getter that validates
// state, say) must fall through to the next source, not crash `readWeek`.
//
// Only a type-only import of `App` crosses into 'obsidian' here, so this file
// has no runtime dependency on the real Obsidian module and can be imported
// under plain `node` in tests (see test/periodicNotes.test.ts) with a fake
// `app` object standing in for the real one.

import type { App } from 'obsidian';
import type { WeekfitSettings } from './contract';

// --- the shapes we read out of two other plugins ---------------------------
//
// Written out rather than reached for through `any`. The values are still
// untrusted — every field stays optional and every read stays guarded — but
// describing the shape makes a mistyped property a compile error instead of
// `undefined` at runtime, and it settles the unsafe-`any` lint rules for the
// right reason rather than by suppressing them.

/** One period's configuration inside Periodic Notes' settings. */
interface PeriodicSection {
  enabled?: boolean;
  folder?: string;
  format?: string;
}

interface PeriodicNotesPlugin {
  settings?: {
    weekly?: PeriodicSection;
    daily?: PeriodicSection;
  };
}

interface DailyNotesPlugin {
  instance?: {
    options?: {
      folder?: string;
      format?: string;
    };
  };
}

/**
 * `App` offers no typed route to another plugin's settings, because reaching
 * for one is explicitly outside the public API. This names that access once,
 * so the rest of the file reads normally — and so a reviewer has a single
 * place to look for everything here that Obsidian does not promise to keep
 * stable.
 */
interface PluginHost {
  plugins?: { getPlugin?: (id: string) => unknown };
  internalPlugins?: { getPluginById?: (id: string) => unknown };
}

export interface NoteLocationSpec {
  folder: string;
  format: string; // a moment format string, e.g. 'YYYY-[W]WW'
}

/** Which source actually supplied the locations returned — so the settings
 *  tab can say "Using Periodic Notes' weekly format" instead of duplicating a
 *  setting the user would then have to keep in sync by hand. */
export type NoteLocationSource = 'periodic-notes' | 'daily-notes' | 'settings';

export interface NoteLocations {
  weekly: NoteLocationSpec;
  daily: NoteLocationSpec;
  source: NoteLocationSource;
}

/**
 * Resolve where weekly and daily notes live, deferring to other plugins when
 * asked to and when they're actually installed and enabled.
 *
 * Resolution, per field (weekly / daily independently — a vault can easily
 * have Periodic Notes' weekly notes on but rely on core Daily Notes, or vice
 * versa):
 *   1. `settings.usePeriodicNotes` and the Periodic Notes plugin is present
 *      with that period enabled in its own settings.
 *   2. Core Daily Notes' `folder`/`format` (daily only — it has no concept of
 *      a week).
 *   3. This plugin's own `weeklyFolder`/`weeklyFormat`/`dailyFolder`/
 *      `dailyFormat`.
 *
 * `source` reports the first (most-preferred) source that actually
 * contributed a location, for the settings tab's read-only line.
 *
 * NOTE: Periodic Notes does not publish TypeScript types or a documented
 * settings shape. The `{ daily: { enabled, format, folder }, weekly: {...} }`
 * shape below matches the plugin's known-current settings object, but this
 * was coded defensively against that being correct rather than verified
 * against a live install — which is exactly why every access here is
 * try/catch-guarded and every field falls back cleanly.
 */
export function resolveNoteLocations(app: App, settings: WeekfitSettings): NoteLocations {
  let weekly: NoteLocationSpec | null = null;
  let daily: NoteLocationSpec | null = null;
  let source: NoteLocationSource = 'settings';

  if (settings.usePeriodicNotes) {
    try {
      const host = app as unknown as PluginHost;
      const periodicNotes = host.plugins?.getPlugin?.('periodic-notes') as
        | PeriodicNotesPlugin
        | undefined;
      const pnSettings = periodicNotes?.settings;

      const w = pnSettings?.weekly;
      if (w?.enabled) {
        weekly = {
          folder: String(w.folder ?? ''),
          format: String(w.format ?? settings.weeklyFormat),
        };
        source = 'periodic-notes';
      }

      const d = pnSettings?.daily;
      if (d?.enabled) {
        daily = {
          folder: String(d.folder ?? ''),
          format: String(d.format ?? settings.dailyFormat),
        };
        source = 'periodic-notes';
      }
    } catch {
      // Periodic Notes isn't installed, isn't enabled, or its settings shape
      // moved out from under us. Fall through to the next source.
    }
  }

  if (!daily) {
    try {
      const host = app as unknown as PluginHost;
      const dailyNotes = host.internalPlugins?.getPluginById?.('daily-notes') as
        | DailyNotesPlugin
        | undefined;
      const opts = dailyNotes?.instance?.options;
      if (opts && (opts.format || opts.folder)) {
        daily = {
          folder: String(opts.folder ?? ''),
          format: String(opts.format ?? settings.dailyFormat),
        };
        if (source === 'settings') source = 'daily-notes';
      }
    } catch {
      // Core Daily Notes plugin is off, or its internals moved. Fall through.
    }
  }

  return {
    weekly: weekly ?? { folder: settings.weeklyFolder, format: settings.weeklyFormat },
    daily: daily ?? { folder: settings.dailyFolder, format: settings.dailyFormat },
    source,
  };
}

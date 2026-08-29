import { describe, expect, it } from 'vitest';
import { resolveNoteLocations } from '../src/data/periodicNotes';
import { DEFAULT_SETTINGS } from '../src/data/contract';
import type { WeekfitSettings } from '../src/data/contract';

function settings(overrides: Partial<WeekfitSettings> = {}): WeekfitSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe('resolveNoteLocations', () => {
  it('branch 1: uses Periodic Notes when usePeriodicNotes is true and it is installed/enabled', () => {
    const app = {
      plugins: {
        getPlugin: (id: string) =>
          id === 'periodic-notes'
            ? {
                settings: {
                  weekly: { enabled: true, format: 'gggg-[W]ww', folder: 'PN-Weekly' },
                  daily: { enabled: true, format: 'YYYY-MM-DD', folder: 'PN-Daily' },
                },
              }
            : null,
      },
      internalPlugins: { getPluginById: () => null },
    } as any;

    const result = resolveNoteLocations(app, settings({ usePeriodicNotes: true }));
    expect(result.source).toBe('periodic-notes');
    expect(result.weekly).toEqual({ folder: 'PN-Weekly', format: 'gggg-[W]ww' });
    expect(result.daily).toEqual({ folder: 'PN-Daily', format: 'YYYY-MM-DD' });
  });

  it('branch 1b: only weekly enabled in Periodic Notes falls back to Daily Notes/settings for daily', () => {
    const app = {
      plugins: {
        getPlugin: (id: string) =>
          id === 'periodic-notes'
            ? { settings: { weekly: { enabled: true, format: 'gggg-[W]ww', folder: 'PN-Weekly' }, daily: { enabled: false } } }
            : null,
      },
      internalPlugins: {
        getPluginById: (id: string) =>
          id === 'daily-notes' ? { instance: { options: { format: 'YYYY-MM-DD', folder: 'Journal' } } } : null,
      },
    } as any;

    const result = resolveNoteLocations(app, settings({ usePeriodicNotes: true }));
    expect(result.source).toBe('periodic-notes'); // weekly came from Periodic Notes
    expect(result.weekly).toEqual({ folder: 'PN-Weekly', format: 'gggg-[W]ww' });
    expect(result.daily).toEqual({ folder: 'Journal', format: 'YYYY-MM-DD' });
  });

  it('branch 2: falls back to core Daily Notes when Periodic Notes is absent', () => {
    const app = {
      plugins: { getPlugin: () => null },
      internalPlugins: {
        getPluginById: (id: string) =>
          id === 'daily-notes' ? { instance: { options: { format: 'YYYY-MM-DD', folder: 'Journal' } } } : null,
      },
    } as any;

    const result = resolveNoteLocations(app, settings({ usePeriodicNotes: true }));
    expect(result.source).toBe('daily-notes');
    expect(result.daily).toEqual({ folder: 'Journal', format: 'YYYY-MM-DD' });
    // Daily Notes has no concept of a week — weekly still comes from settings.
    expect(result.weekly).toEqual({ folder: DEFAULT_SETTINGS.weeklyFolder, format: DEFAULT_SETTINGS.weeklyFormat });
  });

  it('branch 2b: skips Daily Notes entirely when usePeriodicNotes is false, even if it is installed', () => {
    const app = {
      plugins: { getPlugin: () => null },
      internalPlugins: {
        getPluginById: (id: string) =>
          id === 'daily-notes' ? { instance: { options: { format: 'YYYY-MM-DD', folder: 'Journal' } } } : null,
      },
    } as any;

    // usePeriodicNotes only gates the Periodic Notes branch; core Daily Notes
    // is still consulted next regardless, per the documented resolution order.
    const result = resolveNoteLocations(app, settings({ usePeriodicNotes: false }));
    expect(result.source).toBe('daily-notes');
    expect(result.daily).toEqual({ folder: 'Journal', format: 'YYYY-MM-DD' });
  });

  it('branch 3: falls back to the plugin’s own settings when nothing else is available', () => {
    const app = {
      plugins: { getPlugin: () => null },
      internalPlugins: { getPluginById: () => null },
    } as any;

    const custom = settings({
      usePeriodicNotes: false,
      weeklyFolder: 'MyWeekly',
      weeklyFormat: 'YYYY-[W]WW',
      dailyFolder: 'MyDaily',
      dailyFormat: 'YYYY-MM-DD',
    });
    const result = resolveNoteLocations(app, custom);
    expect(result.source).toBe('settings');
    expect(result.weekly).toEqual({ folder: 'MyWeekly', format: 'YYYY-[W]WW' });
    expect(result.daily).toEqual({ folder: 'MyDaily', format: 'YYYY-MM-DD' });
  });

  it('falls all the way through to settings when app has no plugin machinery at all', () => {
    const result = resolveNoteLocations({} as any, settings());
    expect(result.source).toBe('settings');
    expect(result.weekly).toEqual({ folder: DEFAULT_SETTINGS.weeklyFolder, format: DEFAULT_SETTINGS.weeklyFormat });
    expect(result.daily).toEqual({ folder: DEFAULT_SETTINGS.dailyFolder, format: DEFAULT_SETTINGS.dailyFormat });
  });

  it('the try/catch holds when Periodic Notes throws on property access', () => {
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error('Periodic Notes internals moved');
        },
      },
    );
    const app = {
      plugins: { getPlugin: () => throwing },
      internalPlugins: {
        getPluginById: (id: string) =>
          id === 'daily-notes' ? { instance: { options: { format: 'YYYY-MM-DD', folder: 'Journal' } } } : null,
      },
    } as any;

    expect(() => resolveNoteLocations(app, settings({ usePeriodicNotes: true }))).not.toThrow();
    const result = resolveNoteLocations(app, settings({ usePeriodicNotes: true }));
    // Fell through past the throwing Periodic Notes object to core Daily Notes.
    expect(result.source).toBe('daily-notes');
    expect(result.daily).toEqual({ folder: 'Journal', format: 'YYYY-MM-DD' });
  });

  it('the try/catch holds when core Daily Notes also throws on property access', () => {
    const throwingPn = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    );
    const throwingDn = new Proxy(
      {},
      {
        get() {
          throw new Error('boom too');
        },
      },
    );
    const app = {
      plugins: { getPlugin: () => throwingPn },
      internalPlugins: { getPluginById: () => throwingDn },
    } as any;

    expect(() => resolveNoteLocations(app, settings({ usePeriodicNotes: true }))).not.toThrow();
    const result = resolveNoteLocations(app, settings({ usePeriodicNotes: true }));
    expect(result.source).toBe('settings');
    expect(result.weekly).toEqual({ folder: DEFAULT_SETTINGS.weeklyFolder, format: DEFAULT_SETTINGS.weeklyFormat });
    expect(result.daily).toEqual({ folder: DEFAULT_SETTINGS.dailyFolder, format: DEFAULT_SETTINGS.dailyFormat });
  });

  it('does not consult Periodic Notes at all when usePeriodicNotes is false', () => {
    let called = false;
    const app = {
      plugins: {
        getPlugin: () => {
          called = true;
          return { settings: { weekly: { enabled: true, format: 'X', folder: 'Y' } } };
        },
      },
      internalPlugins: { getPluginById: () => null },
    } as any;

    const result = resolveNoteLocations(app, settings({ usePeriodicNotes: false }));
    expect(called).toBe(false);
    expect(result.source).toBe('settings');
  });
});

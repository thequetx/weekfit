// Phase 1 covered note mode, deferring to Periodic Notes (plus what it
// resolved to), the four folder/format fields it can supply, and the
// #thisweek sweep's folder filters. Phase 2 adds the engine's three inputs:
// recurring blocks, availability windows, and the duration ladder.

import { PluginSettingTab, Setting } from 'obsidian';
import type { App, Plugin } from 'obsidian';
import type { NoteMode, WeekfitSettings } from '../data/contract';
import { resolveNoteLocations } from '../data/periodicNotes';
import type { AvailabilityWindow, SkeletonBlock } from '../lib/types';

/** What `SettingsTab` needs from the plugin object, without importing
 *  `src/main.ts` (owned by another agent right now). Real `WeekfitPlugin`
 *  satisfies this by construction — `settings` typed concretely and a
 *  `saveSettings` method are exactly what `Plugin` (from 'obsidian') declares
 *  loosely and every plugin defines. */
export interface WeekfitPluginLike extends Plugin {
  settings: WeekfitSettings;
  saveSettings(): Promise<void>;
}

const NOTE_MODE_LABELS: Record<NoteMode, string> = {
  auto: 'Auto (prefer weekly, fall back to daily)',
  weekly: 'Weekly note only',
  daily: 'Daily notes only',
};

// --- shared day/time helpers for the Phase 2 editors below -----------------

const DAY_ABBR = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** `[0, 2, 4]` -> `"Mon, Wed, Fri"`. */
function fmtDaysList(days: number[]): string {
  return days
    .slice()
    .sort((a, b) => a - b)
    .map((d) => DAY_ABBR[d] ?? String(d))
    .join(', ');
}

/** `"Mon, Wed, Fri"` or `"0, 2, 4"` -> `[0, 2, 4]`; `null` on anything it
 *  can't parse, so the caller can refuse the edit rather than silently
 *  dropping the entry that didn't match. */
function parseDaysList(value: string): number[] | null {
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return [];
  const days = new Set<number>();
  for (const p of parts) {
    const n = Number(p);
    if (Number.isInteger(n) && n >= 0 && n <= 6) {
      days.add(n);
      continue;
    }
    const idx = DAY_ABBR.findIndex((d) => d.toLowerCase() === p.toLowerCase().slice(0, 3));
    if (idx === -1) return null;
    days.add(idx);
  }
  return Array.from(days).sort((a, b) => a - b);
}

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** `"09:30"` -> `570`; `null` for anything that isn't `HH:MM`. */
function parseHHMM(value: string): number | null {
  const m = value.trim().match(TIME_RE);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** `570` -> `"09:30"`, what an `<input type="time">` wants. */
function fmtHHMM(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = ((min % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** A small red line under a settings row, toggled on/off imperatively so a
 *  keystroke that fails validation doesn't force a full `display()` re-render
 *  (which would drop focus out of the field being typed into). */
function errorSlot(parent: HTMLElement): (msg: string | null) => void {
  const el = parent.createDiv({ cls: 'weekfit-settings-error' });
  el.style.display = 'none';
  return (msg: string | null) => {
    el.setText(msg ?? '');
    el.style.display = msg ? '' : 'none';
  };
}

export class SettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: WeekfitPluginLike,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const settings = this.plugin.settings;
    const save = async () => {
      await this.plugin.saveSettings();
      // Folder/format fields disable themselves based on usePeriodicNotes and
      // on what Periodic Notes actually resolves to, so a toggle needs a
      // full re-render, not just a value update.
      this.display();
    };


    // --- getting started ---------------------------------------------
    //
    // Availability windows are the one setting with no sensible universal
    // default, and nothing in the plugin works without one — so a first run
    // that says nothing here is a first run that looks broken. This block
    // shows only while there is genuinely nothing configured, and gets out of
    // the way permanently once there is.
    if (settings.windows.length === 0) {
      new Setting(containerEl).setName('Getting started').setHeading();
      const intro = containerEl.createEl('div', { cls: 'setting-item-description' });
      intro.createEl('p', {
        text:
          'Weekfit needs to know when work could happen before it can fit anything. ' +
          'Add at least one availability window below — weekdays 09:00 to 17:00, say.',
      });
      const steps = intro.createEl('ol');
      steps.createEl('li', { text: 'Add an availability window: when work could happen.' });
      steps.createEl('li', {
        text: 'Optionally add recurring commitments, so they count as busy.',
      });
      steps.createEl('li', {
        text: 'Run "Weekfit: Create this week’s note" from the command palette.',
      });
      steps.createEl('li', {
        text: 'Put anything under ## Tasks — a plain "- [ ] Book dentist" is enough.',
      });
      steps.createEl('li', { text: 'Open the week view and press "Fit this week".' });
    }

    // --- note mode ---------------------------------------------------
    new Setting(containerEl)
      .setName('Where tasks live')
      .setDesc('Auto prefers the weekly note when it exists and also reads the week’s daily notes.')
      .addDropdown((dd) => {
        dd.addOptions(NOTE_MODE_LABELS);
        dd.setValue(settings.noteMode);
        dd.onChange(async (value) => {
          settings.noteMode = value as NoteMode;
          await save();
        });
      });

    // --- Periodic Notes ------------------------------------------------
    new Setting(containerEl)
      .setName('Defer to Periodic Notes')
      .setDesc('Use the Periodic Notes plugin’s weekly/daily folder and format when it’s installed and enabled.')
      .addToggle((tg) => {
        tg.setValue(settings.usePeriodicNotes);
        tg.onChange(async (value) => {
          settings.usePeriodicNotes = value;
          await save();
        });
      });

    const locations = resolveNoteLocations(this.app, settings);
    const sourceLabel =
      locations.source === 'periodic-notes'
        ? 'Using Periodic Notes’ folder/format.'
        : locations.source === 'daily-notes'
          ? 'Using core Daily Notes’ folder/format (Periodic Notes not supplying this).'
          : 'Using the settings below (no other plugin is supplying a location).';
    new Setting(containerEl).setDesc(sourceLabel);

    const deferring = locations.source !== 'settings';

    // --- weekly note location -------------------------------------------
    new Setting(containerEl)
      .setName('Weekly notes folder')
      .setDisabled(deferring)
      .addText((t) => {
        t.setPlaceholder('Weekly');
        t.setValue(settings.weeklyFolder);
        t.setDisabled(deferring);
        t.onChange(async (value) => {
          settings.weeklyFolder = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Weekly note format')
      .setDesc('A moment.js format, e.g. YYYY-[W]WW.')
      .setDisabled(deferring)
      .addText((t) => {
        t.setPlaceholder('YYYY-[W]WW');
        t.setValue(settings.weeklyFormat);
        t.setDisabled(deferring);
        t.onChange(async (value) => {
          settings.weeklyFormat = value;
          await this.plugin.saveSettings();
        });
      });

    // --- daily note location ---------------------------------------------
    new Setting(containerEl)
      .setName('Daily notes folder')
      .setDisabled(deferring)
      .addText((t) => {
        t.setPlaceholder('');
        t.setValue(settings.dailyFolder);
        t.setDisabled(deferring);
        t.onChange(async (value) => {
          settings.dailyFolder = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Daily note format')
      .setDesc('A moment.js format, e.g. YYYY-MM-DD.')
      .setDisabled(deferring)
      .addText((t) => {
        t.setPlaceholder('YYYY-MM-DD');
        t.setValue(settings.dailyFormat);
        t.setDisabled(deferring);
        t.onChange(async (value) => {
          settings.dailyFormat = value;
          await this.plugin.saveSettings();
        });
      });

    // --- #thisweek sweep scope --------------------------------------
    new Setting(containerEl).setName('#thisweek sweep').setHeading();

    new Setting(containerEl)
      .setName('Folders to scan')
      .setDesc('Comma-separated vault paths. Empty means the whole vault.')
      .addTextArea((t) => {
        t.setValue(settings.taskFolders.join(', '));
        t.onChange(async (value) => {
          settings.taskFolders = splitFolderList(value);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Folders to exclude')
      .setDesc('Comma-separated vault paths, always skipped regardless of the list above.')
      .addTextArea((t) => {
        t.setValue(settings.excludeFolders.join(', '));
        t.onChange(async (value) => {
          settings.excludeFolders = splitFolderList(value);
          await this.plugin.saveSettings();
        });
      });

    // --- Phase 2: the engine's inputs -----------------------------------
    this.renderBlocksSection(containerEl);
    this.renderWindowsSection(containerEl);
    this.renderDurationsSection(containerEl);
  }

  /** Recurring commitments — gym, a stream, a standing meeting. Drawn behind
   *  the grid and subtracted from availability before anything is fitted. */
  private renderBlocksSection(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    new Setting(containerEl).setName('Recurring blocks').setHeading();
    new Setting(containerEl).setDesc(
      'Things that already happen every week. Drawn behind the grid and subtracted from availability before "Fit this week" proposes anything — not editable from the grid itself yet.',
    );

    settings.blocks.forEach((block: SkeletonBlock, i: number) => {
      const row = new Setting(containerEl).setName(block.name || `Block ${i + 1}`);
      const showError = errorSlot(row.settingEl);

      row.addText((t) => {
        t.setPlaceholder('Name');
        t.setValue(block.name);
        t.onChange(async (value) => {
          block.name = value;
          await this.plugin.saveSettings();
        });
      });

      row.addText((t) => {
        t.setPlaceholder('Kind');
        t.setValue(block.kind);
        t.onChange(async (value) => {
          block.kind = value;
          await this.plugin.saveSettings();
        });
      });

      row.addText((t) => {
        t.setPlaceholder('Mon, Wed, Fri');
        t.setValue(fmtDaysList(block.days));
        t.onChange(async (value) => {
          const days = parseDaysList(value);
          if (days == null || days.length === 0) {
            showError('Days: enter at least one of Mon..Sun (or 0-6, comma-separated).');
            return;
          }
          showError(null);
          block.days = days;
          await this.plugin.saveSettings();
        });
      });

      row.addText((t) => {
        t.inputEl.type = 'time';
        t.setValue(fmtHHMM(block.startMin));
        t.onChange(async (value) => {
          const min = parseHHMM(value);
          if (min == null || min >= block.endMin) {
            showError('Start must be a valid time before the end time.');
            return;
          }
          showError(null);
          block.startMin = min;
          await this.plugin.saveSettings();
        });
      });

      row.addText((t) => {
        t.inputEl.type = 'time';
        t.setValue(fmtHHMM(block.endMin));
        t.onChange(async (value) => {
          const min = parseHHMM(value);
          if (min == null || min <= block.startMin) {
            showError('End must be a valid time after the start time.');
            return;
          }
          showError(null);
          block.endMin = min;
          await this.plugin.saveSettings();
        });
      });

      row.addText((t) => {
        t.setPlaceholder('Note (optional)');
        t.setValue(block.note ?? '');
        t.onChange(async (value) => {
          block.note = value || undefined;
          await this.plugin.saveSettings();
        });
      });

      row.addExtraButton((b) => {
        b.setIcon('trash');
        b.setTooltip('Remove this block');
        b.onClick(async () => {
          settings.blocks.splice(i, 1);
          await this.plugin.saveSettings();
          this.display();
        });
      });
    });

    new Setting(containerEl).addButton((b) => {
      b.setButtonText('Add recurring block');
      b.onClick(async () => {
        settings.blocks.push({
          name: 'New block',
          kind: 'block',
          days: [0],
          startMin: 9 * 60,
          endMin: 10 * 60,
        });
        await this.plugin.saveSettings();
        this.display();
      });
    });
  }

  /** When work *could* happen — the time map "Fit this week" places into.
   *  Without at least one window, fitting has nowhere to propose anything. */
  private renderWindowsSection(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    new Setting(containerEl).setName('Availability windows').setHeading();
    new Setting(containerEl).setDesc(
      'When work could happen — not what\'s already booked, but where there\'s room for it. A window\'s name is matched against a #tag on a task (a window named "content" claims a task tagged #content first); an untagged task can land in any window. Without at least one window here, "Fit this week" has nowhere to propose anything.',
    );

    settings.windows.forEach((win: AvailabilityWindow, i: number) => {
      const row = new Setting(containerEl).setName(win.name || `Window ${i + 1}`);
      const showError = errorSlot(row.settingEl);

      row.addText((t) => {
        t.setPlaceholder('Name (matches a #tag)');
        t.setValue(win.name);
        t.onChange(async (value) => {
          const name = value.trim().toLowerCase();
          if (!name) {
            showError('Name can’t be empty.');
            return;
          }
          showError(null);
          win.name = name;
          await this.plugin.saveSettings();
        });
      });

      row.addText((t) => {
        t.setPlaceholder('Mon, Tue, Wed');
        t.setValue(fmtDaysList(win.days));
        t.onChange(async (value) => {
          const days = parseDaysList(value);
          if (days == null || days.length === 0) {
            showError('Days: enter at least one of Mon..Sun (or 0-6, comma-separated).');
            return;
          }
          showError(null);
          win.days = days;
          await this.plugin.saveSettings();
        });
      });

      row.addText((t) => {
        t.inputEl.type = 'time';
        t.setValue(fmtHHMM(win.startMin));
        t.onChange(async (value) => {
          const min = parseHHMM(value);
          if (min == null || min >= win.endMin) {
            showError('Start must be a valid time before the end time.');
            return;
          }
          showError(null);
          win.startMin = min;
          await this.plugin.saveSettings();
        });
      });

      row.addText((t) => {
        t.inputEl.type = 'time';
        t.setValue(fmtHHMM(win.endMin));
        t.onChange(async (value) => {
          const min = parseHHMM(value);
          if (min == null || min <= win.startMin) {
            showError('End must be a valid time after the start time.');
            return;
          }
          showError(null);
          win.endMin = min;
          await this.plugin.saveSettings();
        });
      });

      row.addText((t) => {
        t.setPlaceholder('Min block (mins)');
        t.inputEl.type = 'number';
        t.inputEl.min = '0';
        t.setValue(String(win.minBlockMin));
        t.onChange(async (value) => {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0) {
            showError('Minimum block must be zero or a positive number of minutes.');
            return;
          }
          showError(null);
          win.minBlockMin = Math.round(n);
          await this.plugin.saveSettings();
        });
      });

      row.addExtraButton((b) => {
        b.setIcon('trash');
        b.setTooltip('Remove this window');
        b.onClick(async () => {
          settings.windows.splice(i, 1);
          await this.plugin.saveSettings();
          this.display();
        });
      });
    });

    new Setting(containerEl).addButton((b) => {
      b.setButtonText('Add availability window');
      b.onClick(async () => {
        settings.windows.push({
          name: 'work',
          days: [0, 1, 2, 3, 4],
          startMin: 9 * 60,
          endMin: 17 * 60,
          minBlockMin: 30,
        });
        await this.plugin.saveSettings();
        this.display();
      });
    });
  }

  /** The duration ladder's rung A. This is the adoption feature: it's what
   *  makes the plugin work on a vault where nothing is annotated — a plain
   *  `- [ ] Book dentist` still gets a sensible size, via its #tag or the
   *  global fallback, with no estimate ever typed by hand. */
  private renderDurationsSection(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    new Setting(containerEl).setName('Durations by tag').setHeading();
    new Setting(containerEl).setDesc(
      'How long an un-annotated task takes, by its #tag. This is what makes Weekfit work on a vault where nothing is annotated: every task is sized by a ladder — an estimate written on the line itself, beats its #tag’s default below, beats the global fallback — so nothing needs a hand-typed estimate to be fitted.',
    );

    new Setting(containerEl)
      .setName('Global fallback')
      .setDesc('Used when a task has no estimate and no #tag that matches a row below.')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.inputEl.min = '1';
        t.setValue(String(settings.durations.defaultMinutes));
        t.onChange(async (value) => {
          const n = Number(value);
          if (!Number.isFinite(n) || n <= 0) return;
          settings.durations.defaultMinutes = Math.round(n);
          await this.plugin.saveSettings();
        });
      });

    for (const [kind, minutes] of Object.entries(settings.durations.byKind)) {
      const row = new Setting(containerEl);
      const showError = errorSlot(row.settingEl);

      row.addText((t) => {
        t.setPlaceholder('#tag');
        t.setValue(kind);
        let pending = kind;
        t.onChange((value) => {
          pending = value;
        });
        t.inputEl.addEventListener('blur', () => {
          void (async () => {
            const key = pending.trim().toLowerCase().replace(/^#/, '');
            if (!key || key === kind) {
              showError(null);
              t.setValue(kind);
              return;
            }
            if (key in settings.durations.byKind) {
              showError('That tag already has a default.');
              t.setValue(kind);
              return;
            }
            showError(null);
            const value = settings.durations.byKind[kind];
            delete settings.durations.byKind[kind];
            settings.durations.byKind[key] = value;
            await this.plugin.saveSettings();
            this.display();
          })();
        });
      });

      row.addText((t) => {
        t.inputEl.type = 'number';
        t.inputEl.min = '1';
        t.setValue(String(minutes));
        t.onChange(async (value) => {
          const n = Number(value);
          if (!Number.isFinite(n) || n <= 0) {
            showError('Minutes must be a positive number.');
            return;
          }
          showError(null);
          settings.durations.byKind[kind] = Math.round(n);
          await this.plugin.saveSettings();
        });
      });

      row.addExtraButton((b) => {
        b.setIcon('trash');
        b.setTooltip('Remove this default');
        b.onClick(async () => {
          delete settings.durations.byKind[kind];
          await this.plugin.saveSettings();
          this.display();
        });
      });
    }

    new Setting(containerEl).addButton((b) => {
      b.setButtonText('Add tag default');
      b.onClick(async () => {
        let key = 'tag';
        let n = 1;
        while (key in settings.durations.byKind) key = `tag${n++}`;
        settings.durations.byKind[key] = 60;
        await this.plugin.saveSettings();
        this.display();
      });
    });
  }
}

function splitFolderList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

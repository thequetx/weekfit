// The summary shown after "Refresh calendar feed" finds something worth a
// decision. Mirrors `ReviewModal.ts` in structure, lifecycle and styling
// hooks — a plain Obsidian `Modal`/`Setting` tree, no React, taking its data
// and its one action as constructor callbacks rather than importing
// `writer.ts`/`icsState.ts`/`main.ts` directly. It is `.ts`, not `.tsx`, for
// the same reason `ReviewModal.ts` and `CaptureModal.ts` already are — every
// modal in this plugin is `Modal`/`Setting`, and pulling React in for a list
// of rows with checkboxes would be cost with no benefit.
//
// One divergence from `ReviewModal.ts`'s own shape, deliberately: that modal
// renders its own inline "what happened" summary (`summarize`/`renderResult`)
// because it stays open afterwards for a second action (roll forward). This
// modal closes once applied, and the spec is explicit that a `line-changed`
// skip — the user having hand-edited a task since the vault was last read —
// "must be visible to the user, not swallowed" (Verification Test 3). The
// plugin's one already-built, already-tested place that happens is
// `WriteResultNotice.tsx` on the week view itself, with its full
// `SKIP_REASON_TEXT` wording — so `main.ts`'s `onApply` sets `this.lastWrite`
// to the aggregated result and refreshes, and that component shows it, rather
// than this file growing a second copy of the same reason-text mapping.

import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { IcsDelta, WriteResult } from '../data/contract';
import { DAY_NAMES } from '../lib/week';

/** Which rows are ticked when "Apply selected" is pressed. */
export interface IcsRefreshSelection {
  /** uids from `delta.updated` to apply. */
  updatedUids: Set<string>;
  /** uids from `delta.removed` to untrack. */
  removedUids: Set<string>;
}

export interface IcsRefreshModalOptions {
  delta: IcsDelta;
  /**
   * Applies whichever rows are checked and returns the *aggregated*
   * `WriteResult` (one call already merged `updateIcsTaskRanges`'s and
   * `clearIcsUidMarkers`'s per-link arrays — see `main.ts`). Expected to also
   * persist `nextIcsState(...)` and refresh the view; this file never touches
   * either, the same division `ReviewModal`'s `onWriteReview`/`onRollForward`
   * callbacks already draw.
   */
  onApply: (selection: IcsRefreshSelection) => Promise<WriteResult>;
}

/** `2026-09-01T10:00:00.000Z` -> `Mon 10:00` — day abbreviation plus 24-hour
 *  clock, matching the spec's own example literally rather than this
 *  codebase's usual `am`/`pm` (`fmtClock`/`fmtMinutes` in `lib/week.ts`),
 *  which reads worse squeezed next to an arrow (`Mon 10am → Tue 11am`). */
function fmtDayTime(iso: string): string {
  const d = new Date(iso);
  const dow = DAY_NAMES[(d.getDay() + 6) % 7];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dow} ${hh}:${mm}`;
}

/**
 * The move shown under an updated row's title.
 *
 * `oldStart`/`oldEnd` are `''` when this is the first refresh since the
 * marker existed (`icsState.ts`'s `deltaIcsEvents`: `prevSnap` absent) — there
 * is no "before" to show an arrow from, so this says so plainly rather than
 * printing an arrow out of an empty string.
 */
function fmtMove(u: IcsDelta['updated'][number]): string {
  const next = fmtDayTime(u.newStart);
  if (!u.oldStart) return `newly tracked — ${next}`;
  const prev = fmtDayTime(u.oldStart);
  return prev === next ? next : `${prev} → ${next}`;
}

export class IcsRefreshModal extends Modal {
  private readonly opts: IcsRefreshModalOptions;
  /** Checked by default (spec §2.6/§2.7) — see the class doc comment below
   *  for why that collapses the spec's two-button pair into one control. */
  private readonly updatedChecked: Map<string, boolean>;
  private readonly removedChecked: Map<string, boolean>;
  private busy = false;

  constructor(app: App, opts: IcsRefreshModalOptions) {
    super(app);
    this.opts = opts;
    this.updatedChecked = new Map(opts.delta.updated.map((u) => [u.uid, true]));
    this.removedChecked = new Map(opts.delta.removed.map((r) => [r.uid, true]));
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const { delta } = this.opts;

    this.setTitle('Calendar refresh');

    contentEl.createEl('p', {
      text: `${delta.unchanged.length} event${delta.unchanged.length === 1 ? '' : 's'} unchanged.`,
    });

    // Every row's checkbox starts ticked, so "Apply selected" with nothing
    // touched *is* "update everything" — the spec's `[Update all]` — while
    // unticking a row before pressing it *is* "review each" for just that
    // one, with no second screen to switch into. One control, both jobs.
    if (delta.updated.length > 0) {
      contentEl.createEl('h4', { text: `Updated (${delta.updated.length})` });
      for (const u of delta.updated) {
        const title = u.newTitle || u.title || '(untitled)';
        const desc =
          u.title && u.newTitle && u.title !== u.newTitle
            ? `${fmtMove(u)} — retitled in the feed to "${u.newTitle}"; the task's own title is left as it is`
            : fmtMove(u);
        new Setting(contentEl)
          .setName(title)
          .setDesc(desc)
          .addToggle((tg) => {
            tg.setValue(true);
            tg.onChange((v) => this.updatedChecked.set(u.uid, v));
          });
      }
    }

    if (delta.removed.length > 0) {
      contentEl.createEl('h4', { text: `No longer in the feed (${delta.removed.length})` });
      for (const r of delta.removed) {
        new Setting(contentEl)
          .setName(r.title || '(untitled)')
          .setDesc('The task stays; tracking stops.')
          .addToggle((tg) => {
            tg.setValue(true);
            tg.onChange((v) => this.removedChecked.set(r.uid, v));
          });
      }
    }

    if (delta.updated.length === 0 && delta.removed.length === 0) {
      contentEl.createEl('p', { text: 'Nothing changed enough to review.' });
    }

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('Apply selected')
          .setCta()
          .onClick(() => void this.apply()),
      )
      .addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async apply(): Promise<void> {
    if (this.busy) return; // guards a double-click mid-write
    this.busy = true;
    try {
      const updatedUids = new Set(
        [...this.updatedChecked].filter(([, checked]) => checked).map(([uid]) => uid),
      );
      const removedUids = new Set(
        [...this.removedChecked].filter(([, checked]) => checked).map(([uid]) => uid),
      );
      const result = await this.opts.onApply({ updatedUids, removedUids });
      // A short confirmation here; the detailed breakdown (skips, errors —
      // see the file's own header comment) lives in the week view via
      // `main.ts` setting `lastWrite`, not duplicated in this Notice.
      const parts = [`Weekfit: calendar sync applied — ${result.written} written`];
      if (result.skipped.length) parts.push(`${result.skipped.length} skipped`);
      if (result.errors.length) parts.push(`${result.errors.length} error(s)`);
      new Notice(parts.join(', '));
      this.close();
    } finally {
      this.busy = false;
    }
  }
}

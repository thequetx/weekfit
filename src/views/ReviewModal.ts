// The weekly review, surfaced. Everything about *what* gets computed and
// written lives in `src/data/review.ts` (`computeReview` / `writeReview` /
// `rollForward`); this file is only the native Obsidian chrome around it —
// same split `CaptureModal.ts` already draws for capture.
//
// Both actions are explicit button presses. Neither fires on open, on close,
// or on a timer: a review is a judgement about a week that just ended, and
// silently mutating the note the moment this modal appears would be exactly
// the kind of surprise Tyler's own vault convention warns about (a file
// watcher picks up every write in under a second — a half-written note is a
// visible flicker on his desktop, not a private draft).
//
// Built entirely from Obsidian's own `Modal`/`Setting`, so it matches the
// active theme without a line of custom CSS, and takes its data and its two
// actions as constructor callbacks rather than importing `review.ts` or
// `main.ts` directly — the same reasoning `CaptureModal` gives for its own
// `write` callback: this file never needs `app`, a `WeekSnapshot`, or plugin
// settings to be testable, only two functions that resolve to a `WriteResult`.

import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { WriteResult } from '../data/contract';
import type { WeekReview } from '../data/review';
import { fmtAuditRow, topAuditRows } from '../lib/audit';
import { fmtHours } from '../lib/duration';
import { taskTitle } from '../lib/taskmeta';

export interface ReviewModalOptions {
  review: WeekReview;
  /** Vault-relative path of the week `onRollForward` would carry unfinished
   *  tasks into — named up front so the preview can say exactly where they're
   *  going before anything moves. */
  nextWeekPath: string;
  /** Appends this week's audit summary under `## Review` and sets its
   *  frontmatter. Expected to wrap `writeReview(app, snapshot, review,
   *  settings)` — this file never calls it directly. */
  onWriteReview: () => Promise<WriteResult>;
  /** Moves `review.unfinished` into `nextWeekPath`. Expected to wrap
   *  `rollForward(app, snapshot, review, nextWeekPath, settings)`. */
  onRollForward: () => Promise<WriteResult>;
}

/** `WriteResult` -> a one-line summary and the detail worth showing under it.
 *  Shared by both actions so "what happened" reads the same way regardless of
 *  which button was pressed. */
function summarize(result: WriteResult, verb: string): { headline: string; detail: string[] } {
  const detail: string[] = [];
  if (result.skipped.length > 0) {
    detail.push(
      `${result.skipped.length} line${result.skipped.length === 1 ? '' : 's'} changed since this ` +
        `review was opened and ${result.skipped.length === 1 ? 'was' : 'were'} left alone: ` +
        result.skipped.map((s) => `${s.title} (${s.reason})`).join(', '),
    );
  }
  if (result.errors.length > 0) {
    detail.push(...result.errors);
  }
  const headline =
    result.errors.length > 0
      ? `${verb} — ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}`
      : result.skipped.length > 0
        ? `${verb}, ${result.skipped.length} skipped`
        : `${verb}.`;
  return { headline, detail };
}

export class ReviewModal extends Modal {
  private readonly opts: ReviewModalOptions;
  private busy = false;
  private resultEl: HTMLElement | null = null;
  private rollButton: { setDisabled(v: boolean): unknown } | null = null;

  constructor(app: App, opts: ReviewModalOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const { review, nextWeekPath } = this.opts;

    this.setTitle(`Review ${review.weekId}`);

    new Setting(contentEl)
      .setName('Intentions')
      .setDesc(`${review.intentionsDone} / ${review.intentionsTotal} done`);
    new Setting(contentEl).setName('Tasks').setDesc(`${review.tasksDone} / ${review.tasksTotal} done`);
    new Setting(contentEl)
      .setName('Hours')
      .setDesc(`${fmtHours(review.hoursKept * 60)} kept of ${fmtHours(review.hoursPlanned * 60)} planned`);

    const rows = topAuditRows(review.audit);
    if (rows.length > 0) {
      contentEl.createEl('h4', { text: 'By category' });
      const list = contentEl.createEl('ul');
      for (const row of rows) {
        list.createEl('li', { text: fmtAuditRow(row) });
      }
    }

    // Reviewing mid-week is legitimate, but rolling forward then means
    // something different, and the button looks identical either way. Say so.
    if (!review.weekHasEnded) {
      contentEl.createEl('p', {
        cls: 'mod-warning',
        text:
          'This week is not over yet. Anything still scheduled later in the week is left ' +
          'where it is — only work that has already been and gone, or was never scheduled ' +
          'at all, is listed below.',
      });
    }

    contentEl.createEl('h4', { text: `Unfinished (${review.unfinished.length})` });
    if (review.unfinished.length > 0) {
      const list = contentEl.createEl('ul');
      for (const t of review.unfinished) {
        list.createEl('li', { text: taskTitle(t.text) });
      }
      // Name the target and the count before anything moves — pressing the
      // button below is the only way this ever happens.
      contentEl.createEl('p', {
        text: `Roll forward moves ${review.unfinished.length} task${
          review.unfinished.length === 1 ? '' : 's'
        } to ${nextWeekPath}.`,
      });
    } else {
      contentEl.createEl('p', { text: 'Nothing unfinished to roll forward.' });
    }

    this.resultEl = contentEl.createDiv();

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('Write review')
          .setCta()
          .onClick(() => void this.run('write', this.opts.onWriteReview)),
      )
      .addButton((btn) => {
        this.rollButton = btn;
        btn
          .setButtonText('Roll forward to next week')
          .setDisabled(review.unfinished.length === 0)
          .onClick(() => void this.run('roll', this.opts.onRollForward));
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resultEl = null;
    this.rollButton = null;
  }

  private async run(kind: 'write' | 'roll', action: () => Promise<WriteResult>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await action();
      this.renderResult(result, kind === 'write' ? 'Review saved' : 'Rolled forward');
      if (kind === 'roll' && result.errors.length === 0) {
        // Whatever moved is gone from `review.unfinished`'s source lines now;
        // rolling again in the same open modal would re-carry only what
        // `removeLines` actually skipped, which the result list above already
        // names. Disabling avoids a confusing second click before the modal
        // is reopened against a fresh review.
        this.rollButton?.setDisabled(true);
      }
    } finally {
      this.busy = false;
    }
  }

  private renderResult(result: WriteResult, verb: string): void {
    const { headline, detail } = summarize(result, verb);
    new Notice(`Weekfit: ${headline}`);

    const el = this.resultEl;
    if (!el) return;
    el.empty();
    el.createEl('p', { text: `${headline} (${result.written} written)` });
    if (detail.length > 0) {
      const list = el.createEl('ul');
      for (const line of detail) {
        list.createEl('li', { text: line });
      }
    }
  }
}

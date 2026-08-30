// "Pick a date…" — the escape hatch behind the due-date menu's four relative
// choices, for a deadline further out than next week.
//
// Obsidian ships no date picker, so this is the platform's own
// `<input type="date">`: it comes with a calendar popover, keyboard entry,
// and the user's locale for free, none of which is worth reimplementing. It
// is styled with Obsidian's variables rather than left at browser defaults,
// which in Electron look nothing like the rest of the app.
//
// Same shape as `CaptureModal`: the write is a constructor callback, so this
// file never imports the writer and cannot grow a second write path.

import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';

export interface DueDateModalOptions {
  /** Shown in the heading so it is obvious which task is being changed. */
  title: string;
  /** The date already on the line, `YYYY-MM-DD`, or null. Pre-fills the field
   *  so re-opening to nudge a date by a day is not a retype. */
  current: string | null;
  /** Called with the chosen date, or `null` to clear it. Not called at all if
   *  the modal is dismissed — cancelling must never write. */
  onPick: (date: string | null) => void;
}

/** The browser accepts partial input while typing; only a full ISO date is a
 *  date. Matches the shape `taskmeta.ts` parses. */
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export class DueDateModal extends Modal {
  private readonly opts: DueDateModalOptions;
  private value: string;

  constructor(app: App, opts: DueDateModalOptions) {
    super(app);
    this.opts = opts;
    this.value = opts.current ?? '';
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText('Due date');

    contentEl.createEl('p', {
      text: this.opts.title,
      cls: 'weekfit-duemodal__task',
    });

    let input: HTMLInputElement | null = null;

    new Setting(contentEl).setName('Date').addText((text) => {
      input = text.inputEl;
      input.type = 'date';
      input.value = this.value;
      text.onChange((v) => {
        this.value = v;
      });
      // Enter submits, the same as every other single-field modal here.
      input.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.submit();
        }
      });
    });

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText('Set')
          .setCta()
          .onClick(() => this.submit()),
      )
      .addButton((b) =>
        b
          // Only offered when there is something to remove — a "Clear" that
          // does nothing is a button that makes you wonder what it did.
          .setButtonText(this.opts.current ? 'Clear' : 'Cancel')
          .onClick(() => {
            if (this.opts.current) this.opts.onPick(null);
            this.close();
          }),
      );

    // A date field opened to be filled in should be ready to type into.
    window.setTimeout(() => input?.focus(), 0);
  }

  private submit(): void {
    const value = this.value.trim();
    // An unparseable value is not written. The field can hold a half-typed
    // date, and writing one produces a line whose due date the reader
    // silently discards — the task then looks dated and plans as undated.
    if (value === '') {
      if (this.opts.current) this.opts.onPick(null);
      this.close();
      return;
    }
    if (!ISO.test(value)) return;
    this.opts.onPick(value);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

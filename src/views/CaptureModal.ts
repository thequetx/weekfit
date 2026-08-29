// Quick capture: one line, one keystroke to submit, gone before the thing
// that prompted it is forgotten. Everything about *what* gets written is
// `buildCaptureLine` (`src/data/backlog.ts`) — this file is only the native
// Obsidian chrome around it, plus the plumbing to actually land the line.
//
// The target path and the write itself are constructor callbacks rather than
// direct imports of plugin internals (`main.ts`, `writer.ts`) — the modal
// never needs to know how "the current week's note" is resolved, or that
// `appendUnderHeading` is the vault's one write path. That keeps this file
// testable without an Obsidian runtime *and* without a plugin instance: swap
// in a fake `getTargetPath`/`write` pair and nothing else here has to change.

import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { WriteResult } from '../data/contract';
import { buildCaptureLine } from '../data/backlog';

export interface CaptureModalOptions {
  /** Resolves the vault-relative path to capture into — the current week's
   *  note. A callback (not a plain string) so it's asked fresh at submit
   *  time rather than baked in when the modal was opened. */
  getTargetPath: () => string;
  /**
   * Performs the write. The caller is expected to wrap
   * `appendUnderHeading(app, [{ file: path, heading: 'Tasks', lines: [line] }])`
   * — the only function in this plugin allowed to touch the vault — but this
   * file never imports it directly, so nothing here can grow a second write
   * path by accident.
   */
  write: (path: string, line: string) => Promise<WriteResult>;
}

/**
 * A single-field modal: type a line, hit Enter, it's on the week's task list.
 * Built entirely from Obsidian's own `Modal`/`Setting` so it matches the
 * theme (light or dark) without a line of custom CSS.
 */
export class CaptureModal extends Modal {
  private readonly opts: CaptureModalOptions;
  private value = '';
  private submitting = false;

  constructor(app: App, opts: CaptureModalOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle('Capture a task');

    let inputEl: HTMLInputElement | undefined;

    new Setting(contentEl).setName('Task').addText((text) => {
      inputEl = text.inputEl;
      text.setPlaceholder("What's on your mind?");
      text.onChange((v) => {
        this.value = v;
      });
      text.inputEl.addEventListener('keydown', (evt: KeyboardEvent) => {
        if (evt.key === 'Enter') {
          evt.preventDefault();
          void this.submit();
        }
        // Escape isn't handled here: Modal's own Scope already closes the
        // modal on Escape, and re-registering it here would only risk a
        // double-close.
      });
    });

    // Focus in the field on open. Obsidian mounts the modal into the DOM
    // synchronously but the entrance animation can still steal focus on the
    // very next tick on some platforms, so this is deferred one macrotask
    // rather than called inline.
    window.setTimeout(() => inputEl?.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    if (this.submitting) return; // guards a double-Enter mid-write
    const line = buildCaptureLine(this.value);
    if (line === null) {
      // Silent no-op, same as Escape — a capture with nothing in it isn't a
      // mistake worth a Notice over.
      this.close();
      return;
    }

    this.submitting = true;
    const path = this.opts.getTargetPath();
    try {
      const result = await this.opts.write(path, line);
      if (result.errors.length > 0) {
        // A capture that silently goes nowhere is worse than an error.
        new Notice(`Weekfit: couldn't capture — ${result.errors[0]}`);
      } else {
        new Notice(`Weekfit: captured to ${path}`);
      }
    } finally {
      this.submitting = false;
    }
    this.close();
  }
}

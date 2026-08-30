/**
 * A lifeline.
 *
 * Weekfit writes to notes the moment you accept, drag, tick, split or roll
 * forward. Obsidian's own undo works inside a file you happen to have open,
 * but roll-forward touches two files at once and none of them may be open —
 * so without this, a mistake is only recoverable by retyping.
 *
 * One entry is **one thing the user did**, not one file and not one line: a
 * roll-forward that moves seven tasks between two notes undoes as a single
 * step, which is the only reading of it that makes sense.
 *
 * Two deliberate limits, both worth stating rather than hiding:
 *
 *  - **It refuses rather than clobbers.** If a file changed after Weekfit
 *    wrote it — you edited the note, another plugin did, a sync landed — that
 *    file is left exactly as it is and the user is told. Restoring would throw
 *    away work Weekfit knows nothing about, which is a worse failure than the
 *    one undo exists to fix. Same discipline the writer already holds to.
 *  - **It lives for the session.** Nothing is persisted, so a reload clears
 *    it. Persisting would mean offering to restore a file against a snapshot
 *    taken who-knows-when, and an undo you cannot trust is worse than none.
 */
import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { FileChange } from './journal';

export interface UndoEntry {
  /** What the user did, in their words — shown when it is undone. */
  label: string;
  at: number;
  changes: FileChange[];
}

export interface UndoResult {
  label: string;
  restored: number;
  /** Files left alone because they changed after we wrote them. */
  refused: string[];
  errors: string[];
}

/** Deep enough to cover a bad afternoon, shallow enough that the oldest entry
 *  is still something the user might remember doing. */
const DEPTH = 10;

export class UndoStack {
  private entries: UndoEntry[] = [];

  push(label: string, changes: FileChange[]): void {
    // An operation that wrote nothing — every edit refused, say — is not a
    // step anyone would want to undo, and putting it on the stack would push
    // a real one off the end.
    if (changes.length === 0) return;
    this.entries.push({ label, at: Date.now(), changes });
    if (this.entries.length > DEPTH) this.entries.shift();
  }

  /** What the next undo would put back, for a menu label or a confirmation. */
  peek(): UndoEntry | null {
    return this.entries[this.entries.length - 1] ?? null;
  }

  get depth(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }

  /**
   * Put the last operation back.
   *
   * Files are restored in reverse order, and each is checked against what
   * Weekfit left there before anything is written. A file that has moved on
   * is reported, not overwritten.
   */
  async undo(app: App): Promise<UndoResult | null> {
    const entry = this.entries.pop();
    if (!entry) return null;

    const refused: string[] = [];
    const errors: string[] = [];
    let restored = 0;

    for (const change of [...entry.changes].reverse()) {
      try {
        const file = app.vault.getAbstractFileByPath(change.path);

        // We created it. Undoing means it should not be there — but it goes
        // to Obsidian's trash rather than being destroyed, because "undo"
        // should never be the most destructive thing in the app.
        if (change.before == null) {
          if (file instanceof TFile) {
            const current = await app.vault.cachedRead(file);
            if (current !== change.after) {
              refused.push(change.path);
              continue;
            }
            await app.fileManager.trashFile(file);
            restored++;
          }
          continue;
        }

        if (!(file instanceof TFile)) {
          refused.push(change.path);
          continue;
        }

        const current = await app.vault.cachedRead(file);
        if (current !== change.after) {
          refused.push(change.path);
          continue;
        }

        await app.vault.process(file, () => change.before as string);
        restored++;
      } catch (err) {
        errors.push(`${change.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { label: entry.label, restored, refused, errors };
  }
}

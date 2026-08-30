/**
 * What a Weekfit operation did to the vault, so it can be put back.
 *
 * Everything this plugin writes goes through `writer.ts`, which is what makes
 * an undo tractable at all: there is exactly one layer to record at. Rather
 * than computing an inverse for each operation — a per-operation inverse is
 * more code and more ways to be subtly wrong — this records the **whole
 * content of every file touched, before and after**. Restoring is then the
 * same operation regardless of whether the change was a placement, a tick, a
 * split, or a roll-forward moving lines between two files at once.
 *
 * The cost is memory proportional to the notes touched. These are markdown
 * files a person reads, so that is a rounding error.
 */

/** One file, as it was and as we left it. `before: null` means we created it. */
export interface FileChange {
  path: string;
  before: string | null;
  after: string;
}

/**
 * Recording is opt-in and scoped: `main.ts` opens a journal around a user
 * action, so one undo step is one thing the user did — not one file, and not
 * one line. A batch that touches four files is still a single undo.
 */
let active: FileChange[] | null = null;

export function beginJournal(): void {
  active = [];
}

/** Stop recording and hand back what happened, oldest first. */
export function endJournal(): FileChange[] {
  const out = active ?? [];
  active = null;
  return out;
}

export function isJournalling(): boolean {
  return active != null;
}

/**
 * Record one file's change.
 *
 * Repeated writes to the same file inside one action are collapsed: the
 * earliest `before` is the one worth keeping (it is the state to return to)
 * and the latest `after` is what is actually on disk now.
 */
export function record(path: string, before: string | null, after: string): void {
  if (!active) return;
  // A write that changed nothing is not a step anyone would undo. This happens
  // routinely: `vault.process` still opens and rewrites the file even when
  // every edit in the batch was refused, and recording that would let a no-op
  // push a real step off the end of the stack.
  if (before === after) return;
  const existing = active.find((c) => c.path === path);
  if (existing) {
    existing.after = after;
    return;
  }
  active.push({ path, before, after });
}

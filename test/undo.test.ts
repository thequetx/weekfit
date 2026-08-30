import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
  class TFile {
    path: string;
    constructor(p: string) {
      this.path = p;
    }
  }
  return { TFile };
});

const { UndoStack } = await import('../src/data/undo');
const { beginJournal, endJournal } = await import('../src/data/journal');
const { editPlacements, setTaskDone, appendUnderHeading } = await import('../src/data/writer');
const { TFile } = (await import('obsidian')) as unknown as { TFile: new (p: string) => any };

class FakeVault {
  files = new Map<string, string>();
  trashed: string[] = [];
  seed(p: string, c: string) {
    this.files.set(p, c);
  }
  getAbstractFileByPath(p: string) {
    return this.files.has(p) ? new TFile(p) : null;
  }
  async cachedRead(f: { path: string }) {
    const d = this.files.get(f.path);
    if (d == null) throw new Error('missing');
    return d;
  }
  async process(f: { path: string }, fn: (d: string) => string) {
    const d = this.files.get(f.path);
    if (d == null) throw new Error('missing');
    const r = fn(d);
    this.files.set(f.path, r);
    return r;
  }
  async create(p: string, c: string) {
    this.files.set(p, c);
    return new TFile(p);
  }
}

function makeApp() {
  const vault = new FakeVault();
  const app = {
    vault,
    fileManager: {
      trashFile: async (f: { path: string }) => {
        vault.trashed.push(f.path);
        vault.files.delete(f.path);
      },
    },
  } as any;
  return { app, vault };
}

const NOTE = 'Weekly/2026-W36.md';
const NEXT = 'Weekly/2026-W37.md';
const ORIGINAL = ['## Tasks', '', '- [ ] Book dentist', '- [ ] Other', ''].join('\n');

/** Run a write with the journal open, exactly as `main.ts` does. */
async function act<T>(stack: InstanceType<typeof UndoStack>, label: string, fn: () => Promise<T>) {
  beginJournal();
  try {
    return await fn();
  } finally {
    stack.push(label, endJournal());
  }
}

describe('undo — the lifeline', () => {
  it('puts a placement back exactly as it was', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, ORIGINAL);
    const stack = new UndoStack();

    await act(stack, 'Accept a placement', () =>
      editPlacements(app, [
        {
          file: NOTE,
          line: 2,
          expectedText: '- [ ] Book dentist',
          range: '09:00 - 10:00',
          scheduledDate: '2026-09-01',
          title: 'Book dentist',
        },
      ]),
    );
    expect(vault.files.get(NOTE)).not.toBe(ORIGINAL);

    const result = await stack.undo(app);
    expect(result!.label).toBe('Accept a placement');
    expect(result!.refused).toEqual([]);
    // Byte-for-byte, not approximately.
    expect(vault.files.get(NOTE)).toBe(ORIGINAL);
  });

  it('undoes a tick, completion stamp and all', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, ORIGINAL);
    const stack = new UndoStack();

    await act(stack, 'Mark done', () =>
      setTaskDone(app, [
        { file: NOTE, line: 2, expectedText: '- [ ] Book dentist', title: 'x', done: true },
      ]),
    );
    expect(vault.files.get(NOTE)).toContain('- [x]');

    await stack.undo(app);
    expect(vault.files.get(NOTE)).toBe(ORIGINAL);
  });

  // The case Obsidian's own undo cannot cover: two files, neither necessarily
  // open. This is the reason the feature exists.
  it('undoes a multi-file change as one step', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, ORIGINAL);
    const nextBefore = ['## Tasks', '', ''].join('\n');
    vault.seed(NEXT, nextBefore);
    const stack = new UndoStack();

    await act(stack, 'Roll 1 task forward', async () => {
      await appendUnderHeading(app, [
        { file: NEXT, heading: 'Tasks', lines: ['- [ ] Book dentist'] },
      ]);
      return editPlacements(app, [
        {
          file: NOTE,
          line: 2,
          expectedText: '- [ ] Book dentist',
          range: '09:00 - 10:00',
          scheduledDate: null,
          title: 'x',
        },
      ]);
    });

    expect(vault.files.get(NEXT)).toContain('Book dentist');
    const r = await stack.undo(app);
    expect(r!.restored).toBe(2);
    expect(vault.files.get(NOTE)).toBe(ORIGINAL);
    expect(vault.files.get(NEXT)).toBe(nextBefore);
  });

  // The property that stops undo being more dangerous than the mistake.
  it('refuses a file that changed after Weekfit wrote it, and says which', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, ORIGINAL);
    const stack = new UndoStack();

    await act(stack, 'Accept a placement', () =>
      editPlacements(app, [
        {
          file: NOTE,
          line: 2,
          expectedText: '- [ ] Book dentist',
          range: '09:00 - 10:00',
          scheduledDate: null,
          title: 'x',
        },
      ]),
    );

    // The user edits the note afterwards.
    const edited = (vault.files.get(NOTE) as string) + '- [ ] Something I typed\n';
    vault.files.set(NOTE, edited);

    const r = await stack.undo(app);
    expect(r!.restored).toBe(0);
    expect(r!.refused).toEqual([NOTE]);
    // Their work is untouched.
    expect(vault.files.get(NOTE)).toBe(edited);
  });

  it('trashes a file it created rather than destroying it', async () => {
    const { app, vault } = makeApp();
    const stack = new UndoStack();

    await act(stack, "Create this week's note", () =>
      appendUnderHeading(app, [{ file: NEXT, heading: 'Tasks', lines: ['- [ ] Seeded'] }]),
    );
    expect(vault.files.has(NEXT)).toBe(true);

    await stack.undo(app);
    expect(vault.files.has(NEXT)).toBe(false);
    // Recoverable, not gone.
    expect(vault.trashed).toEqual([NEXT]);
  });

  it('undoes several steps in reverse order', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, ORIGINAL);
    const stack = new UndoStack();

    await act(stack, 'first', () =>
      setTaskDone(app, [
        { file: NOTE, line: 2, expectedText: '- [ ] Book dentist', title: 'x', done: true },
      ]),
    );
    const afterFirst = vault.files.get(NOTE) as string;
    await act(stack, 'second', () =>
      setTaskDone(app, [
        { file: NOTE, line: 3, expectedText: '- [ ] Other', title: 'y', done: true },
      ]),
    );

    expect((await stack.undo(app))!.label).toBe('second');
    expect(vault.files.get(NOTE)).toBe(afterFirst);
    expect((await stack.undo(app))!.label).toBe('first');
    expect(vault.files.get(NOTE)).toBe(ORIGINAL);
  });

  it('has nothing to undo once it is empty', async () => {
    const { app } = makeApp();
    const stack = new UndoStack();
    expect(stack.peek()).toBeNull();
    expect(await stack.undo(app)).toBeNull();
  });

  // A write where every edit was refused changed nothing, so it must not
  // occupy a slot and push a real step off the end of the stack.
  it('does not record an operation that wrote nothing', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, ORIGINAL);
    const stack = new UndoStack();

    await act(stack, 'Accept a placement', () =>
      editPlacements(app, [
        {
          file: NOTE,
          line: 2,
          expectedText: '- [ ] Something that is not there',
          range: '09:00 - 10:00',
          scheduledDate: null,
          title: 'x',
        },
      ]),
    );

    expect(stack.depth).toBe(0);
  });

  it('collapses repeated writes to one file into a single before/after', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, ORIGINAL);
    const stack = new UndoStack();

    await act(stack, 'two edits, one file', async () => {
      await setTaskDone(app, [
        { file: NOTE, line: 2, expectedText: '- [ ] Book dentist', title: 'x', done: true },
      ]);
      return setTaskDone(app, [
        { file: NOTE, line: 3, expectedText: '- [ ] Other', title: 'y', done: true },
      ]);
    });

    expect(stack.peek()!.changes).toHaveLength(1);
    await stack.undo(app);
    expect(vault.files.get(NOTE)).toBe(ORIGINAL);
  });
});

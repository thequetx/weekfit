import { describe, expect, it, vi } from 'vitest';

// Same `obsidian` mock and fake vault as test/writer.test.ts — kept in its own
// file rather than appended there because that file is already 1,100 lines and
// this is a distinct write path.
vi.mock('obsidian', () => {
  class TFile {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  }
  return { TFile };
});

const { setTaskDone } = await import('../src/data/writer');
const { TFile } = (await import('obsidian')) as unknown as { TFile: new (path: string) => any };

class FakeVault {
  files = new Map<string, string>();
  processCalls: string[] = [];
  seed(path: string, content: string) {
    this.files.set(path, content);
  }
  getAbstractFileByPath(path: string) {
    return this.files.has(path) ? new TFile(path) : null;
  }
  async process(file: { path: string }, fn: (data: string) => string) {
    this.processCalls.push(file.path);
    const data = this.files.get(file.path);
    if (data == null) throw new Error(`no such file: ${file.path}`);
    const result = fn(data);
    this.files.set(file.path, result);
    return result;
  }
}

function makeApp() {
  const vault = new FakeVault();
  return { app: { vault } as any, vault };
}

const NOTE = 'Weekly/2026-W36.md';

/** `## Tasks`, a blank, the line under test at index 2, then a bystander. */
function seed(vault: FakeVault, text: string) {
  vault.seed(NOTE, ['## Tasks', '', text, '- [ ] Other', ''].join('\n'));
}

function linesOf(vault: FakeVault): string[] {
  return (vault.files.get(NOTE) as string).split('\n');
}

function edit(text: string, done: boolean, line = 2) {
  return { file: NOTE, line, expectedText: text, title: 'x', done };
}

describe('setTaskDone — ticking a task from the rail', () => {
  it('ticks the box and stamps a completion date', async () => {
    const { app, vault } = makeApp();
    seed(vault, '- [ ] Book dentist');

    const r = await setTaskDone(app, [edit('- [ ] Book dentist', true)]);

    expect(r.errors).toEqual([]);
    expect(r.written).toBe(1);
    const lines = linesOf(vault);
    expect(lines[2]).toMatch(/^- \[x\] Book dentist ✅ \d{4}-\d{2}-\d{2}$/);
    // The bystander and the structure are untouched.
    expect(lines[0]).toBe('## Tasks');
    expect(lines[3]).toBe('- [ ] Other');
    expect(lines[4]).toBe('');
  });

  it('unticking removes the completion date again', async () => {
    const { app, vault } = makeApp();
    const text = '- [x] Book dentist ✅ 2026-08-30';
    seed(vault, text);

    await setTaskDone(app, [edit(text, false)]);

    expect(linesOf(vault)[2]).toBe('- [ ] Book dentist');
  });

  // The stamp has to match the line's own dialect, or a Dataview user ends up
  // with one emoji field sitting among their inline ones.
  it('matches an inline-flavoured line rather than imposing emoji', async () => {
    const { app, vault } = makeApp();
    const text = '- [ ] Write newsletter [est:: 45m] [due:: 2026-09-03]';
    seed(vault, text);

    await setTaskDone(app, [edit(text, true)]);

    const line = linesOf(vault)[2];
    expect(line).not.toContain('✅');
    expect(line).toContain('[est:: 45m]');
    expect(line).toContain('[due:: 2026-09-03]');
    expect(line.startsWith('- [x] ')).toBe(true);
  });

  it('keeps indentation and every other field', async () => {
    const { app, vault } = makeApp();
    const text = '    - [ ] Edit VOD ~90m 📅 2026-09-04 🔼 #content';
    seed(vault, text);

    await setTaskDone(app, [edit(text, true)]);

    const line = linesOf(vault)[2];
    expect(line.startsWith('    - [x] ')).toBe(true);
    expect(line).toContain('~90m');
    expect(line).toContain('📅 2026-09-04');
    expect(line).toContain('🔼');
    expect(line).toContain('#content');
  });

  it('leaves a recurring line’s 🔁 alone', async () => {
    const { app, vault } = makeApp();
    const text = '- [ ] Water plants 🔁 every week';
    seed(vault, text);

    await setTaskDone(app, [edit(text, true)]);

    expect(linesOf(vault)[2]).toContain('🔁 every week');
  });

  it('refuses a line that changed underneath, leaving the file byte-identical', async () => {
    const { app, vault } = makeApp();
    const original = ['## Tasks', '', '- [ ] Something else', ''].join('\n');
    vault.seed(NOTE, original);

    const r = await setTaskDone(app, [edit('- [ ] Book dentist', true)]);

    expect(r.written).toBe(0);
    expect(r.skipped.map((s) => s.reason)).toEqual(['line-changed']);
    expect(vault.files.get(NOTE)).toBe(original);
  });

  it('reports a missing file rather than throwing', async () => {
    const { app } = makeApp();
    const r = await setTaskDone(app, [edit('- [ ] Book dentist', true)]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['file-missing']);
  });

  // It shares `rewriteVerifiedLines` with every other write, so it inherits
  // one-process-call-per-file. Asserted rather than assumed.
  it('uses one write for two edits in the same file', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, ['- [ ] A', '- [ ] B', ''].join('\n'));

    await setTaskDone(app, [edit('- [ ] A', true, 0), edit('- [ ] B', true, 1)]);

    expect(vault.processCalls).toEqual([NOTE]);
  });

  it('preserves CRLF line endings', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, ['## Tasks', '', '- [ ] Book dentist', ''].join('\r\n'));

    await setTaskDone(app, [edit('- [ ] Book dentist', true)]);

    const after = vault.files.get(NOTE) as string;
    expect(after.includes('\r\n')).toBe(true);
    expect(after.split('\r\n')[2].startsWith('- [x] ')).toBe(true);
  });
});

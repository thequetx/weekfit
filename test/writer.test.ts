import { describe, expect, it, vi } from 'vitest';

// `obsidian` ships no runtime JS — mocked the same way test/vaultRepo.test.ts
// does it. `TFile` only needs to carry `.path`; `acceptProposals` never
// checks anything else on it.
vi.mock('obsidian', () => {
  class TFile {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  }
  return { TFile };
});

const {
  acceptProposals,
  editPlacements,
  appendUnderHeading,
  removeLines,
  setFrontmatter,
  replaceChildSessions,
  createNote,
  setTaskDone,
  updateIcsTaskRanges,
  clearIcsUidMarkers,
} = await import('../src/data/writer');
const { TFile } = (await import('obsidian')) as unknown as { TFile: new (path: string) => any };
const { addDays, startOfISOWeek } = await import('../src/lib/week');
const { parse: parseYaml, stringify: stringifyYaml } = await import('yaml');
import type { Proposal } from '../src/lib/gaps';
import type { IcsLink, PlacementEdit } from '../src/data/contract';

// --- a minimal fake vault: just enough for `process` and `getAbstractFileByPath` ---

class FakeVault {
  files = new Map<string, string>();
  processCalls: string[] = [];
  createCalls: string[] = [];

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

  /** Set to a path to make creating it blow up — the only way to check that a
   *  failed write is reported rather than thrown. */
  failWritesTo: string | null = null;

  async create(path: string, content: string) {
    if (this.failWritesTo === path) throw new Error('disk on fire');
    this.createCalls.push(path);
    this.files.set(path, content);
    return new TFile(path);
  }
}

// --- a minimal fake `fileManager`, just enough for `processFrontMatter` ---
//
// Uses the real `yaml` package (already a devDependency) to parse/serialize
// the frontmatter block, so the test exercises real YAML round-tripping
// rather than a hand-rolled stand-in — the closest a mock can get to
// Obsidian's own atomic "read, mutate the object, write back" contract.

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

class FakeFileManager {
  constructor(private vault: FakeVault) {}

  async processFrontMatter(file: { path: string }, fn: (fm: any) => void) {
    const data = this.vault.files.get(file.path);
    if (data == null) throw new Error(`no such file: ${file.path}`);
    const eol = data.includes('\r\n') ? '\r\n' : '\n';

    const m = FRONTMATTER_RE.exec(data);
    const fm: Record<string, unknown> = m ? parseYaml(m[1]) ?? {} : {};
    const rest = m ? data.slice(m[0].length) : data;

    fn(fm);

    const yamlBody = stringifyYaml(fm).replace(/\n$/, '').split('\n').join(eol);
    const block = `---${eol}${yamlBody}${eol}---${eol}`;
    this.vault.files.set(file.path, block + rest);
  }
}

function makeApp() {
  const vault = new FakeVault();
  const fileManager = new FakeFileManager(vault);
  const app = { vault, fileManager } as any;
  return { app, vault };
}

const WEEK_START = startOfISOWeek(new Date(2026, 7, 31)); // Monday 2026-08-31

function isoDateFor(day: number): string {
  const d = addDays(WEEK_START, day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    key: 'Weekly/2026-W36.md:2',
    groupKey: 'Weekly/2026-W36.md:2',
    kind: 'fit',
    file: 'Weekly/2026-W36.md',
    line: 2,
    text: '- [ ] Book dentist',
    title: 'Book dentist',
    minutes: 60,
    day: 0, // Monday
    startMin: 9 * 60,
    endMin: 10 * 60,
    window: 'work',
    ...overrides,
  };
}

const neverDaily = () => false;

describe('acceptProposals', () => {
  it('writes exactly the expected line, leaving every other line byte-identical', async () => {
    const { app, vault } = makeApp();
    const content = '## Tasks\n\n- [ ] Book dentist\n- [ ] Other task\n';
    vault.seed('Weekly/2026-W36.md', content);

    const result = await acceptProposals(app, [proposal()], {
      isDailyNoteFor: neverDaily,
      weekStart: WEEK_START,
    });

    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.written).toBe(1);

    const lines = vault.files.get('Weekly/2026-W36.md')!.split('\n');
    expect(lines[0]).toBe('## Tasks');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe(`- [ ] 09:00 - 10:00 Book dentist ⏳ ${isoDateFor(0)}`);
    expect(lines[3]).toBe('- [ ] Other task');
    expect(lines[4]).toBe(''); // trailing newline preserved
  });

  it('skips a target line that changed since the snapshot, and leaves the file untouched', async () => {
    const { app, vault } = makeApp();
    const original = '## Tasks\n\n- [ ] Book dentist (rescheduled by hand)\n';
    vault.seed('Weekly/2026-W36.md', original);

    const result = await acceptProposals(app, [proposal()], {
      isDailyNoteFor: neverDaily,
      weekStart: WEEK_START,
    });

    expect(result.written).toBe(0);
    expect(result.skipped).toEqual([
      { key: 'Weekly/2026-W36.md:2', title: 'Book dentist', reason: 'line-changed' },
    ]);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(original);
  });

  it('skips a target line that is no longer a checkbox', async () => {
    const { app, vault } = makeApp();
    const original = '## Tasks\n\nNot a task anymore\n';
    vault.seed('Weekly/2026-W36.md', original);

    const p = proposal({ text: 'Not a task anymore' });
    const result = await acceptProposals(app, [p], {
      isDailyNoteFor: neverDaily,
      weekStart: WEEK_START,
    });

    expect(result.written).toBe(0);
    expect(result.skipped).toEqual([
      { key: p.key, title: p.title, reason: 'not-a-task' },
    ]);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(original);
  });

  it('applies two proposals in one file with exactly one vault.process call', async () => {
    const { app, vault } = makeApp();
    const content = '## Tasks\n\n- [ ] Book dentist\n- [ ] Buy milk\n';
    vault.seed('Weekly/2026-W36.md', content);

    const p1 = proposal({ key: 'a', groupKey: 'a', line: 2, text: '- [ ] Book dentist' });
    const p2 = proposal({
      key: 'b',
      groupKey: 'b',
      line: 3,
      text: '- [ ] Buy milk',
      title: 'Buy milk',
      day: 1,
      startMin: 11 * 60,
      endMin: 11 * 60 + 30,
    });

    const result = await acceptProposals(app, [p1, p2], {
      isDailyNoteFor: neverDaily,
      weekStart: WEEK_START,
    });

    expect(result.written).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(vault.processCalls).toEqual(['Weekly/2026-W36.md']);
    expect(vault.processCalls).toHaveLength(1);
  });

  it('keeps CRLF line endings on a CRLF file', async () => {
    const { app, vault } = makeApp();
    const content = '## Tasks\r\n\r\n- [ ] Book dentist\r\n';
    vault.seed('Weekly/2026-W36.md', content);

    const result = await acceptProposals(app, [proposal()], {
      isDailyNoteFor: neverDaily,
      weekStart: WEEK_START,
    });

    expect(result.written).toBe(1);
    const out = vault.files.get('Weekly/2026-W36.md')!;
    expect(out).not.toContain('\n\n'); // no bare LF sequences slipped in
    expect(out.split('\r\n')).toEqual([
      '## Tasks',
      '',
      `- [ ] 09:00 - 10:00 Book dentist ⏳ ${isoDateFor(0)}`,
      '',
    ]);
  });

  it('skips a proposal targeting a missing file, without throwing', async () => {
    const { app } = makeApp();
    const p = proposal({ file: 'Nowhere.md' });

    const result = await acceptProposals(app, [p], {
      isDailyNoteFor: neverDaily,
      weekStart: WEEK_START,
    });

    expect(result.written).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([{ key: p.key, title: p.title, reason: 'file-missing' }]);
  });

  // Splitting used to be refused outright, because one task line cannot carry
  // two time ranges. It now writes the sittings as indented children beneath
  // the parent, which is the format the user chose. The parent stays a task —
  // it keeps its estimate and gains no range of its own.
  it('writes a multi-session group as indented children under the parent', async () => {
    const { app, vault } = makeApp();
    const content = ['## Tasks', '', '- [ ] Edit the big video ~3h', ''].join('\n');
    vault.seed('Weekly/2026-W36.md', content);

    const session1 = proposal({
      key: 'g1#1',
      groupKey: 'g1',
      line: 2,
      text: '- [ ] Edit the big video ~3h',
      title: 'Edit the big video',
      day: 0,
      startMin: 9 * 60,
      endMin: 10 * 60,
      session: 1,
      sessions: 2,
    });
    const session2 = proposal({
      key: 'g1#2',
      groupKey: 'g1',
      line: 2,
      text: '- [ ] Edit the big video ~3h',
      title: 'Edit the big video',
      day: 1,
      startMin: 14 * 60,
      endMin: 15 * 60,
      session: 2,
      sessions: 2,
    });

    const result = await acceptProposals(app, [session1, session2], {
      isDailyNoteFor: neverDaily,
      weekStart: WEEK_START,
    });

    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([]);

    const after = vault.files.get('Weekly/2026-W36.md') as string;
    const lines = after.split('\n');

    // The parent is untouched: still a task, still ~3h, still no range.
    expect(lines[2]).toBe('- [ ] Edit the big video ~3h');

    // Two children, indented, each with its own range and its own day.
    expect(lines[3]).toMatch(/^\s+- \[ \] 09:00 - 10:00 Edit the big video/);
    expect(lines[4]).toMatch(/^\s+- \[ \] 14:00 - 15:00 Edit the big video/);
    expect(lines[3].startsWith(' ')).toBe(true);
    expect(lines[4].startsWith(' ')).toBe(true);

    // Each child says which day it is on, since a weekly note's line has no
    // date of its own.
    expect(lines[3]).toContain('2026-08-31');
    expect(lines[4]).toContain('2026-09-01');

    // And nothing else in the file moved.
    expect(lines[0]).toBe('## Tasks');
    expect(lines[1]).toBe('');
  });

  it('no longer produces needs-splitting for a multi-session group', async () => {
    const { app, vault } = makeApp();
    vault.seed(
      'Weekly/2026-W36.md',
      ['## Tasks', '', '- [ ] Edit the big video ~3h', ''].join('\n'),
    );
    const mk = (n: number, day: number) =>
      proposal({
        key: `g1#${n}`,
        groupKey: 'g1',
        line: 2,
        text: '- [ ] Edit the big video ~3h',
        title: 'Edit the big video',
        day,
        session: n,
        sessions: 2,
      });
    const result = await acceptProposals(app, [mk(1, 0), mk(2, 1)], {
      isDailyNoteFor: neverDaily,
      weekStart: WEEK_START,
    });
    expect(result.skipped.map((s) => s.reason)).not.toContain('needs-splitting');
  });

  it('is idempotent on a repeat accept of the same proposal: the second is skipped as line-changed', async () => {
    const { app, vault } = makeApp();
    const content = '## Tasks\n\n- [ ] Book dentist\n';
    vault.seed('Weekly/2026-W36.md', content);
    const p = proposal();

    const first = await acceptProposals(app, [p], {
      isDailyNoteFor: neverDaily,
      weekStart: WEEK_START,
    });
    expect(first.written).toBe(1);
    const afterFirst = vault.files.get('Weekly/2026-W36.md');

    const second = await acceptProposals(app, [p], {
      isDailyNoteFor: neverDaily,
      weekStart: WEEK_START,
    });

    expect(second.written).toBe(0);
    expect(second.skipped).toEqual([{ key: p.key, title: p.title, reason: 'line-changed' }]);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(afterFirst); // unchanged by the second call
  });

  it('writes no scheduled date for a daily-note target, and a real one for a weekly-note target', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '- [ ] Weekly-note task\n');
    vault.seed('2026-09-01.md', '- [ ] Daily-note task\n');

    const weeklyProp = proposal({
      key: 'w',
      groupKey: 'w',
      file: 'Weekly/2026-W36.md',
      line: 0,
      text: '- [ ] Weekly-note task',
      title: 'Weekly-note task',
      day: 0,
    });
    const dailyProp = proposal({
      key: 'd',
      groupKey: 'd',
      file: '2026-09-01.md',
      line: 0,
      text: '- [ ] Daily-note task',
      title: 'Daily-note task',
      day: 1,
    });

    const result = await acceptProposals(app, [weeklyProp, dailyProp], {
      isDailyNoteFor: (path) => path === '2026-09-01.md',
      weekStart: WEEK_START,
    });

    expect(result.written).toBe(2);
    const weeklyLine = vault.files.get('Weekly/2026-W36.md')!.split('\n')[0];
    const dailyLine = vault.files.get('2026-09-01.md')!.split('\n')[0];

    expect(weeklyLine).toContain('⏳');
    expect(dailyLine).not.toContain('⏳');
    expect(dailyLine).not.toContain('[scheduled::');
  });
});

function edit(overrides: Partial<PlacementEdit> = {}): PlacementEdit {
  return {
    file: 'Weekly/2026-W36.md',
    line: 2,
    expectedText: '- [ ] 09:00 - 10:00 Book dentist',
    range: '11:00 - 12:00',
    scheduledDate: null,
    title: 'Book dentist',
    ...overrides,
  };
}

describe('editPlacements', () => {
  it('re-times a block already on the grid, rewriting the range in place', async () => {
    const { app, vault } = makeApp();
    const content = '## Tasks\n\n- [ ] 09:00 - 10:00 Book dentist\n- [ ] Other task\n';
    vault.seed('Weekly/2026-W36.md', content);

    const result = await editPlacements(app, [edit()]);

    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.written).toBe(1);

    const lines = vault.files.get('Weekly/2026-W36.md')!.split('\n');
    expect(lines[2]).toBe('- [ ] 11:00 - 12:00 Book dentist');
    expect(lines[0]).toBe('## Tasks');
    expect(lines[1]).toBe('');
    expect(lines[3]).toBe('- [ ] Other task');
  });

  it('unschedule (range: null) strips the range and leaves everything else on the line untouched, ⏳ included', async () => {
    const { app, vault } = makeApp();
    const original =
      '- [ ] 09:00 - 10:00 Edit video ~90m 📅 2026-09-04 🔼 #content 🔁 every week ⏳ 2026-09-04';
    vault.seed('Weekly/2026-W36.md', `${original}\n`);

    const result = await editPlacements(app, [
      edit({
        line: 0,
        expectedText: original,
        range: null,
        scheduledDate: null,
        title: 'Edit video',
      }),
    ]);

    expect(result.written).toBe(1);
    expect(result.skipped).toEqual([]);

    const lines = vault.files.get('Weekly/2026-W36.md')!.split('\n');
    expect(lines[0]).toBe(
      '- [ ] Edit video ~90m 📅 2026-09-04 🔼 #content 🔁 every week ⏳ 2026-09-04',
    );
    // Everything that isn't the Day Planner range survived, byte for byte.
    expect(lines[0]).toContain('~90m');
    expect(lines[0]).toContain('📅 2026-09-04');
    expect(lines[0]).toContain('🔼');
    expect(lines[0]).toContain('#content');
    expect(lines[0]).toContain('🔁 every week');
    expect(lines[0]).toContain('⏳ 2026-09-04');
    expect(lines[0]).not.toMatch(/^\d{1,2}:\d{2}/); // no leading range in the body
  });

  it('refuses a stale expectedText, leaving the file byte-identical', async () => {
    const { app, vault } = makeApp();
    const original = '- [ ] 09:00 - 10:00 Book dentist (rescheduled by hand)\n';
    vault.seed('Weekly/2026-W36.md', original);

    const result = await editPlacements(app, [edit({ line: 0 })]);

    expect(result.written).toBe(0);
    expect(result.skipped).toEqual([
      { key: 'Weekly/2026-W36.md:0', title: 'Book dentist', reason: 'line-changed' },
    ]);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(original);
  });

  it('refuses a target that is no longer a checkbox', async () => {
    const { app, vault } = makeApp();
    const original = 'Not a task anymore\n';
    vault.seed('Weekly/2026-W36.md', original);

    const result = await editPlacements(app, [
      edit({ line: 0, expectedText: 'Not a task anymore' }),
    ]);

    expect(result.written).toBe(0);
    expect(result.skipped).toEqual([
      { key: 'Weekly/2026-W36.md:0', title: 'Book dentist', reason: 'not-a-task' },
    ]);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(original);
  });

  it('reports file-missing without creating the file', async () => {
    const { app } = makeApp();
    const result = await editPlacements(app, [edit({ file: 'Nowhere.md', line: 5 })]);

    expect(result.written).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([{ key: 'Nowhere.md:5', title: 'Book dentist', reason: 'file-missing' }]);
  });

  it('applies two edits to one file with exactly one vault.process call', async () => {
    const { app, vault } = makeApp();
    const content = '- [ ] 09:00 - 10:00 Book dentist\n- [ ] 08:00 - 08:30 Buy milk\n';
    vault.seed('Weekly/2026-W36.md', content);

    const result = await editPlacements(app, [
      edit({ line: 0, expectedText: '- [ ] 09:00 - 10:00 Book dentist', range: '11:00 - 12:00' }),
      edit({
        line: 1,
        expectedText: '- [ ] 08:00 - 08:30 Buy milk',
        range: null,
        title: 'Buy milk',
      }),
    ]);

    expect(result.written).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(vault.processCalls).toEqual(['Weekly/2026-W36.md']);
    expect(vault.processCalls).toHaveLength(1);

    const lines = vault.files.get('Weekly/2026-W36.md')!.split('\n');
    expect(lines[0]).toBe('- [ ] 11:00 - 12:00 Book dentist');
    expect(lines[1]).toBe('- [ ] Buy milk');
  });

  it('never throws, even when vault.process itself throws', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '- [ ] Book dentist\n');
    vault.process = async () => {
      throw new Error('disk exploded');
    };

    let result: Awaited<ReturnType<typeof editPlacements>> | undefined;
    await expect(
      (async () => {
        result = await editPlacements(app, [edit({ line: 0, expectedText: '- [ ] Book dentist' })]);
      })(),
    ).resolves.not.toThrow();

    expect(result!.written).toBe(0);
    expect(result!.errors).toEqual(['Weekly/2026-W36.md: disk exploded']);
  });
});

describe('acceptProposals delegates to editPlacements', () => {
  it('reports a WriteSkip using the proposal key even when it differs from file:line — proof the mapping back from editPlacements is real, not assumed', async () => {
    const { app } = makeApp();
    // A key that deliberately does not match `${file}:${line}`, the shape
    // editPlacements reports skips against internally. If acceptProposals
    // stopped translating back to the original proposal identity, this would
    // report `Nowhere.md:9` instead.
    const p = proposal({ key: 'custom-key', groupKey: 'custom-key', file: 'Nowhere.md', line: 9 });

    const result = await acceptProposals(app, [p], {
      isDailyNoteFor: neverDaily,
      weekStart: WEEK_START,
    });

    expect(result.skipped).toEqual([{ key: 'custom-key', title: p.title, reason: 'file-missing' }]);
  });
});

// ---------------------------------------------------------------------------
// appendUnderHeading
// ---------------------------------------------------------------------------

describe('appendUnderHeading', () => {
  it('lands at the end of the section, not the top, and not after the following heading', async () => {
    const { app, vault } = makeApp();
    const content =
      '## Tasks\n\n- [ ] Book dentist\n- [ ] Buy milk\n\n## Notes\n\nSome note\n';
    vault.seed('Weekly/2026-W36.md', content);

    const result = await appendUnderHeading(app, [
      { file: 'Weekly/2026-W36.md', heading: 'Tasks', lines: ['- [ ] New task'] },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.written).toBe(1);

    const after = vault.files.get('Weekly/2026-W36.md')!;
    expect(after).toBe(
      '## Tasks\n\n- [ ] Book dentist\n- [ ] Buy milk\n- [ ] New task\n\n## Notes\n\nSome note\n',
    );
    expect(after.indexOf('New task')).toBeGreaterThan(after.indexOf('Book dentist'));
    expect(after.indexOf('New task')).toBeLessThan(after.indexOf('## Notes'));
  });

  it('creates the heading at the end of the file when it is missing', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] Book dentist\n');

    const result = await appendUnderHeading(app, [
      { file: 'Weekly/2026-W36.md', heading: 'Backlog', lines: ['- [ ] Captured idea'] },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.written).toBe(1);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(
      '## Tasks\n\n- [ ] Book dentist\n\n## Backlog\n\n- [ ] Captured idea\n',
    );
  });

  it('creates the file when it is missing entirely', async () => {
    const { app, vault } = makeApp();

    const result = await appendUnderHeading(app, [
      { file: 'Weekly/2026-W99.md', heading: 'Tasks', lines: ['- [ ] First capture'] },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.written).toBe(1);
    expect(vault.createCalls).toEqual(['Weekly/2026-W99.md']);
    expect(vault.processCalls).toEqual([]);
    expect(vault.files.get('Weekly/2026-W99.md')).toBe('## Tasks\n\n- [ ] First capture\n');
  });

  it('does not accumulate stray blank lines across two captures', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] Book dentist\n\n## Review\n\n');

    const first = await appendUnderHeading(app, [
      { file: 'Weekly/2026-W36.md', heading: 'Tasks', lines: ['- [ ] Buy milk'] },
    ]);
    expect(first.written).toBe(1);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(
      '## Tasks\n\n- [ ] Book dentist\n- [ ] Buy milk\n\n## Review\n\n',
    );

    const second = await appendUnderHeading(app, [
      { file: 'Weekly/2026-W36.md', heading: 'Tasks', lines: ['- [ ] Walk dog'] },
    ]);
    expect(second.written).toBe(1);

    const after = vault.files.get('Weekly/2026-W36.md')!;
    expect(after).toBe(
      '## Tasks\n\n- [ ] Book dentist\n- [ ] Buy milk\n- [ ] Walk dog\n\n## Review\n\n',
    );
    expect(after).not.toContain('\n\n\n');
    // Three double-newlines: after "## Tasks", before "## Review", and
    // "## Review"'s own trailing blank — the same count as before either
    // capture, proving neither one added a stray one.
    expect((after.match(/\n\n/g) ?? []).length).toBe(3);
  });

  it('captures into a heading that is empty (heading, blank, then EOF)', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] Book dentist\n\n## Review\n\n');

    const result = await appendUnderHeading(app, [
      { file: 'Weekly/2026-W36.md', heading: 'Review', lines: ['- [ ] Went well: shipped it'] },
    ]);

    expect(result.written).toBe(1);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(
      '## Tasks\n\n- [ ] Book dentist\n\n## Review\n\n- [ ] Went well: shipped it\n',
    );
  });

  it('matches the heading case-insensitively and tolerates a deeper heading level', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '### tasks\n\n- [ ] Book dentist\n');

    const result = await appendUnderHeading(app, [
      { file: 'Weekly/2026-W36.md', heading: 'Tasks', lines: ['- [ ] Buy milk'] },
    ]);

    expect(result.written).toBe(1);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(
      '### tasks\n\n- [ ] Book dentist\n- [ ] Buy milk\n',
    );
  });

  it('keeps CRLF line endings on a CRLF file', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\r\n\r\n- [ ] Book dentist\r\n');

    const result = await appendUnderHeading(app, [
      { file: 'Weekly/2026-W36.md', heading: 'Tasks', lines: ['- [ ] Buy milk'] },
    ]);

    expect(result.written).toBe(1);
    const out = vault.files.get('Weekly/2026-W36.md')!;
    expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(out).toBe('## Tasks\r\n\r\n- [ ] Book dentist\r\n- [ ] Buy milk\r\n');
  });
});

// ---------------------------------------------------------------------------
// removeLines
// ---------------------------------------------------------------------------

describe('removeLines', () => {
  it('removes exactly the given lines, even when handed out of order, asserting the whole remaining file byte-for-byte', async () => {
    const { app, vault } = makeApp();
    const content = '- [ ] Line A\n- [ ] Line B\n- [ ] Line C\n- [ ] Line D\n- [ ] Line E\n';
    vault.seed('Weekly/2026-W36.md', content);

    // Given in ascending order — the order that would delete the wrong lines
    // if the implementation didn't sort bottom-up before touching anything.
    const result = await removeLines(app, [
      { file: 'Weekly/2026-W36.md', line: 1, expectedText: '- [ ] Line B', title: 'B' },
      { file: 'Weekly/2026-W36.md', line: 3, expectedText: '- [ ] Line D', title: 'D' },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.written).toBe(2);
    expect(vault.processCalls).toEqual(['Weekly/2026-W36.md']);
    expect(vault.processCalls).toHaveLength(1);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe('- [ ] Line A\n- [ ] Line C\n- [ ] Line E\n');
  });

  it('a stale expectedText skips only that line and still removes the others', async () => {
    const { app, vault } = makeApp();
    const content = '- [ ] Line A\n- [ ] Line B (edited)\n- [ ] Line C\n';
    vault.seed('Weekly/2026-W36.md', content);

    const result = await removeLines(app, [
      { file: 'Weekly/2026-W36.md', line: 0, expectedText: '- [ ] Line A', title: 'A' },
      { file: 'Weekly/2026-W36.md', line: 1, expectedText: '- [ ] Line B', title: 'B' },
      { file: 'Weekly/2026-W36.md', line: 2, expectedText: '- [ ] Line C', title: 'C' },
    ]);

    expect(result.written).toBe(2);
    expect(result.skipped).toEqual([
      { key: 'Weekly/2026-W36.md:1', title: 'B', reason: 'line-changed' },
    ]);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe('- [ ] Line B (edited)\n');
  });

  it('reports file-missing without creating the file', async () => {
    const { app } = makeApp();

    const result = await removeLines(app, [
      { file: 'Nowhere.md', line: 5, expectedText: '- [ ] Ghost', title: 'Ghost' },
    ]);

    expect(result.written).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([{ key: 'Nowhere.md:5', title: 'Ghost', reason: 'file-missing' }]);
  });

  it('keeps CRLF line endings on a CRLF file', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '- [ ] Line A\r\n- [ ] Line B\r\n- [ ] Line C\r\n');

    const result = await removeLines(app, [
      { file: 'Weekly/2026-W36.md', line: 1, expectedText: '- [ ] Line B', title: 'B' },
    ]);

    expect(result.written).toBe(1);
    const out = vault.files.get('Weekly/2026-W36.md')!;
    expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(out).toBe('- [ ] Line A\r\n- [ ] Line C\r\n');
  });

  it('never throws, even when vault.process itself throws', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '- [ ] Line A\n');
    vault.process = async () => {
      throw new Error('disk exploded');
    };

    const result = await removeLines(app, [
      { file: 'Weekly/2026-W36.md', line: 0, expectedText: '- [ ] Line A', title: 'A' },
    ]);

    expect(result.written).toBe(0);
    expect(result.errors).toEqual(['Weekly/2026-W36.md: disk exploded']);
  });
});

// ---------------------------------------------------------------------------
// setFrontmatter
// ---------------------------------------------------------------------------

describe('setFrontmatter', () => {
  it('merges into existing frontmatter, leaving unrelated keys and the body untouched', async () => {
    const { app, vault } = makeApp();
    const body = '\n## Tasks\n\n- [ ] Book dentist\n';
    vault.seed('Weekly/2026-W36.md', `---\nweek: 2026-W36\nstatus: planning\n---${body}`);

    const result = await setFrontmatter(app, 'Weekly/2026-W36.md', {
      status: 'active',
      hours_planned: 10,
    });

    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.written).toBe(1);

    const after = vault.files.get('Weekly/2026-W36.md')!;
    expect(after.endsWith(body)).toBe(true);

    const m = FRONTMATTER_RE.exec(after)!;
    expect(parseYaml(m[1])).toEqual({
      week: '2026-W36',
      status: 'active',
      hours_planned: 10,
    });
  });

  it('creates frontmatter when the file has none', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] Book dentist\n');

    const result = await setFrontmatter(app, 'Weekly/2026-W36.md', { status: 'planning' });

    expect(result.written).toBe(1);
    const after = vault.files.get('Weekly/2026-W36.md')!;
    expect(after.endsWith('## Tasks\n\n- [ ] Book dentist\n')).toBe(true);

    const m = FRONTMATTER_RE.exec(after)!;
    expect(m).toBeTruthy();
    expect(parseYaml(m[1])).toEqual({ status: 'planning' });
  });

  it('reports file-missing without creating the file', async () => {
    const { app } = makeApp();

    const result = await setFrontmatter(app, 'Nowhere.md', { status: 'planning' });

    expect(result.written).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([{ key: 'Nowhere.md', title: 'Nowhere.md', reason: 'file-missing' }]);
  });

  it('never throws, even when processFrontMatter itself throws', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '---\nweek: 2026-W36\n---\n');
    app.fileManager.processFrontMatter = async () => {
      throw new Error('malformed yaml');
    };

    const result = await setFrontmatter(app, 'Weekly/2026-W36.md', { status: 'planning' });

    expect(result.written).toBe(0);
    expect(result.errors).toEqual(['Weekly/2026-W36.md: malformed yaml']);
  });
});

// ---------------------------------------------------------------------------
// replaceChildSessions
// ---------------------------------------------------------------------------

describe('replaceChildSessions', () => {
  const parentText = '- [ ] Edit the VOD ~90m';
  const session1 = '    - [ ] 09:00 - 10:00 Edit the VOD ⏳ 2026-09-01';
  const session2 = '    - [ ] 14:00 - 14:30 Edit the VOD ⏳ 2026-09-02';

  it('writes children under the parent, leaving the parent and the rest of the file byte-identical', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', `${parentText}\n- [ ] Other task\n`);

    const result = await replaceChildSessions(app, [
      {
        file: 'Weekly/2026-W36.md',
        line: 0,
        expectedText: parentText,
        title: 'Edit the VOD',
        sessions: [session1, session2],
      },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.written).toBe(1);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(
      `${parentText}\n${session1}\n${session2}\n- [ ] Other task\n`,
    );
  });

  it('re-running with different sessions replaces rather than appends', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', `${parentText}\n${session1}\n${session2}\n- [ ] Other task\n`);

    const newSession = '    - [ ] 10:00 - 11:00 Edit the VOD ⏳ 2026-09-03';
    const result = await replaceChildSessions(app, [
      {
        file: 'Weekly/2026-W36.md',
        line: 0,
        expectedText: parentText,
        title: 'Edit the VOD',
        sessions: [newSession],
      },
    ]);

    expect(result.written).toBe(1);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(
      `${parentText}\n${newSession}\n- [ ] Other task\n`,
    );
  });

  it('sessions: [] removes the existing children and writes nothing back', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', `${parentText}\n${session1}\n${session2}\n- [ ] Other task\n`);

    const result = await replaceChildSessions(app, [
      {
        file: 'Weekly/2026-W36.md',
        line: 0,
        expectedText: parentText,
        title: 'Edit the VOD',
        sessions: [],
      },
    ]);

    expect(result.written).toBe(1);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(`${parentText}\n- [ ] Other task\n`);
  });

  it('leaves a hand-written indented sub-task with no time range alone', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', `${parentText}\n    - [ ] prep footage\n- [ ] Other task\n`);

    const result = await replaceChildSessions(app, [
      {
        file: 'Weekly/2026-W36.md',
        line: 0,
        expectedText: parentText,
        title: 'Edit the VOD',
        sessions: [session1],
      },
    ]);

    expect(result.written).toBe(1);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(
      `${parentText}\n${session1}\n    - [ ] prep footage\n- [ ] Other task\n`,
    );
  });

  it('leaves an indented ranged line whose title does not match the parent alone', async () => {
    const { app, vault } = makeApp();
    vault.seed(
      'Weekly/2026-W36.md',
      `${parentText}\n    - [ ] 09:00 - 09:30 Unrelated errand\n- [ ] Other task\n`,
    );

    const result = await replaceChildSessions(app, [
      {
        file: 'Weekly/2026-W36.md',
        line: 0,
        expectedText: parentText,
        title: 'Edit the VOD',
        sessions: [session1],
      },
    ]);

    expect(result.written).toBe(1);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(
      `${parentText}\n${session1}\n    - [ ] 09:00 - 09:30 Unrelated errand\n- [ ] Other task\n`,
    );
  });

  it('leaves a ranged sibling at the same indentation as the parent alone', async () => {
    const { app, vault } = makeApp();
    vault.seed(
      'Weekly/2026-W36.md',
      `${parentText}\n- [ ] 09:00 - 09:30 Edit the VOD\n- [ ] Other task\n`,
    );

    const result = await replaceChildSessions(app, [
      {
        file: 'Weekly/2026-W36.md',
        line: 0,
        expectedText: parentText,
        title: 'Edit the VOD',
        sessions: [session1],
      },
    ]);

    expect(result.written).toBe(1);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(
      `${parentText}\n${session1}\n- [ ] 09:00 - 09:30 Edit the VOD\n- [ ] Other task\n`,
    );
  });

  it('refuses a stale parent expectedText, leaving the file byte-identical', async () => {
    const { app, vault } = makeApp();
    const original = '- [ ] Edit the VOD ~90m (rescheduled)\n';
    vault.seed('Weekly/2026-W36.md', original);

    const result = await replaceChildSessions(app, [
      {
        file: 'Weekly/2026-W36.md',
        line: 0,
        expectedText: parentText,
        title: 'Edit the VOD',
        sessions: [session1],
      },
    ]);

    expect(result.written).toBe(0);
    expect(result.skipped).toEqual([
      { key: 'Weekly/2026-W36.md:0', title: 'Edit the VOD', reason: 'line-changed' },
    ]);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(original);
  });

  it('reports file-missing without creating the file', async () => {
    const { app } = makeApp();

    const result = await replaceChildSessions(app, [
      {
        file: 'Nowhere.md',
        line: 0,
        expectedText: parentText,
        title: 'Edit the VOD',
        sessions: [session1],
      },
    ]);

    expect(result.written).toBe(0);
    expect(result.skipped).toEqual([
      { key: 'Nowhere.md:0', title: 'Edit the VOD', reason: 'file-missing' },
    ]);
  });

  it('keeps CRLF line endings on a CRLF file', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', `${parentText}\r\n- [ ] Other task\r\n`);

    const result = await replaceChildSessions(app, [
      {
        file: 'Weekly/2026-W36.md',
        line: 0,
        expectedText: parentText,
        title: 'Edit the VOD',
        sessions: [session1, session2],
      },
    ]);

    expect(result.written).toBe(1);
    const out = vault.files.get('Weekly/2026-W36.md')!;
    expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(out).toBe(`${parentText}\r\n${session1}\r\n${session2}\r\n- [ ] Other task\r\n`);
  });
});

describe('createNote — the first-run seed', () => {
  it('creates the note with exactly the content given', async () => {
    const { app, vault } = makeApp();
    const content = ['---', 'week: 2026-W36', '---', '', '## Tasks', ''].join('\n');
    const result = await createNote(app, 'Weekly/2026-W36.md', content);
    expect(result.errors).toEqual([]);
    expect(result.written).toBe(1);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(content);
  });

  // A seed, never a reset. Clobbering a week someone had already written
  // would be unforgivable, so existence is refused rather than overwritten.
  it('refuses rather than overwrites when the note already exists', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', 'mine, already');
    const result = await createNote(app, 'Weekly/2026-W36.md', 'the template');
    expect(result.written).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe('mine, already');
  });

  // vault.create throws if the parent folder is missing, and on a fresh
  // vault `Weekly/` usually is — which is exactly the first run this
  // command exists for.
  it('creates the parent folder first', async () => {
    const { app, vault } = makeApp();
    const made: string[] = [];
    (vault as any).createFolder = async (path: string) => {
      made.push(path);
    };
    await createNote(app, 'Weekly/2026-W36.md', 'x');
    expect(made).toEqual(['Weekly']);
  });

  it('needs no folder for a note at the vault root', async () => {
    const { app, vault } = makeApp();
    const made: string[] = [];
    (vault as any).createFolder = async (path: string) => {
      made.push(path);
    };
    const result = await createNote(app, '2026-W36.md', 'x');
    expect(made).toEqual([]);
    expect(result.written).toBe(1);
  });

  it('reports rather than throws when the create fails', async () => {
    const { app, vault } = makeApp();
    (vault as any).createFolder = async () => {};
    vault.failWritesTo = 'Weekly/2026-W36.md';
    const result = await createNote(app, 'Weekly/2026-W36.md', 'x');
    expect(result.written).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Applying an ICS delta
// ---------------------------------------------------------------------------

function icsLink(overrides: Partial<IcsLink> = {}): IcsLink {
  return {
    uid: 'cal-uid-1',
    path: 'Weekly/2026-W36.md',
    line: 0,
    text: '- [ ] Dentist [ics-uid:: cal-uid-1]',
    ...overrides,
  };
}

describe('updateIcsTaskRanges', () => {
  // The feed can move an event to a different day, and the summary modal says
  // so ("Mon 10:00 → Tue 11:00"). Rewriting only the clock range would apply
  // half of what the user just approved and leave the task on Monday.
  it('follows the feed to a new day when the line already carries a scheduled date', async () => {
    const { app, vault } = makeApp();
    const original = '- [ ] 10:30 - 11:30 Python 101 lecture [ics-uid:: py101-local] ⏳ 2026-09-05';
    vault.seed('Weekly/2026-W36.md', `${original}\n`);

    const result = await updateIcsTaskRanges(app, [
      {
        link: icsLink({ text: original }),
        start: new Date(2026, 8, 4, 13, 0),
        end: new Date(2026, 8, 4, 14, 30),
      },
    ]);

    expect(result[0].written).toBe(1);
    const line = vault.files.get('Weekly/2026-W36.md')!.split('\n')[0];
    expect(line).toContain('13:00 - 14:30');
    expect(line).toContain('2026-09-04');
    expect(line).not.toContain('2026-09-05');
    expect(line).toContain('[ics-uid:: py101-local]');
  });

  // The other half of the same rule. The user put this one in the rail on
  // purpose; a calendar refresh is not the moment to promote it onto the grid.
  it('does not add a scheduled date to a line that never had one', async () => {
    const { app, vault } = makeApp();
    const original = '- [ ] 10:30 - 11:30 Python 101 lecture [ics-uid:: py101-local]';
    vault.seed('Weekly/2026-W36.md', `${original}\n`);

    const result = await updateIcsTaskRanges(app, [
      {
        link: icsLink({ text: original }),
        start: new Date(2026, 8, 4, 13, 0),
        end: new Date(2026, 8, 4, 14, 30),
      },
    ]);

    expect(result[0].written).toBe(1);
    const line = vault.files.get('Weekly/2026-W36.md')!.split('\n')[0];
    expect(line).toBe('- [ ] 13:00 - 14:30 Python 101 lecture [ics-uid:: py101-local]');
  });

  it('rewrites the leading range while keeping title, tags and the marker intact', async () => {
    const { app, vault } = makeApp();
    const original = '- [ ] 09:00 - 09:30 Dentist #health [ics-uid:: cal-uid-1]';
    vault.seed('Weekly/2026-W36.md', `${original}\n`);

    const result = await updateIcsTaskRanges(app, [
      {
        link: icsLink({ text: original }),
        start: new Date(2026, 8, 2, 11, 0),
        end: new Date(2026, 8, 2, 11, 45),
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].written).toBe(1);
    expect(result[0].skipped).toEqual([]);
    expect(result[0].errors).toEqual([]);

    const line = vault.files.get('Weekly/2026-W36.md')!.split('\n')[0];
    expect(line).toBe('- [ ] 11:00 - 11:45 Dentist #health [ics-uid:: cal-uid-1]');
  });

  it('keeps an inline-field-style [due::] alongside the marker untouched', async () => {
    const { app, vault } = makeApp();
    const original = '- [ ] 09:00 - 09:30 Dentist [due:: 2026-09-04] [ics-uid:: cal-uid-1]';
    vault.seed('Weekly/2026-W36.md', `${original}\n`);

    const result = await updateIcsTaskRanges(app, [
      {
        link: icsLink({ text: original }),
        start: new Date(2026, 8, 2, 10, 0),
        end: new Date(2026, 8, 2, 10, 30),
      },
    ]);

    expect(result[0].written).toBe(1);
    const line = vault.files.get('Weekly/2026-W36.md')!.split('\n')[0];
    expect(line).toBe('- [ ] 10:00 - 10:30 Dentist [due:: 2026-09-04] [ics-uid:: cal-uid-1]');
  });

  it('refuses a line the user has edited by hand since it was read', async () => {
    const { app, vault } = makeApp();
    const nowOnDisk = '- [ ] 09:00 - 09:30 Dentist (moved by hand) [ics-uid:: cal-uid-1]';
    vault.seed('Weekly/2026-W36.md', `${nowOnDisk}\n`);
    const staleLink = icsLink({ text: '- [ ] 09:00 - 09:30 Dentist [ics-uid:: cal-uid-1]' });

    const result = await updateIcsTaskRanges(app, [
      { link: staleLink, start: new Date(2026, 8, 2, 11, 0), end: new Date(2026, 8, 2, 11, 30) },
    ]);

    expect(result[0].written).toBe(0);
    expect(result[0].skipped).toEqual([
      { key: 'Weekly/2026-W36.md:0', title: 'Dentist', reason: 'line-changed' },
    ]);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(`${nowOnDisk}\n`);
  });

  it('reports one WriteResult per update, in order', async () => {
    const { app, vault } = makeApp();
    vault.seed(
      'Weekly/2026-W36.md',
      '- [ ] 09:00 - 09:30 A [ics-uid:: a]\n- [ ] 08:00 - 08:15 B [ics-uid:: b]\n',
    );

    const results = await updateIcsTaskRanges(app, [
      {
        link: icsLink({ uid: 'a', line: 0, text: '- [ ] 09:00 - 09:30 A [ics-uid:: a]' }),
        start: new Date(2026, 8, 2, 12, 0),
        end: new Date(2026, 8, 2, 12, 30),
      },
      {
        link: icsLink({ uid: 'b', line: 1, text: '- [ ] 08:00 - 08:15 B [ics-uid:: b]' }),
        start: new Date(2026, 8, 2, 13, 0),
        end: new Date(2026, 8, 2, 13, 15),
      },
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.written === 1)).toBe(true);
    const lines = vault.files.get('Weekly/2026-W36.md')!.split('\n');
    expect(lines[0]).toBe('- [ ] 12:00 - 12:30 A [ics-uid:: a]');
    expect(lines[1]).toBe('- [ ] 13:00 - 13:15 B [ics-uid:: b]');
  });
});

describe('clearIcsUidMarkers', () => {
  it('strips the marker cleanly, leaving no double space and the task line intact', async () => {
    const { app, vault } = makeApp();
    const original = '- [ ] 11:00 - 11:45 Dentist #health [ics-uid:: cal-uid-1]';
    vault.seed('Weekly/2026-W36.md', `${original}\n`);

    const result = await clearIcsUidMarkers(app, [icsLink({ text: original })]);

    expect(result).toHaveLength(1);
    expect(result[0].written).toBe(1);
    expect(result[0].skipped).toEqual([]);

    const line = vault.files.get('Weekly/2026-W36.md')!.split('\n')[0];
    expect(line).toBe('- [ ] 11:00 - 11:45 Dentist #health');
    expect(line).not.toMatch(/ {2,}/); // no leftover double space
  });

  it('strips the parenthesised (ics-uid:: …) flavour too', async () => {
    const { app, vault } = makeApp();
    const original = '- [ ] Standup (ics-uid:: standup-2026)';
    vault.seed('Weekly/2026-W36.md', `${original}\n`);

    await clearIcsUidMarkers(app, [icsLink({ text: original })]);
    const line = vault.files.get('Weekly/2026-W36.md')!.split('\n')[0];
    expect(line).toBe('- [ ] Standup');
  });

  it('does not delete the task line, only the marker', async () => {
    const { app, vault } = makeApp();
    const original = '- [ ] Dentist [ics-uid:: cal-uid-1]';
    vault.seed('Weekly/2026-W36.md', `${original}\nOther line stays\n`);

    await clearIcsUidMarkers(app, [icsLink({ text: original })]);
    const lines = vault.files.get('Weekly/2026-W36.md')!.split('\n');
    expect(lines[0]).toBe('- [ ] Dentist');
    expect(lines[1]).toBe('Other line stays');
  });

  it('refuses a line that no longer matches, rather than guessing which marker to strip', async () => {
    const { app, vault } = makeApp();
    const nowOnDisk = '- [ ] Dentist (rebooked) [ics-uid:: cal-uid-1]';
    vault.seed('Weekly/2026-W36.md', `${nowOnDisk}\n`);
    const staleLink = icsLink({ text: '- [ ] Dentist [ics-uid:: cal-uid-1]' });

    const result = await clearIcsUidMarkers(app, [staleLink]);

    expect(result[0].written).toBe(0);
    expect(result[0].skipped).toEqual([
      { key: 'Weekly/2026-W36.md:0', title: 'Dentist', reason: 'line-changed' },
    ]);
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(`${nowOnDisk}\n`);
  });
});

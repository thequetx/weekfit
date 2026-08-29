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

const { acceptProposals, editPlacements } = await import('../src/data/writer');
const { TFile } = (await import('obsidian')) as unknown as { TFile: new (path: string) => any };
const { addDays, startOfISOWeek } = await import('../src/lib/week');
import type { Proposal } from '../src/lib/gaps';
import type { PlacementEdit } from '../src/data/contract';

// --- a minimal fake vault: just enough for `process` and `getAbstractFileByPath` ---

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
  const app = { vault } as any;
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

  it('refuses a whole multi-session group with needs-splitting, and writes nothing', async () => {
    const { app, vault } = makeApp();
    const content = '## Tasks\n\n- [ ] Edit the big video\n';
    vault.seed('Weekly/2026-W36.md', content);

    const session1 = proposal({
      key: 'g1#1',
      groupKey: 'g1',
      line: 2,
      text: '- [ ] Edit the big video',
      title: 'Edit the big video',
      day: 0,
    });
    const session2 = proposal({
      key: 'g1#2',
      groupKey: 'g1',
      line: 2,
      text: '- [ ] Edit the big video',
      title: 'Edit the big video',
      day: 1,
    });

    const result = await acceptProposals(app, [session1, session2], {
      isDailyNoteFor: neverDaily,
      weekStart: WEEK_START,
    });

    expect(result.written).toBe(0);
    expect(result.skipped).toEqual([
      { key: 'g1', title: 'Edit the big video', reason: 'needs-splitting' },
    ]);
    expect(vault.processCalls).toEqual([]); // never even opened the file
    expect(vault.files.get('Weekly/2026-W36.md')).toBe(content);
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

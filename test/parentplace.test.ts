import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
  class TFile {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  }
  return { TFile };
});

const { editPlacements } = await import('../src/data/writer');
const { TFile } = (await import('obsidian')) as unknown as { TFile: new (p: string) => any };

class FakeVault {
  files = new Map<string, string>();
  seed(p: string, c: string) {
    this.files.set(p, c);
  }
  getAbstractFileByPath(p: string) {
    return this.files.has(p) ? new TFile(p) : null;
  }
  async process(file: { path: string }, fn: (d: string) => string) {
    const d = this.files.get(file.path);
    if (d == null) throw new Error('missing');
    const r = fn(d);
    this.files.set(file.path, r);
    return r;
  }
}

const NOTE = 'Weekly/2026-W36.md';
const PARENT = '- [ ] Rebuild the overlay ~6h #deep';

function makeApp() {
  const vault = new FakeVault();
  return { app: { vault } as any, vault };
}

function linesOf(vault: FakeVault): string[] {
  return (vault.files.get(NOTE) as string).split('\n');
}

function placeParent(app: any, range: string | null) {
  return editPlacements(app, [
    {
      file: NOTE,
      line: 2,
      expectedText: PARENT,
      range,
      scheduledDate: range ? '2026-09-02' : null,
      title: 'Rebuild the overlay',
    },
  ]);
}

/** A task already split into two sittings, with a bystander below. */
function seedSplit(vault: FakeVault) {
  vault.seed(
    NOTE,
    [
      '## Tasks',
      '',
      PARENT,
      '    - [ ] 09:00 - 12:00 Rebuild the overlay ⏳ 2026-08-31',
      '    - [ ] 09:00 - 10:00 Rebuild the overlay ⏳ 2026-09-01',
      '- [ ] Book dentist',
      '',
    ].join('\n'),
  );
}

describe('a task is either one block or several sittings, never both', () => {
  // Reported: dragging a split parent onto the grid left its children behind,
  // so one 6h task was booked three times — its own block plus both sittings,
  // ten hours of grid for six hours of work.
  it('placing a split parent retires its sittings', async () => {
    const { app, vault } = makeApp();
    seedSplit(vault);

    const r = await placeParent(app, '14:00 - 20:00');
    expect(r.errors).toEqual([]);

    const lines = linesOf(vault);
    expect(lines[2]).toBe('- [ ] 14:00 - 20:00 Rebuild the overlay ~6h #deep ⏳ 2026-09-02');
    // Both sittings gone; the bystander has moved up to take their place.
    expect(lines[3]).toBe('- [ ] Book dentist');
    expect(lines.filter((l) => l.includes('Rebuild the overlay'))).toHaveLength(1);
  });

  it('unscheduling a parent takes its sittings with it', async () => {
    const { app, vault } = makeApp();
    seedSplit(vault);

    await placeParent(app, null);

    const lines = linesOf(vault);
    expect(lines[2]).toBe(PARENT); // back to a plain task, estimate intact
    expect(lines[3]).toBe('- [ ] Book dentist');
  });

  // The recognition has to stay narrow, or scheduling a task would delete
  // whatever the user happened to write underneath it.
  it('leaves a hand-written sub-task alone', async () => {
    const { app, vault } = makeApp();
    vault.seed(
      NOTE,
      ['## Tasks', '', PARENT, '    - [ ] ask Sam which codec', '- [ ] Book dentist', ''].join('\n'),
    );

    await placeParent(app, '14:00 - 20:00');

    const lines = linesOf(vault);
    expect(lines[3]).toBe('    - [ ] ask Sam which codec');
    expect(lines[4]).toBe('- [ ] Book dentist');
  });

  it('leaves a same-indent scheduled neighbour alone', async () => {
    const { app, vault } = makeApp();
    vault.seed(
      NOTE,
      [
        '## Tasks',
        '',
        PARENT,
        '- [ ] 09:00 - 10:00 Something else ⏳ 2026-08-31',
        '',
      ].join('\n'),
    );

    await placeParent(app, '14:00 - 20:00');

    expect(linesOf(vault)[3]).toBe('- [ ] 09:00 - 10:00 Something else ⏳ 2026-08-31');
  });

  it('stops at the first line that is not a sitting', async () => {
    const { app, vault } = makeApp();
    vault.seed(
      NOTE,
      [
        '## Tasks',
        '',
        PARENT,
        '    - [ ] 09:00 - 12:00 Rebuild the overlay ⏳ 2026-08-31',
        '    - [ ] no range here, so the run ends',
        '    - [ ] 14:00 - 15:00 Rebuild the overlay ⏳ 2026-09-01',
        '',
      ].join('\n'),
    );

    await placeParent(app, '14:00 - 20:00');

    const lines = linesOf(vault);
    // Only the first child went; everything from the non-sitting on survives.
    expect(lines[3]).toBe('    - [ ] no range here, so the run ends');
    expect(lines[4]).toBe('    - [ ] 14:00 - 15:00 Rebuild the overlay ⏳ 2026-09-01');
  });

  it('a task with no children is unaffected', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, ['## Tasks', '', PARENT, '- [ ] Book dentist', ''].join('\n'));

    await placeParent(app, '14:00 - 20:00');

    const lines = linesOf(vault);
    expect(lines[3]).toBe('- [ ] Book dentist');
    expect(lines[4]).toBe('');
  });
});

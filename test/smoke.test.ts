// End-to-end smoke test — Phase 3. Every other test in this repo runs the
// modules under test against a hand-rolled *mock* of `obsidian`: an in-memory
// `Map` standing in for the vault, or a fake `Vault` shaped like
// `writer.test.ts`'s. None of that ever touches a real file on disk, which
// means the read → fit → write pipeline has never actually round-tripped a
// real markdown file.
//
// This file closes that gap as far as it can be closed without launching
// Obsidian: the same `vi.mock('obsidian', …)` trick every other test here
// uses (see test/vaultRepo.test.ts, read first, for the pattern), but with a
// `Vault` backed by the *real filesystem* — a fixture vault
// (test/fixtures/vault/) copied into a fresh `os.tmpdir()` directory per
// test, read and written with real `node:fs`, and thrown away afterwards.
//
// Nothing under `src/lib/` is touched here — this only exercises
// `src/data/vaultRepo.ts`, `src/data/planner.ts` and `src/data/writer.ts`,
// which is exactly the seam the mocks above never got tested at.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fsp = fs.promises;

// --- the obsidian mock: same shape as vaultRepo.test.ts's, real fs behind it ---
//
// `TFile` has to be the *same* class instance every module under test sees
// (`instanceof TFile` is how both vaultRepo.ts and writer.ts recognise a real
// file), which is why it's minted once inside the mock factory and re-used by
// the `RealFsVault` below rather than redeclared.
vi.mock('obsidian', async () => {
  const moment = (await import('moment')).default;
  class TFile {
    path: string;
    name: string;
    constructor(path: string) {
      this.path = path;
      this.name = path.split('/').pop() ?? path;
    }
  }
  return { moment, TFile };
});

const { VaultRepo } = await import('../src/data/vaultRepo');
const { computeFit } = await import('../src/data/planner');
const { acceptProposals, editPlacements } = await import('../src/data/writer');
const { hasPlacement } = await import('../src/data/dayplanner');
const { TFile } = (await import('obsidian')) as unknown as { TFile: new (path: string) => any };
const { DEFAULT_SETTINGS } = await import('../src/data/contract');
import type { WeekfitSettings } from '../src/data/contract';
import { addDays, startOfISOWeek } from '../src/lib/week';
import { dayPlannerRange } from '../src/lib/source';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'vault');

// ---------------------------------------------------------------------------
// A `Vault` backed by the real filesystem, rooted at `basePath` (a temp
// directory copied from the fixture). Every path in/out is vault-relative
// with forward slashes, matching what `VaultTask.file` and `Proposal.file`
// carry everywhere else in this codebase.
// ---------------------------------------------------------------------------

class RealFsVault {
  constructor(public basePath: string) {}

  abs(p: string): string {
    return path.join(this.basePath, p);
  }

  getMarkdownFiles(): any[] {
    const out: any[] = [];
    const walk = (dir: string, relDir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(abs, rel);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          out.push(new TFile(rel));
        }
      }
    };
    walk(this.basePath, '');
    return out;
  }

  getAbstractFileByPath(p: string): any | null {
    try {
      const st = fs.statSync(this.abs(p));
      return st.isFile() ? new TFile(p.replace(/\\/g, '/')) : null;
    } catch {
      return null;
    }
  }

  async cachedRead(file: { path: string }): Promise<string> {
    return fsp.readFile(this.abs(file.path), 'utf8');
  }

  async read(file: { path: string }): Promise<string> {
    return this.cachedRead(file);
  }

  /** Real atomic-enough read-modify-write: read, transform, write back.
   *  Deliberately no newline normalisation anywhere in this path — a CRLF
   *  file must come back CRLF. */
  async process(file: { path: string }, fn: (data: string) => string): Promise<string> {
    const abs = this.abs(file.path);
    const data = await fsp.readFile(abs, 'utf8');
    const result = fn(data);
    await fsp.writeFile(abs, result, 'utf8');
    return result;
  }
}

/** Just enough of `MetadataCache` for the `#thisweek` pre-filter: scan the
 *  file's raw text for `#tag`-shaped tokens. This is a rough stand-in — the
 *  real cache is smarter about fenced code — but that precision lives in
 *  `sweepTagged` (untouched `src/data/parse.ts`), which is what actually
 *  decides which *lines* count. This only has to decide which *files* are
 *  worth reading at all. */
class RealFsMetadataCache {
  constructor(private vault: RealFsVault) {}

  getFileCache(file: { path: string }): { tags: { tag: string }[] } | null {
    let text: string;
    try {
      text = fs.readFileSync(this.vault.abs(file.path), 'utf8');
    } catch {
      return null;
    }
    const tags = [...text.matchAll(/#[A-Za-z0-9_/-]+/g)].map((m) => ({ tag: m[0] }));
    return { tags };
  }
}

interface Ctx {
  tempDir: string;
  app: any;
  vault: RealFsVault;
  repo: InstanceType<typeof VaultRepo>;
}

function settings(overrides: Partial<WeekfitSettings> = {}): WeekfitSettings {
  return { ...DEFAULT_SETTINGS, usePeriodicNotes: false, ...overrides };
}

async function setupVault(): Promise<Ctx> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'weekfit-smoke-'));
  // Copy, never symlink/reference — the fixture directory itself must never
  // be mutated by a test run.
  fs.cpSync(FIXTURE_DIR, tempDir, { recursive: true });

  const vault = new RealFsVault(tempDir);
  const metadataCache = new RealFsMetadataCache(vault);
  const app = { vault, metadataCache } as any;
  const repo = new VaultRepo(app, () => settings());
  return { tempDir, app, vault, repo };
}

/** Mirrors `writer.ts`'s own (unexported) `isoDateFor` — local-date
 *  `YYYY-MM-DD` for day `day` (0 = Monday) of the week starting `weekStart`.
 *  Duplicated here deliberately: this test builds its expectations
 *  independently rather than importing the function it's trying to verify. */
function isoDateFor(weekStart: Date, day: number): string {
  const d = addDays(weekStart, day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function lineIndexOf(content: string, line: string): number {
  return content.split('\n').indexOf(line);
}

// Monday 2026-08-31, ISO week 2026-W36 — the fixture vault is built around
// this exact week so the fixture and the code agree on the note path.
const WEEK_START = startOfISOWeek(new Date(2026, 7, 31));

describe('smoke: real filesystem read -> fit -> write pipeline', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await setupVault();
  });

  afterEach(async () => {
    await fsp.rm(ctx.tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------
  // Read path
  // -------------------------------------------------------------------

  describe('read path', () => {
    it('finds the real weekly note and parses every task with the right raw text and line numbers', async () => {
      const snap = await ctx.repo.readWeek(WEEK_START);

      expect(snap.weekId).toBe('2026-W36');
      expect(snap.notePath).toBe('Weekly/2026-W36.md');

      const expectedTaskLines = [
        '- [ ] Book dentist',
        '- [ ] Prep talk slides ~90m',
        '- [ ] Edit VOD ~90m 📅 2026-09-04 🔼',
        '- [ ] Write newsletter [est:: 45m] [due:: 2026-09-03]',
        '- [ ] 09:00 - 10:30 Fix badge alpha ⏳ 2026-09-01',
        '- [ ] Plan next stream #content',
        '- [x] Already finished',
        '  - [ ] Follow up with vendor', // indented sub-task — indentation is part of `.text`
        '- [ ] Water plants 🔁 every week',
      ];
      expect(snap.tasks.map((t) => t.text)).toEqual(expectedTaskLines);

      // 0-indexed line numbers, verified against the real file on disk
      // rather than a hand-counted constant.
      const raw = fs.readFileSync(path.join(ctx.tempDir, 'Weekly/2026-W36.md'), 'utf8');
      const expectedLineNumbers = expectedTaskLines.map((line) => lineIndexOf(raw, line));
      expect(expectedLineNumbers.every((n) => n >= 0)).toBe(true);
      expect(snap.tasks.map((t) => t.line)).toEqual(expectedLineNumbers);

      expect(snap.intentions.map((t) => t.text)).toEqual([
        '- [ ] Ship the Weekfit Phase 0 scaffold',
      ]);
      expect(snap.tasks.find((t) => t.text === '- [x] Already finished')!.done).toBe(true);
      expect(snap.tasks.find((t) => t.text === '- [ ] Book dentist')!.done).toBe(false);
    });

    it('sweeps #thisweek across the vault, skips the fenced line and #thisweekend, and never reads Untagged.md', async () => {
      const readPaths: string[] = [];
      const realRead = ctx.vault.cachedRead.bind(ctx.vault);
      ctx.vault.cachedRead = (async (f: any) => {
        readPaths.push(f.path);
        return realRead(f);
      }) as any;

      const snap = await ctx.repo.readWeek(WEEK_START);

      expect([...snap.thisweek.map((t) => t.text)].sort()).toEqual(
        [
          '- [ ] Reorganize the garage #thisweek',
          '- [ ] Call the vet about the cat #thisweek',
          '- [ ] Ship the CRLF fix #thisweek',
        ].sort(),
      );
      expect(snap.thisweek.some((t) => t.text.includes('fenced task'))).toBe(false);
      expect(snap.thisweek.some((t) => t.text.includes('standing desk'))).toBe(false);

      expect(readPaths).not.toContain('Notes/Untagged.md');
      expect([...readPaths].sort()).toEqual(
        ['Weekly/2026-W36.md', 'Notes/Loose ideas.md', 'Notes/CRLF Task.md'].sort(),
      );
    });

    it('turns the already-scheduled Day Planner line into a CalEvent in snapshot.scheduled', async () => {
      const raw = fs.readFileSync(path.join(ctx.tempDir, 'Weekly/2026-W36.md'), 'utf8');
      const targetLine = '- [ ] 09:00 - 10:30 Fix badge alpha ⏳ 2026-09-01';
      const lineNo = lineIndexOf(raw, targetLine);
      expect(lineNo).toBeGreaterThanOrEqual(0);

      const snap = await ctx.repo.readWeek(WEEK_START);

      expect(snap.errors).toEqual([]);
      expect(snap.scheduled).toHaveLength(1);
      const ev = snap.scheduled[0];
      expect(ev.title).toBe('Fix badge alpha');
      expect(ev.start).toEqual(new Date(2026, 8, 1, 9, 0)); // Tue 2026-09-01, 09:00
      expect(ev.end).toEqual(new Date(2026, 8, 1, 10, 30));
      expect(ev.source).toBe(`Weekly/2026-W36.md#L${lineNo}`);
      expect(ev.allDay).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Fit path
  // -------------------------------------------------------------------

  describe('fit path', () => {
    it('proposes placements for unscheduled tasks, excludes the already-placed and done lines, and reports consistent capacity', async () => {
      const snap = await ctx.repo.readWeek(WEEK_START);
      const fit = computeFit(snap, settings(), WEEK_START);

      const fixBadgeLine = snap.tasks.find((t) =>
        t.text.startsWith('- [ ] 09:00 - 10:30 Fix badge alpha'),
      )!;
      const alreadyDone = snap.tasks.find((t) => t.text === '- [x] Already finished')!;

      // The regression this guards: `hasPlacement` used to test an
      // `^`-anchored Day Planner regex against the *whole* raw line
      // (checkbox prefix included), which never matched — so an
      // already-scheduled task like this one would have been proposed all
      // over again. Asserted directly against the real pipeline's output,
      // independent of how the exclusion is implemented internally.
      expect(
        fit.proposals.some((p) => p.file === fixBadgeLine.file && p.line === fixBadgeLine.line),
      ).toBe(false);
      expect(
        fit.proposals.some((p) => p.file === alreadyDone.file && p.line === alreadyDone.line),
      ).toBe(false);

      // 9 weekly-note tasks + 3 #thisweek tasks = 12 candidates, minus the
      // done one and the already-placed one = 10 proposals, nothing unplaced
      // (every task here is <= 90m against >= 390m gaps).
      expect(snap.tasks).toHaveLength(9);
      expect(snap.thisweek).toHaveLength(3);
      expect(fit.proposals).toHaveLength(10);
      expect(fit.unplaced).toEqual([]);

      // Capacity: committed minutes, computed independently from the known
      // fixture durations (grid-snapped to 30m, per `snapToGrid`).
      const expectedCommittedMin =
        60 /* Book dentist -> default 60m */ +
        90 /* Prep talk slides ~90m */ +
        90 /* Edit VOD ~90m */ +
        60 /* Write newsletter [est:: 45m] -> snapped to 60m */ +
        60 /* Plan next stream #content -> default 60m (no #content duration configured) */ +
        60 /* Follow up with vendor -> default 60m */ +
        60 /* Water plants -> default 60m (recurrence carries no duration) */ +
        60 /* Reorganize the garage #thisweek -> default 60m */ +
        60 /* Call the vet about the cat #thisweek -> default 60m */ +
        60; /* Ship the CRLF fix #thisweek -> default 60m */
      expect(fit.capacity.committedMin).toBe(expectedCommittedMin);

      // Free minutes: the default settings windows are Mon-Fri 09:00-17:00
      // (480m/day). Tuesday loses 90m to the already-scheduled block, and
      // `now` is pinned to Monday 00:00 so nothing is trimmed as "past".
      const expectedFreeMin = 480 * 4 + (480 - 90);
      expect(fit.capacity.freeMin).toBe(expectedFreeMin);
      expect(fit.capacity.overBy).toBe(Math.max(0, expectedCommittedMin - expectedFreeMin));
      expect(fit.capacity.overBy).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Write path
  // -------------------------------------------------------------------

  describe('write path', () => {
    const filePath = 'Weekly/2026-W36.md';

    async function fitProposals() {
      const snap = await ctx.repo.readWeek(WEEK_START);
      const fit = computeFit(snap, settings(), WEEK_START);
      return { snap, fit };
    }

    it('rewrites exactly one line, leaving every other byte untouched, and keeps all original metadata', async () => {
      const abs = path.join(ctx.tempDir, filePath);
      const before = fs.readFileSync(abs, 'utf8');

      const { fit } = await fitProposals();
      const targetText = '- [ ] Edit VOD ~90m 📅 2026-09-04 🔼';
      const proposal = fit.proposals.find((p) => p.text === targetText);
      expect(proposal).toBeTruthy();

      const result = await acceptProposals(ctx.app, [proposal!], {
        isDailyNoteFor: () => false,
        weekStart: WEEK_START,
      });
      expect(result.errors).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.written).toBe(1);

      const after = fs.readFileSync(abs, 'utf8');
      const beforeLines = before.split('\n');
      const afterLines = after.split('\n');
      expect(afterLines).toHaveLength(beforeLines.length);

      afterLines.forEach((line, i) => {
        if (i === proposal!.line) return;
        expect(line).toBe(beforeLines[i]);
      });

      const range = dayPlannerRange(proposal!.startMin, proposal!.endMin);
      const date = isoDateFor(WEEK_START, proposal!.day);
      const expectedNewLine = `- [ ] ${range} Edit VOD ~90m 📅 2026-09-04 🔼 ⏳ ${date}`;
      expect(afterLines[proposal!.line]).toBe(expectedNewLine);

      // Every original piece of metadata survives, unmangled.
      expect(afterLines[proposal!.line]).toContain('~90m');
      expect(afterLines[proposal!.line]).toContain('📅 2026-09-04');
      expect(afterLines[proposal!.line]).toContain('🔼');
      expect(afterLines[proposal!.line]).toContain(`⏳ ${date}`);

      // The trailing newline and every heading/blank line still there.
      expect(after.endsWith('\n\n')).toBe(true);
      expect(afterLines).toContain('## Review');
    });

    it('preserves a recurrence tag (🔁) through a write', async () => {
      const abs = path.join(ctx.tempDir, filePath);
      const before = fs.readFileSync(abs, 'utf8');

      const { fit } = await fitProposals();
      const proposal = fit.proposals.find((p) => p.text === '- [ ] Water plants 🔁 every week');
      expect(proposal).toBeTruthy();

      const result = await acceptProposals(ctx.app, [proposal!], {
        isDailyNoteFor: () => false,
        weekStart: WEEK_START,
      });
      expect(result.written).toBe(1);

      const after = fs.readFileSync(abs, 'utf8');
      const afterLines = after.split('\n');
      const beforeLines = before.split('\n');
      afterLines.forEach((line, i) => {
        if (i === proposal!.line) return;
        expect(line).toBe(beforeLines[i]);
      });

      const range = dayPlannerRange(proposal!.startMin, proposal!.endMin);
      const date = isoDateFor(WEEK_START, proposal!.day);
      expect(afterLines[proposal!.line]).toBe(
        `- [ ] ${range} Water plants 🔁 every week ⏳ ${date}`,
      );
    });

    it('writes a [scheduled::] field (not ⏳) onto a line that is mostly Dataview-flavoured, keeping [due::] intact', async () => {
      const { fit } = await fitProposals();
      const proposal = fit.proposals.find(
        (p) => p.text === '- [ ] Write newsletter [est:: 45m] [due:: 2026-09-03]',
      );
      expect(proposal).toBeTruthy();

      const result = await acceptProposals(ctx.app, [proposal!], {
        isDailyNoteFor: () => false,
        weekStart: WEEK_START,
      });
      expect(result.written).toBe(1);

      const abs = path.join(ctx.tempDir, filePath);
      const after = fs.readFileSync(abs, 'utf8');
      const line = after.split('\n')[proposal!.line];

      const range = dayPlannerRange(proposal!.startMin, proposal!.endMin);
      const date = isoDateFor(WEEK_START, proposal!.day);
      // `applyPlacement` only ever adds the range and the scheduled field —
      // it never strips anything else already on the line, `[est:: 45m]`
      // included.
      expect(line).toBe(
        `- [ ] ${range} Write newsletter [est:: 45m] [due:: 2026-09-03] [scheduled:: ${date}]`,
      );
      expect(line).toContain('[est:: 45m]');
      expect(line).toContain('[due:: 2026-09-03]');
      expect(line).not.toContain('⏳');
    });

    it('refuses a write when the target line changed since the snapshot, leaving the file byte-identical', async () => {
      const abs = path.join(ctx.tempDir, filePath);

      const { fit } = await fitProposals();
      const proposal = fit.proposals.find((p) => p.text === '- [ ] Book dentist')!;
      expect(proposal).toBeTruthy();

      // Simulate a hand-edit landing between the snapshot read and the accept.
      const staleBefore = fs.readFileSync(abs, 'utf8');
      const staleLines = staleBefore.split('\n');
      staleLines[proposal.line] = '- [ ] Book dentist (rescheduled by hand)';
      const mutated = staleLines.join('\n');
      fs.writeFileSync(abs, mutated, 'utf8');

      const result = await acceptProposals(ctx.app, [proposal], {
        isDailyNoteFor: () => false,
        weekStart: WEEK_START,
      });

      expect(result.written).toBe(0);
      expect(result.skipped).toEqual([
        { key: proposal.key, title: proposal.title, reason: 'line-changed' },
      ]);

      const after = fs.readFileSync(abs, 'utf8');
      expect(after).toBe(mutated); // untouched, byte for byte
    });

    it('accepts two proposals in the same file, writing both lines correctly', async () => {
      const abs = path.join(ctx.tempDir, filePath);
      const before = fs.readFileSync(abs, 'utf8');

      const { fit } = await fitProposals();
      const p1 = fit.proposals.find((p) => p.text === '- [ ] Book dentist')!;
      const p2 = fit.proposals.find((p) => p.text === '- [ ] Plan next stream #content')!;
      expect(p1).toBeTruthy();
      expect(p2).toBeTruthy();

      const result = await acceptProposals(ctx.app, [p1, p2], {
        isDailyNoteFor: () => false,
        weekStart: WEEK_START,
      });
      expect(result.written).toBe(2);
      expect(result.skipped).toEqual([]);
      expect(result.errors).toEqual([]);

      const after = fs.readFileSync(abs, 'utf8');
      const beforeLines = before.split('\n');
      const afterLines = after.split('\n');
      expect(afterLines).toHaveLength(beforeLines.length);

      const range1 = dayPlannerRange(p1.startMin, p1.endMin);
      const date1 = isoDateFor(WEEK_START, p1.day);
      expect(afterLines[p1.line]).toBe(`- [ ] ${range1} Book dentist ⏳ ${date1}`);

      const range2 = dayPlannerRange(p2.startMin, p2.endMin);
      const date2 = isoDateFor(WEEK_START, p2.day);
      expect(afterLines[p2.line]).toBe(`- [ ] ${range2} Plan next stream #content ⏳ ${date2}`);

      afterLines.forEach((line, i) => {
        if (i === p1.line || i === p2.line) return;
        expect(line).toBe(beforeLines[i]);
      });
    });

    it('preserves exact indentation when accepting a proposal for an indented sub-task', async () => {
      const abs = path.join(ctx.tempDir, filePath);
      const before = fs.readFileSync(abs, 'utf8');

      const { fit } = await fitProposals();
      const proposal = fit.proposals.find((p) => p.text === '  - [ ] Follow up with vendor');
      expect(proposal).toBeTruthy();

      const result = await acceptProposals(ctx.app, [proposal!], {
        isDailyNoteFor: () => false,
        weekStart: WEEK_START,
      });
      expect(result.written).toBe(1);

      const after = fs.readFileSync(abs, 'utf8');
      const beforeLines = before.split('\n');
      const afterLines = after.split('\n');
      afterLines.forEach((line, i) => {
        if (i === proposal!.line) return;
        expect(line).toBe(beforeLines[i]);
      });

      const range = dayPlannerRange(proposal!.startMin, proposal!.endMin);
      const date = isoDateFor(WEEK_START, proposal!.day);
      expect(afterLines[proposal!.line]).toBe(`  - [ ] ${range} Follow up with vendor ⏳ ${date}`);
      expect(afterLines[proposal!.line].startsWith('  - [ ]')).toBe(true);
    });

    it('keeps CRLF line endings after a write to a CRLF file', async () => {
      const crlfPath = 'Notes/CRLF Task.md';
      const abs = path.join(ctx.tempDir, crlfPath);
      const beforeRaw = fs.readFileSync(abs, 'utf8');
      expect(beforeRaw).toContain('\r\n');
      expect(beforeRaw.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/); // every break is \r\n, none bare

      const { fit } = await fitProposals();
      const proposal = fit.proposals.find((p) => p.file === crlfPath);
      expect(proposal).toBeTruthy();

      const result = await acceptProposals(ctx.app, [proposal!], {
        isDailyNoteFor: () => false,
        weekStart: WEEK_START,
      });
      expect(result.written).toBe(1);
      expect(result.errors).toEqual([]);

      const after = fs.readFileSync(abs, 'utf8');
      // No bare LF slipped in: stripping every \r\n leaves no \n or \r behind.
      expect(after.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);

      const afterLines = after.split('\r\n');
      const range = dayPlannerRange(proposal!.startMin, proposal!.endMin);
      const date = isoDateFor(WEEK_START, proposal!.day);
      expect(afterLines[proposal!.line]).toBe(
        `- [ ] ${range} Ship the CRLF fix #thisweek ⏳ ${date}`,
      );
    });

    it('round trip: after accepting, readWeek again shows the task as scheduled, and Fit no longer proposes it', async () => {
      const { fit: fit1 } = await fitProposals();
      const proposal = fit1.proposals.find((p) => p.text === '- [ ] Book dentist')!;
      expect(proposal).toBeTruthy();

      const result = await acceptProposals(ctx.app, [proposal], {
        isDailyNoteFor: () => false,
        weekStart: WEEK_START,
      });
      expect(result.written).toBe(1);
      expect(result.errors).toEqual([]);

      const snap2 = await ctx.repo.readWeek(WEEK_START);
      expect(snap2.errors).toEqual([]);

      // Not proposed again — the written line now carries a Day Planner
      // range, so `hasPlacement` (real code, not a mock) correctly sees it
      // as already-placed on the very next Fit.
      const fit2 = computeFit(snap2, settings(), WEEK_START);
      expect(
        fit2.proposals.some((p) => p.file === filePath && p.line === proposal.line),
      ).toBe(false);

      // And it must be readable back as a real scheduled block — a write
      // format the reader can't parse would be the worst possible outcome of
      // this whole exercise.
      const scheduledMatch = snap2.scheduled.find(
        (ev) => ev.source === `${filePath}#L${proposal.line}`,
      );
      expect(scheduledMatch).toBeTruthy();
      expect(scheduledMatch!.title).toBe('Book dentist');

      const expectedStart = addDays(WEEK_START, proposal.day);
      expectedStart.setMinutes(proposal.startMin);
      const expectedEnd = addDays(WEEK_START, proposal.day);
      expectedEnd.setMinutes(proposal.endMin);
      expect(scheduledMatch!.start).toEqual(expectedStart);
      expect(scheduledMatch!.end).toEqual(expectedEnd);
    });
  });

  // -------------------------------------------------------------------
  // editPlacements on a real file: accept -> re-time -> unschedule
  // -------------------------------------------------------------------

  describe('editPlacements: accept -> re-time -> unschedule on the same line', () => {
    const filePath = 'Weekly/2026-W36.md';

    async function fitProposals() {
      const snap = await ctx.repo.readWeek(WEEK_START);
      const fit = computeFit(snap, settings(), WEEK_START);
      return { snap, fit };
    }

    it('rewrites the raw bytes correctly at every step, and the file is byte-identical to its original state afterward except for the ⏳ the accept legitimately added', async () => {
      const abs = path.join(ctx.tempDir, filePath);
      const original = fs.readFileSync(abs, 'utf8');
      const originalLines = original.split('\n');

      // --- accept: same path "Fit this week" already uses -----------------
      const { fit } = await fitProposals();
      const proposal = fit.proposals.find((p) => p.text === '- [ ] Book dentist')!;
      expect(proposal).toBeTruthy();

      const acceptResult = await acceptProposals(ctx.app, [proposal], {
        isDailyNoteFor: () => false,
        weekStart: WEEK_START,
      });
      expect(acceptResult.written).toBe(1);
      expect(acceptResult.errors).toEqual([]);
      expect(acceptResult.skipped).toEqual([]);

      const range1 = dayPlannerRange(proposal.startMin, proposal.endMin);
      const date = isoDateFor(WEEK_START, proposal.day);
      const acceptedLine = fs.readFileSync(abs, 'utf8').split('\n')[proposal.line];
      expect(acceptedLine).toBe(`- [ ] ${range1} Book dentist ⏳ ${date}`);

      // --- re-time: editPlacements directly, the same path a drag on the
      // grid or a "change time" action in the view will use -----------------
      const newRange = '14:00 - 15:00';
      const retimeResult = await editPlacements(ctx.app, [
        {
          file: filePath,
          line: proposal.line,
          expectedText: acceptedLine,
          range: newRange,
          scheduledDate: null, // leave the ⏳ this accept just wrote alone
          title: proposal.title,
        },
      ]);
      expect(retimeResult.written).toBe(1);
      expect(retimeResult.skipped).toEqual([]);
      expect(retimeResult.errors).toEqual([]);

      const retimedLine = fs.readFileSync(abs, 'utf8').split('\n')[proposal.line];
      expect(retimedLine).toBe(`- [ ] ${newRange} Book dentist ⏳ ${date}`);

      // Nothing but the target line moved between accept and re-time.
      const afterRetimeLines = fs.readFileSync(abs, 'utf8').split('\n');
      afterRetimeLines.forEach((line, i) => {
        if (i === proposal.line) return;
        expect(line).toBe(originalLines[i]);
      });

      // --- unschedule: range: null, back to the rail -----------------------
      const unscheduleResult = await editPlacements(ctx.app, [
        {
          file: filePath,
          line: proposal.line,
          expectedText: retimedLine,
          range: null,
          scheduledDate: null,
          title: proposal.title,
        },
      ]);
      expect(unscheduleResult.written).toBe(1);
      expect(unscheduleResult.skipped).toEqual([]);
      expect(unscheduleResult.errors).toEqual([]);

      const finalLines = fs.readFileSync(abs, 'utf8').split('\n');
      // The range is gone; the ⏳ date the accept legitimately wrote stays —
      // this file only ever adds a scheduled date, never removes one on
      // unschedule, whether it's ours or (in a real vault) the user's own.
      expect(finalLines[proposal.line]).toBe(`- [ ] Book dentist ⏳ ${date}`);

      // Every other line is byte-identical to the very original file — the
      // only difference anywhere in the file is the ⏳ this exercise
      // legitimately added and then correctly left alone.
      finalLines.forEach((line, i) => {
        if (i === proposal.line) return;
        expect(line).toBe(originalLines[i]);
      });
      expect(finalLines).toHaveLength(originalLines.length);
    });

    it('round trip: after re-timing, readWeek shows the block at the new time; after unscheduling, it is gone from scheduled and back in the unscheduled pool', async () => {
      const abs = path.join(ctx.tempDir, filePath);

      const { fit: fit1 } = await fitProposals();
      const proposal = fit1.proposals.find((p) => p.text === '- [ ] Book dentist')!;
      const acceptResult = await acceptProposals(ctx.app, [proposal], {
        isDailyNoteFor: () => false,
        weekStart: WEEK_START,
      });
      expect(acceptResult.written).toBe(1);

      const acceptedLine = fs.readFileSync(abs, 'utf8').split('\n')[proposal.line];

      // --- re-time, then read back ------------------------------------------
      const newRange = '14:00 - 15:00';
      const retimeResult = await editPlacements(ctx.app, [
        {
          file: filePath,
          line: proposal.line,
          expectedText: acceptedLine,
          range: newRange,
          scheduledDate: null,
          title: proposal.title,
        },
      ]);
      expect(retimeResult.written).toBe(1);

      const snapAfterRetime = await ctx.repo.readWeek(WEEK_START);
      expect(snapAfterRetime.errors).toEqual([]);

      const rescheduled = snapAfterRetime.scheduled.find(
        (ev) => ev.source === `${filePath}#L${proposal.line}`,
      );
      expect(rescheduled).toBeTruthy();
      expect(rescheduled!.title).toBe('Book dentist');

      const expectedStart = addDays(WEEK_START, proposal.day);
      expectedStart.setHours(14, 0, 0, 0);
      const expectedEnd = addDays(WEEK_START, proposal.day);
      expectedEnd.setHours(15, 0, 0, 0);
      expect(rescheduled!.start).toEqual(expectedStart);
      expect(rescheduled!.end).toEqual(expectedEnd);

      // scheduledLines stays index-aligned with scheduled after a real
      // re-time too — the exact property main.ts's wiring depends on to know
      // which line a re-timed block came from.
      const idx = snapAfterRetime.scheduled.indexOf(rescheduled!);
      expect(snapAfterRetime.scheduledLines[idx].line).toBe(proposal.line);
      expect(snapAfterRetime.scheduledLines[idx].file).toBe(filePath);

      const retimedLine = fs.readFileSync(abs, 'utf8').split('\n')[proposal.line];

      // --- unschedule, then read back ------------------------------------
      const unscheduleResult = await editPlacements(ctx.app, [
        {
          file: filePath,
          line: proposal.line,
          expectedText: retimedLine,
          range: null,
          scheduledDate: null,
          title: proposal.title,
        },
      ]);
      expect(unscheduleResult.written).toBe(1);

      const snapAfterUnschedule = await ctx.repo.readWeek(WEEK_START);
      expect(snapAfterUnschedule.errors).toEqual([]);
      expect(
        snapAfterUnschedule.scheduled.some((ev) => ev.source === `${filePath}#L${proposal.line}`),
      ).toBe(false);

      const backInPool = snapAfterUnschedule.tasks.find((t) => t.line === proposal.line);
      expect(backInPool).toBeTruthy();
      expect(backInPool!.text).toContain('Book dentist');
      expect(hasPlacement(backInPool!.text)).toBe(false);

      // And Fit proposes it again — the real proof it's back in the pool,
      // not just absent from `scheduled`.
      const fit2 = computeFit(snapAfterUnschedule, settings(), WEEK_START);
      expect(fit2.proposals.some((p) => p.file === filePath && p.line === proposal.line)).toBe(
        true,
      );
    });
  });
});

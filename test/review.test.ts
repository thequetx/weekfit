import { describe, expect, it, vi } from 'vitest';

// `obsidian` ships no runtime JS — mocked exactly the way test/writer.test.ts
// does it, so there is one mocking style in this repo rather than two.
vi.mock('obsidian', () => {
  class TFile {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  }
  return { TFile };
});

const { computeReview, writeReview, rollForward } = await import('../src/data/review');
const { TFile } = (await import('obsidian')) as unknown as { TFile: new (path: string) => any };
const { startOfISOWeek, addDays } = await import('../src/lib/week');
const { parse: parseYaml, stringify: stringifyYaml } = await import('yaml');
const { DEFAULT_SETTINGS } = await import('../src/data/contract');
import type { WeekSnapshot, WeekfitSettings } from '../src/data/contract';
import type { CalEvent, VaultTask } from '../src/lib/types';

// --- harness, mirroring test/writer.test.ts -------------------------------

class FakeVault {
  files = new Map<string, string>();
  processCalls: string[] = [];
  createCalls: string[] = [];
  /** Set to a path to make every write to it blow up — the only way to prove
   *  roll-forward removes nothing when the append fails. */
  failWritesTo: string | null = null;

  seed(path: string, content: string) {
    this.files.set(path, content);
  }
  getAbstractFileByPath(path: string) {
    return this.files.has(path) ? new TFile(path) : null;
  }
  async cachedRead(file: { path: string }) {
    const data = this.files.get(file.path);
    if (data == null) throw new Error(`no such file: ${file.path}`);
    return data;
  }
  async process(file: { path: string }, fn: (data: string) => string) {
    if (this.failWritesTo === file.path) throw new Error('disk on fire');
    this.processCalls.push(file.path);
    const data = this.files.get(file.path);
    if (data == null) throw new Error(`no such file: ${file.path}`);
    const result = fn(data);
    this.files.set(file.path, result);
    return result;
  }
  async create(path: string, content: string) {
    if (this.failWritesTo === path) throw new Error('disk on fire');
    this.createCalls.push(path);
    this.files.set(path, content);
    return new TFile(path);
  }
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

class FakeFileManager {
  constructor(private vault: FakeVault) {}
  async processFrontMatter(file: { path: string }, fn: (fm: any) => void) {
    const data = this.vault.files.get(file.path);
    if (data == null) throw new Error(`no such file: ${file.path}`);
    const eol = data.includes('\r\n') ? '\r\n' : '\n';
    const m = FRONTMATTER_RE.exec(data);
    const fm: Record<string, unknown> = m ? (parseYaml(m[1]) ?? {}) : {};
    const rest = m ? data.slice(m[0].length) : data;
    fn(fm);
    const yamlBody = stringifyYaml(fm).replace(/\n$/, '').split('\n').join(eol);
    this.vault.files.set(file.path, `---${eol}${yamlBody}${eol}---${eol}` + rest);
  }
}

function makeApp() {
  const vault = new FakeVault();
  const app = { vault, fileManager: new FakeFileManager(vault) } as any;
  return { app, vault };
}

const WEEK_START = startOfISOWeek(new Date(2026, 7, 31)); // Mon 31 Aug 2026
const NOTE = 'Weekly/2026-W36.md';
const NEXT = 'Weekly/2026-W37.md';
// Sunday night, so the whole week has passed and nothing is graded early.
const NOW = addDays(WEEK_START, 6);

function task(text: string, opts: Partial<VaultTask> = {}): VaultTask {
  return { text, done: false, file: NOTE, line: 0, ...opts };
}

function ev(day: number, startMin: number, minutes: number, uid = 'e1'): CalEvent {
  const start = addDays(WEEK_START, day);
  start.setMinutes(startMin);
  const end = new Date(start.getTime() + minutes * 60_000);
  return { uid, title: 'Thing', start, end, allDay: false };
}

function snapshot(over: Partial<WeekSnapshot> = {}): WeekSnapshot {
  return {
    weekId: '2026-W36',
    weekStart: WEEK_START,
    notePath: NOTE,
    intentions: [],
    tasks: [],
    thisweek: [],
    scheduled: [],
    scheduledLines: [],
    errors: [],
    ...over,
  };
}

const settings: WeekfitSettings = DEFAULT_SETTINGS;

// --- the arithmetic -------------------------------------------------------

describe('computeReview', () => {
  it('reports zeroes for an empty week without producing NaN', () => {
    const r = computeReview(snapshot(), settings, NOW);
    expect(r.hoursPlanned).toBe(0);
    expect(r.hoursKept).toBe(0);
    expect(r.tasksTotal).toBe(0);
    expect(r.tasksDone).toBe(0);
    expect(Number.isNaN(r.hoursKept)).toBe(false);
    expect(r.unfinished).toEqual([]);
  });

  it('counts planned hours from every scheduled block', () => {
    const r = computeReview(
      snapshot({
        scheduled: [ev(0, 9 * 60, 90, 'a'), ev(1, 14 * 60, 30, 'b')],
        scheduledLines: [task('- [ ] A', { line: 1 }), task('- [ ] B', { line: 2 })],
      }),
      settings,
      NOW,
    );
    expect(r.hoursPlanned).toBe(2); // 90m + 30m
  });

  it('counts kept hours only for blocks whose task line is ticked', () => {
    const r = computeReview(
      snapshot({
        scheduled: [ev(0, 9 * 60, 90, 'a'), ev(1, 14 * 60, 30, 'b')],
        scheduledLines: [
          task('- [x] A', { line: 1, done: true }),
          task('- [ ] B', { line: 2 }),
        ],
      }),
      settings,
      NOW,
    );
    expect(r.hoursPlanned).toBe(2);
    expect(r.hoursKept).toBe(1.5);
  });

  it('excludes done tasks from unfinished', () => {
    const r = computeReview(
      snapshot({
        tasks: [task('- [ ] Open', { line: 1 }), task('- [x] Shut', { line: 2, done: true })],
      }),
      settings,
      NOW,
    );
    expect(r.unfinished.map((t) => t.text)).toEqual(['- [ ] Open']);
    expect(r.tasksTotal).toBe(2);
    expect(r.tasksDone).toBe(1);
  });

  // The Tasks plugin owns recurrence and regenerates its own next instance.
  // Rolling one forward would duplicate it and fight that plugin.
  it('excludes recurring tasks from unfinished', () => {
    const r = computeReview(
      snapshot({
        tasks: [task('- [ ] Water plants 🔁 every week', { line: 1 }), task('- [ ] Once', { line: 2 })],
      }),
      settings,
      NOW,
    );
    expect(r.unfinished.map((t) => t.text)).toEqual(['- [ ] Once']);
  });

  it('rolls #thisweek tasks as well as the note’s own', () => {
    const r = computeReview(
      snapshot({
        tasks: [task('- [ ] From the note', { line: 1 })],
        thisweek: [task('- [ ] Tagged #thisweek', { file: 'Notes/x.md', line: 4 })],
      }),
      settings,
      NOW,
    );
    expect(r.unfinished).toHaveLength(2);
  });

  it('counts intentions separately from tasks', () => {
    const r = computeReview(
      snapshot({
        intentions: [task('- [x] Did it', { line: 1, done: true }), task('- [ ] Nope', { line: 2 })],
      }),
      settings,
      NOW,
    );
    expect(r.intentionsTotal).toBe(2);
    expect(r.intentionsDone).toBe(1);
    // Intentions never roll forward — they're the shape of the week, not work.
    expect(r.unfinished).toEqual([]);
  });
});

describe('computeReview — work still to come is not "unfinished"', () => {
  // Reported by Tyler: rolling forward mid-week moved everything, including
  // work booked for later the same week. That task has not failed — it has
  // not come up yet — and rolling it strips its placement on the way out.
  //
  // Wednesday 09:00. The Monday block has been and gone; the Friday one has
  // not.
  const WED = (() => {
    const d = addDays(WEEK_START, 2);
    d.setHours(9, 0, 0, 0);
    return d;
  })();

  function block(day: number, startMin: number, minutes: number, title: string, uid: string) {
    const start = addDays(WEEK_START, day);
    start.setMinutes(startMin);
    const end = new Date(start.getTime() + minutes * 60_000);
    return { uid, title, start, end, allDay: false };
  }

  const week = () =>
    snapshot({
      tasks: [
        task('- [ ] 09:00 - 10:00 Monday thing ⏳ 2026-08-31', { line: 1 }),
        task('- [ ] 09:00 - 10:00 Friday thing ⏳ 2026-09-04', { line: 2 }),
        task('- [ ] Never scheduled at all', { line: 3 }),
      ],
      scheduled: [
        block(0, 9 * 60, 60, 'Monday thing', 'Weekly/2026-W36.md:1'),
        block(4, 9 * 60, 60, 'Friday thing', 'Weekly/2026-W36.md:2'),
      ],
      scheduledLines: [
        task('- [ ] 09:00 - 10:00 Monday thing ⏳ 2026-08-31', { line: 1 }),
        task('- [ ] 09:00 - 10:00 Friday thing ⏳ 2026-09-04', { line: 2 }),
      ],
    });

  it('leaves a task still scheduled later in the week alone', () => {
    const r = computeReview(week(), settings, WED);
    const titles = r.unfinished.map((t) => t.text);
    expect(titles.join(' ')).not.toContain('Friday thing');
  });

  it('still rolls a task whose block has been and gone', () => {
    const r = computeReview(week(), settings, WED);
    expect(r.unfinished.map((t) => t.text).join(' ')).toContain('Monday thing');
  });

  it('still rolls a task that was never scheduled', () => {
    const r = computeReview(week(), settings, WED);
    expect(r.unfinished.map((t) => t.text).join(' ')).toContain('Never scheduled at all');
  });

  it('rolls everything once the week is actually over', () => {
    const after = addDays(WEEK_START, 8);
    const r = computeReview(week(), settings, after);
    expect(r.unfinished).toHaveLength(3);
    expect(r.weekHasEnded).toBe(true);
  });

  it('reports the week as not ended when it is mid-week', () => {
    expect(computeReview(week(), settings, WED).weekHasEnded).toBe(false);
  });
});
// --- writeReview ----------------------------------------------------------

describe('writeReview', () => {
  const body = ['---', 'week: 2026-W36', 'status: active', '---', '', '## Review', '', ''].join('\n');

  it('sets the documented frontmatter and leaves unrelated keys alone', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, body);
    const snap = snapshot({ scheduled: [ev(0, 9 * 60, 60, 'a')], scheduledLines: [task('- [ ] A')] });
    const review = computeReview(snap, settings, NOW);

    const result = await writeReview(app, snap, review, settings);
    expect(result.errors).toEqual([]);

    const fm = parseYaml(FRONTMATTER_RE.exec(vault.files.get(NOTE) as string)![1]);
    expect(fm.status).toBe('reviewed');
    expect(fm.week).toBe('2026-W36'); // untouched
    expect(fm).toHaveProperty('hours_planned');
    expect(fm).toHaveProperty('hours_kept');
    expect(fm).toHaveProperty('tasks_total');
    expect(fm).toHaveProperty('tasks_done');
  });

  // The one that matters: a review is something you might run twice, and a
  // note that grows a duplicate audit each time is a note you stop trusting.
  it('is idempotent — running it twice does not duplicate the audit', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, body);
    const snap = snapshot({ scheduled: [ev(0, 9 * 60, 60, 'a')], scheduledLines: [task('- [ ] A')] });
    const review = computeReview(snap, settings, NOW);

    await writeReview(app, snap, review, settings);
    const afterFirst = vault.files.get(NOTE) as string;
    await writeReview(app, snap, review, settings);
    const afterSecond = vault.files.get(NOTE) as string;

    const count = (s: string) => s.split('\n').filter((l) => l.startsWith('- Audit:')).length;
    expect(count(afterSecond)).toBe(count(afterFirst));
  });
});

// --- rollForward ----------------------------------------------------------

describe('rollForward', () => {
  const thisWeek = ['## Tasks', '', '- [ ] Alpha ~90m 📅 2026-09-04 🔼 #content', '- [ ] Beta', '', '## Review', ''].join('\n');
  const nextWeek = ['## Tasks', '', '## Review', ''].join('\n');

  it('carries unfinished tasks into next week and removes them from this one', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, thisWeek);
    vault.seed(NEXT, nextWeek);
    const snap = snapshot({
      tasks: [task('- [ ] Alpha ~90m 📅 2026-09-04 🔼 #content', { line: 2 }), task('- [ ] Beta', { line: 3 })],
    });
    const review = computeReview(snap, settings, NOW);

    const result = await rollForward(app, snap, review, NEXT, settings);
    expect(result.errors).toEqual([]);

    const after = vault.files.get(NEXT) as string;
    // Metadata survives the move — the estimate, the due date, the priority
    // and the tag are all still there.
    expect(after).toContain('- [ ] Alpha ~90m 📅 2026-09-04 🔼 #content');
    expect(after).toContain('- [ ] Beta');

    const source = vault.files.get(NOTE) as string;
    expect(source).not.toContain('Alpha');
    expect(source).not.toContain('Beta');
    expect(source).toContain('## Review'); // nothing else disturbed
  });

  it('strips a time range and scheduled date on the way — a placement in a finished week means nothing', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, ['## Tasks', '', '- [ ] 09:00 - 10:00 Alpha ~90m ⏳ 2026-09-01', ''].join('\n'));
    vault.seed(NEXT, nextWeek);
    const snap = snapshot({
      tasks: [task('- [ ] 09:00 - 10:00 Alpha ~90m ⏳ 2026-09-01', { line: 2 })],
    });
    const review = computeReview(snap, settings, NOW);
    await rollForward(app, snap, review, NEXT, settings);

    const after = vault.files.get(NEXT) as string;
    expect(after).toContain('~90m');
    expect(after).not.toContain('09:00 - 10:00');
    expect(after).not.toContain('2026-09-01');
  });

  // The most important test in this file. Losing a user's tasks between two
  // files is unrecoverable; a duplicate is trivially fixable by comparison.
  // So the append must happen first, and a failed append must remove nothing.
  it('removes nothing when the append fails', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, thisWeek);
    vault.seed(NEXT, nextWeek);
    vault.failWritesTo = NEXT;

    const snap = snapshot({
      tasks: [task('- [ ] Alpha ~90m 📅 2026-09-04 🔼 #content', { line: 2 }), task('- [ ] Beta', { line: 3 })],
    });
    const review = computeReview(snap, settings, NOW);

    const result = await rollForward(app, snap, review, NEXT, settings);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.written).toBe(0);
    // The source note is byte-identical. Nothing was lost.
    expect(vault.files.get(NOTE)).toBe(thisWeek);
  });

  it('does nothing at all when there is nothing unfinished', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, thisWeek);
    vault.seed(NEXT, nextWeek);
    const review = computeReview(snapshot(), settings, NOW);
    const result = await rollForward(app, snapshot(), review, NEXT, settings);
    expect(result).toEqual({ written: 0, skipped: [], errors: [] });
    expect(vault.processCalls).toEqual([]);
    expect(vault.files.get(NOTE)).toBe(thisWeek);
  });

  it('skips a line that changed under the user rather than moving the wrong one', async () => {
    const { app, vault } = makeApp();
    vault.seed(NOTE, thisWeek);
    vault.seed(NEXT, nextWeek);
    const snap = snapshot({
      // Line 2 claims text that isn't what's actually on line 2 any more.
      tasks: [task('- [ ] Something else entirely', { line: 2 })],
    });
    const review = computeReview(snap, settings, NOW);
    const result = await rollForward(app, snap, review, NEXT, settings);

    expect(result.skipped.map((s) => s.reason)).toContain('line-changed');
    expect(vault.files.get(NOTE)).toBe(thisWeek);
  });
});

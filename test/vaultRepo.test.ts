import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// `obsidian` ships no runtime JS (types only — the real module is injected by
// the Obsidian app itself), so it has to be mocked for anything importing
// `VaultRepo` to run under plain `node`/vitest. `moment` is re-exported from
// the *real* `moment` package (already a devDependency) so format strings
// like `YYYY-[W]WW` behave exactly as they will inside Obsidian, which
// reuses that same library. `TFile` is a minimal stand-in — VaultRepo only
// ever checks `instanceof TFile` and reads `.path`/`.name` off it.
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
  // `VaultRepo` now pulls in `data/ics.ts`, which imports `requestUrl` from
  // 'obsidian' at module load time — so the mock needs to export *something*
  // callable even in tests that never touch a calendar feed. Individual
  // tests below set its resolved value; everything else just needs it to
  // exist so the import doesn't throw.
  const requestUrl = vi.fn();
  return { moment, TFile, requestUrl };
});

// `VaultRepo` debounces with `window.setTimeout` rather than the bare global.
// Obsidian asks for that so a timer belongs to whichever popout window the
// view is actually in, and dies with it. Node has no `window`, but its timers
// are the very same functions — so pointing `window` at `globalThis` is a
// faithful stand-in, not a fake that could hide a real difference.
vi.stubGlobal('window', globalThis);

const { VaultRepo } = await import('../src/data/vaultRepo');
const { TFile, requestUrl } = (await import('obsidian')) as unknown as {
  TFile: new (path: string) => any;
  requestUrl: ReturnType<typeof vi.fn>;
};
const { DEFAULT_SETTINGS } = await import('../src/data/contract');
import type { WeekfitSettings } from '../src/data/contract';

// --- a minimal fake App -----------------------------------------------------
//
// `EventRef`s in real Obsidian carry their own emitter internally, so calling
// `.offref()` on *any* Events-derived object correctly unregisters a ref that
// came from a *different* one (that's how `vault.offref(metadataCacheRef)`
// works in the real API). `FakeEvents.on` returns a ref whose `off()` closes
// over its own handler set, and `offref` just calls it — reproducing that
// behaviour without needing to fake the whole class hierarchy.
class FakeEvents {
  private handlers = new Map<string, Set<(...args: any[]) => void>>();
  on(name: string, cb: (...args: any[]) => void) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name)!.add(cb);
    return { off: () => this.handlers.get(name)?.delete(cb) };
  }
  offref(ref: { off: () => void }) {
    ref.off();
  }
  trigger(name: string, ...args: any[]) {
    for (const cb of [...(this.handlers.get(name) ?? [])]) cb(...args);
  }
  listenerCount(name: string): number {
    return this.handlers.get(name)?.size ?? 0;
  }
}

interface FakeFile {
  content: string;
  tags?: string[]; // e.g. ['#thisweek']
  unreadable?: boolean;
}

class FakeVault extends FakeEvents {
  files = new Map<string, FakeFile>();

  seed(path: string, content: string, tags?: string[]) {
    this.files.set(path, { content, tags });
  }

  seedUnreadable(path: string) {
    this.files.set(path, { content: '', unreadable: true });
  }

  getAbstractFileByPath(path: string) {
    return this.files.has(path) ? new TFile(path) : null;
  }

  getMarkdownFiles() {
    return [...this.files.keys()].map((p) => new TFile(p));
  }

  async cachedRead(file: { path: string }) {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`no such file: ${file.path}`);
    if (entry.unreadable) throw new Error('simulated read failure');
    return entry.content;
  }
}

/** Just enough of real Obsidian frontmatter parsing for the one field
 *  `VaultRepo` reads (`status`) — a leading `---`-delimited block, one
 *  `key: value` per line. Good enough for the weekly note's own frontmatter
 *  shape; not a general YAML parser. */
function parseFrontmatterStatus(content: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return undefined;
  const line = m[1].split(/\r?\n/).find((l) => /^status\s*:/.test(l));
  return line ? line.split(':').slice(1).join(':').trim() : undefined;
}

class FakeMetadataCache extends FakeEvents {
  constructor(private vault: FakeVault) {
    super();
  }
  getFileCache(file: { path: string }) {
    const entry = this.vault.files.get(file.path);
    if (!entry) return null;
    const status = parseFrontmatterStatus(entry.content);
    return {
      tags: (entry.tags ?? []).map((tag) => ({ tag })),
      frontmatter: status ? { status } : undefined,
    };
  }
}

function makeApp() {
  const vault = new FakeVault();
  const metadataCache = new FakeMetadataCache(vault);
  const app = { vault, metadataCache } as any;
  return { app, vault, metadataCache };
}

function settings(overrides: Partial<WeekfitSettings> = {}): WeekfitSettings {
  return { ...DEFAULT_SETTINGS, usePeriodicNotes: false, ...overrides };
}

// Monday 2026-08-31, ISO week 2026-W36 — same week the fixture vault
// (C:/Users/tyler/weekfit-scratch) uses, but every fixture here is inlined so
// the tests stay hermetic.
const WEEK_START = new Date(2026, 7, 31);

const WEEKLY_NOTE = `---
week: 2026-W36
---

## Intentions

- [ ] Ship the Weekfit Phase 0 scaffold

## Tasks

- [ ] Book dentist
- [ ] Plan next stream #content
- [ ] 09:00 - 10:30 Fix badge alpha

## Review

`;

describe('VaultRepo.readWeek', () => {
  it('populates every WeekSnapshot field from a weekly note', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', WEEKLY_NOTE);
    const repo = new VaultRepo(app, () => settings());

    const snap = await repo.readWeek(WEEK_START);

    expect(snap.weekId).toBe('2026-W36');
    expect(snap.weekStart).toEqual(WEEK_START);
    expect(snap.notePath).toBe('Weekly/2026-W36.md');
    expect(snap.intentions).toHaveLength(1);
    expect(snap.intentions[0].text).toBe('- [ ] Ship the Weekfit Phase 0 scaffold');
    expect(snap.tasks.map((t) => t.text)).toEqual([
      '- [ ] Book dentist',
      '- [ ] Plan next stream #content',
      '- [ ] 09:00 - 10:30 Fix badge alpha',
    ]);
    // The Day Planner line in the weekly note has no note-date and no
    // ⏳/[scheduled::] field, so it's unresolved rather than emitted.
    expect(snap.scheduled).toEqual([]);
    expect(snap.errors).toHaveLength(1);
    expect(snap.errors[0]).toMatch(/1 timed line in 2026-W36\.md has no date/);
    expect(snap.thisweek).toEqual([]);
  });

  it('reports notePath: null and empty arrays when the weekly note does not exist', async () => {
    const { app } = makeApp();
    const repo = new VaultRepo(app, () => settings());
    const snap = await repo.readWeek(WEEK_START);

    expect(snap.notePath).toBeNull();
    expect(snap.intentions).toEqual([]);
    expect(snap.tasks).toEqual([]);
    expect(snap.scheduled).toEqual([]);
    expect(snap.errors).toEqual([]);
  });

  it('resolves a Day Planner line to a real day when it carries a daily note', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] Book dentist\n');
    vault.seed('2026-09-02.md', '- [ ] 09:00 - 10:30 Fix badge alpha\n');
    const repo = new VaultRepo(app, () => settings({ noteMode: 'auto' }));

    const snap = await repo.readWeek(WEEK_START);
    expect(snap.scheduled).toHaveLength(1);
    expect(snap.scheduled[0].title).toBe('Fix badge alpha');
    expect(snap.scheduled[0].start).toEqual(new Date(2026, 8, 2, 9, 0));
    expect(snap.errors).toEqual([]);
  });

  it('does not read daily notes in "weekly" mode', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] Book dentist\n');
    vault.seed('2026-09-02.md', '- [ ] 09:00 - 10:30 Fix badge alpha\n');
    const repo = new VaultRepo(app, () => settings({ noteMode: 'weekly' }));

    const snap = await repo.readWeek(WEEK_START);
    expect(snap.scheduled).toEqual([]);
  });

  it('does not read the weekly note in "daily" mode', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] From weekly note\n');
    vault.seed('2026-09-02.md', '## Tasks\n\n- [ ] From daily note\n');
    const repo = new VaultRepo(app, () => settings({ noteMode: 'daily' }));

    const snap = await repo.readWeek(WEEK_START);
    expect(snap.tasks.map((t) => t.text)).toEqual(['- [ ] From daily note']);
  });

  it('sweeps #thisweek using the metadata cache tag pre-filter, reading only tagged files', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] Book dentist\n');
    vault.seed('Notes/Loose ideas.md', '- [ ] Plan next stream #thisweek\n', ['#thisweek']);
    vault.seed('Notes/Untagged.md', 'Just prose, no tag at all.\n'); // no tags in cache

    let readCount = 0;
    const realRead = vault.cachedRead.bind(vault);
    vault.cachedRead = (async (f: any) => {
      readCount++;
      return realRead(f);
    }) as any;

    const repo = new VaultRepo(app, () => settings());
    const snap = await repo.readWeek(WEEK_START);

    expect(snap.thisweek).toHaveLength(1);
    expect(snap.thisweek[0].text).toBe('- [ ] Plan next stream #thisweek');
    // Weekly note (1) + the tagged file (1) = 2 reads. The untagged note is
    // never read at all — the tag pre-filter did its job.
    expect(readCount).toBe(2);
  });

  it('de-duplicates a task that is in both ## Tasks and the #thisweek sweep', async () => {
    const { app, vault } = makeApp();
    vault.seed(
      'Weekly/2026-W36.md',
      '## Tasks\n\n- [ ] Plan next stream #thisweek\n',
      ['#thisweek'],
    );
    const repo = new VaultRepo(app, () => settings());
    const snap = await repo.readWeek(WEEK_START);

    expect(snap.tasks).toHaveLength(1);
    expect(snap.thisweek).toEqual([]); // already counted in `tasks`
  });

  it('excludes settings.excludeFolders and any "Handoff Log.md" file from the sweep', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] Book dentist\n');
    vault.seed('Action Plan/Phase 1.md', '- [ ] excluded by folder #thisweek\n', ['#thisweek']);
    vault.seed('Project Handoff Log.md', '- [ ] excluded by filename #thisweek\n', ['#thisweek']);
    vault.seed('Notes/Kept.md', '- [ ] kept #thisweek\n', ['#thisweek']);

    const repo = new VaultRepo(app, () => settings({ excludeFolders: ['Action Plan'] }));
    const snap = await repo.readWeek(WEEK_START);

    expect(snap.thisweek.map((t) => t.file)).toEqual(['Notes/Kept.md']);
  });

  it('keeps scheduledLines index-aligned with scheduled across the weekly note and multiple daily notes', async () => {
    const { app, vault } = makeApp();
    // Two scheduled events in the weekly note (one resolved via ⏳, one
    // undated task mixed in between that must not shift anything), plus one
    // scheduled event in each of two daily notes. This is the shape a real
    // vault produces once `noteMode: 'auto'` reads both the weekly note and
    // the week's daily notes for Day Planner lines.
    vault.seed(
      'Weekly/2026-W36.md',
      [
        '## Tasks',
        '',
        '- [ ] 08:00 - 08:30 Weekly first ⏳ 2026-08-31',
        '- [ ] Plain undated task, no time range at all',
        '- [ ] 09:00 - 09:30 Weekly second ⏳ 2026-09-02',
        '',
      ].join('\n'),
    );
    vault.seed('2026-09-01.md', ['- [ ] 10:00 - 10:30 Daily Tuesday task', ''].join('\n'));
    vault.seed(
      '2026-09-03.md',
      ['- [ ] Untimed daily task', '- [ ] 11:00 - 11:30 Daily Thursday task', ''].join('\n'),
    );

    const repo = new VaultRepo(app, () => settings({ noteMode: 'auto' }));
    const snap = await repo.readWeek(WEEK_START);

    expect(snap.scheduled).toHaveLength(4);
    expect(snap.scheduledLines).toHaveLength(4);

    // Alignment, checked by content rather than just by length — an
    // off-by-one that merely dropped one pair from the end would still pass
    // a bare length check but fail this.
    snap.scheduled.forEach((ev, i) => {
      const line = snap.scheduledLines[i];
      const parsed = /^(.*?)#L(\d+)$/.exec(ev.source!);
      expect(parsed).toBeTruthy();
      const [, file, lineNoStr] = parsed!;
      expect(line.file).toBe(file);
      expect(line.line).toBe(Number(lineNoStr));
      // The raw line really does contain this event's title — proof
      // `scheduledLines[i]` is the real line `scheduled[i]` was read from,
      // not just a same-length coincidence.
      expect(line.text).toContain(ev.title);
    });

    expect(snap.scheduled.map((e) => e.title)).toEqual([
      'Weekly first',
      'Weekly second',
      'Daily Tuesday task',
      'Daily Thursday task',
    ]);
    expect(snap.scheduledLines.map((l) => l.text)).toEqual([
      '- [ ] 08:00 - 08:30 Weekly first ⏳ 2026-08-31',
      '- [ ] 09:00 - 09:30 Weekly second ⏳ 2026-09-02',
      '- [ ] 10:00 - 10:30 Daily Tuesday task',
      '- [ ] 11:00 - 11:30 Daily Thursday task',
    ]);
    expect(snap.scheduledLines.map((l) => l.line)).toEqual([2, 4, 0, 1]);
  });

  it('never throws when a file is unreadable, and records an error instead', async () => {
    const { app, vault } = makeApp();
    vault.seedUnreadable('Weekly/2026-W36.md');
    const repo = new VaultRepo(app, () => settings());

    await expect(repo.readWeek(WEEK_START)).resolves.toBeDefined();
    const snap = await repo.readWeek(WEEK_START);
    expect(snap.errors.some((e) => e.includes('Could not read'))).toBe(true);
  });
});

describe('VaultRepo — ICS calendar feed', () => {
  // `fetchIcsEvents` (data/ics.ts) windows its fetch off the wall clock by
  // default, so these tests pin `now` to the middle of WEEK_START's week —
  // the same discipline the rest of this codebase uses for anything
  // clock-dependent, just done here via `vi.setSystemTime` since
  // `VaultRepo.fetchIcsEvents()` has no `now` parameter of its own (it isn't
  // one of `readWeek`'s inputs — see the settings-driven signature in the
  // spec).
  const NOW = new Date(2026, 7, 31, 12, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    requestUrl.mockReset();
  });

  function icsCal(...events: string[]): string {
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
  }

  // One event that lands inside fetchIcsEvents' -2/+8 week window around NOW.
  const IN_WINDOW_EVENT =
    'BEGIN:VEVENT\r\nUID:standup\r\nSUMMARY:Standup\r\nDTSTART:20260901T090000Z\r\nDTEND:20260901T093000Z\r\nEND:VEVENT';

  function serveIcs(body: string, status = 200) {
    requestUrl.mockResolvedValue({ status, text: body });
  }

  it('merges Day Planner lines and calendar events into scheduled', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] 09:00 - 09:30 Fix badge alpha ⏳ 2026-09-01\n');
    serveIcs(icsCal(IN_WINDOW_EVENT));
    const repo = new VaultRepo(
      app,
      () => settings({ icsUrl: 'https://example.invalid/basic.ics' }),
    );

    const snap = await repo.readWeek(WEEK_START);

    expect(snap.scheduled.map((e) => e.title)).toEqual(['Fix badge alpha', 'Standup']);
    expect(snap.icsEvents.map((e) => e.title)).toEqual(['Standup']);
    // ICS events ride at the tail, past every real vault line.
    expect(snap.scheduledLines).toHaveLength(1);
  });

  it('skips the ICS merge entirely for a week whose frontmatter status is reviewed', async () => {
    const { app, vault } = makeApp();
    vault.seed(
      'Weekly/2026-W36.md',
      '---\nstatus: reviewed\n---\n\n## Tasks\n\n- [ ] Book dentist\n',
    );
    serveIcs(icsCal(IN_WINDOW_EVENT));
    const repo = new VaultRepo(
      app,
      () => settings({ icsUrl: 'https://example.invalid/basic.ics' }),
    );

    const snap = await repo.readWeek(WEEK_START);

    expect(snap.icsEvents).toEqual([]);
    expect(snap.scheduled).toEqual([]);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it('a planning/active/missing status still gets ICS (only "reviewed" is excluded)', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '---\nstatus: planning\n---\n\n## Tasks\n\n- [ ] Book dentist\n');
    serveIcs(icsCal(IN_WINDOW_EVENT));
    const repo = new VaultRepo(
      app,
      () => settings({ icsUrl: 'https://example.invalid/basic.ics' }),
    );

    const snap = await repo.readWeek(WEEK_START);
    expect(snap.icsEvents.map((e) => e.title)).toEqual(['Standup']);
  });

  it('keeps ICS events out of scheduled (but still on icsEvents) when the busy toggle is off', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] 09:00 - 09:30 Fix badge alpha ⏳ 2026-09-01\n');
    serveIcs(icsCal(IN_WINDOW_EVENT));
    const repo = new VaultRepo(
      app,
      () => settings({ icsUrl: 'https://example.invalid/basic.ics', icsEventsBusy: false }),
    );

    const snap = await repo.readWeek(WEEK_START);

    expect(snap.scheduled.map((e) => e.title)).toEqual(['Fix badge alpha']);
    expect(snap.icsEvents.map((e) => e.title)).toEqual(['Standup']);
  });

  it('leaves the week readable when the calendar feed fails', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] Book dentist\n');
    requestUrl.mockRejectedValue(new Error('network is down'));
    const repo = new VaultRepo(
      app,
      () => settings({ icsUrl: 'https://example.invalid/basic.ics' }),
    );

    const snap = await repo.readWeek(WEEK_START);

    expect(snap.icsEvents).toEqual([]);
    expect(snap.tasks.map((t) => t.text)).toEqual(['- [ ] Book dentist']);
    expect(snap.errors).toEqual([]);
  });

  it('does not call requestUrl at all when no icsUrl is configured', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] Book dentist\n');
    const repo = new VaultRepo(app, () => settings());

    const snap = await repo.readWeek(WEEK_START);

    expect(snap.icsEvents).toEqual([]);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  // `readWeek` runs on every debounced vault change, so an uncached fetch here
  // would put a request to the user's calendar provider on the wire every time
  // they pause typing in *any* note. These three cover the cache that stops it.
  it('re-reading the same week does not re-fetch the feed', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] Book dentist\n');
    serveIcs(icsCal(IN_WINDOW_EVENT));
    const repo = new VaultRepo(app, () => settings({ icsUrl: 'https://example.invalid/basic.ics' }));

    const first = await repo.readWeek(WEEK_START);
    const second = await repo.readWeek(WEEK_START);

    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(second.icsEvents.map((e) => e.uid)).toEqual(first.icsEvents.map((e) => e.uid));
  });

  it('goes back to the network once the cache has aged out', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] Book dentist\n');
    serveIcs(icsCal(IN_WINDOW_EVENT));
    const repo = new VaultRepo(app, () => settings({ icsUrl: 'https://example.invalid/basic.ics' }));

    await repo.readWeek(WEEK_START);
    vi.setSystemTime(new Date(NOW.getTime() + 61 * 60 * 1000));
    await repo.readWeek(WEEK_START);

    expect(requestUrl).toHaveBeenCalledTimes(2);
  });

  it('changing the URL setting takes effect immediately rather than waiting out the cache', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] Book dentist\n');
    serveIcs(icsCal(IN_WINDOW_EVENT));
    let url = 'https://example.invalid/one.ics';
    const repo = new VaultRepo(app, () => settings({ icsUrl: url }));

    await repo.readWeek(WEEK_START);
    url = 'https://example.invalid/two.ics';
    await repo.readWeek(WEEK_START);

    expect(requestUrl).toHaveBeenCalledTimes(2);
  });

  it('an explicit refresh bypasses the cache', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '## Tasks\n\n- [ ] Book dentist\n');
    serveIcs(icsCal(IN_WINDOW_EVENT));
    const repo = new VaultRepo(app, () => settings({ icsUrl: 'https://example.invalid/basic.ics' }));

    await repo.readWeek(WEEK_START);
    await repo.fetchIcsEvents(true);

    expect(requestUrl).toHaveBeenCalledTimes(2);
  });
});

describe('VaultRepo.readIcsLinks', () => {
  // Found in manual testing against a real vault, and the reason this is not
  // scoped to `filesInScope`. `taskFolders` bounds the `#thisweek` sweep; the
  // captured task lands in the *weekly* note, which is hardly ever inside it.
  // Scoping the marker search to it made every refresh report "up to date"
  // forever while tracking nothing — silent, permanent, and indistinguishable
  // from working.
  it('finds a marker in the weekly note even when taskFolders excludes that folder', async () => {
    const { app, vault } = makeApp();
    vault.seed(
      'Weekly/2026-W36.md',
      '## Tasks\n\n- [ ] 13:00 - 14:30 Python 101 lecture [ics-uid:: py101-local]\n',
    );
    const repo = new VaultRepo(app, () => settings({ taskFolders: ['Notes', 'Projects'] }));

    const links = await repo.readIcsLinks();

    expect(links.map((l) => l.uid)).toEqual(['py101-local']);
    expect(links[0].path).toBe('Weekly/2026-W36.md');
  });

  it('still honours excludeFolders when searching for markers', async () => {
    const { app, vault } = makeApp();
    vault.seed('Templates/Weekly.md', '- [ ] Placeholder [ics-uid:: template-uid]\n');
    vault.seed('Weekly/2026-W36.md', '- [ ] Real one [ics-uid:: real-uid]\n');
    const repo = new VaultRepo(app, () => settings({ excludeFolders: ['Templates'] }));

    const links = await repo.readIcsLinks();

    expect(links.map((l) => l.uid)).toEqual(['real-uid']);
  });

  it('finds a checkbox line carrying an [ics-uid::] marker', async () => {
    const { app, vault } = makeApp();
    vault.seed(
      'Weekly/2026-W36.md',
      '## Tasks\n\n- [ ] Dentist appointment [ics-uid:: cal-abc/123]\n',
    );
    const repo = new VaultRepo(app, () => settings());

    const links = await repo.readIcsLinks();

    expect(links).toEqual([
      {
        uid: 'cal-abc/123',
        path: 'Weekly/2026-W36.md',
        line: 2,
        text: '- [ ] Dentist appointment [ics-uid:: cal-abc/123]',
      },
    ]);
  });

  it('finds the parenthesised (ics-uid:: …) flavour too', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '- [ ] Standup (ics-uid:: standup-2026)\n');
    const repo = new VaultRepo(app, () => settings());

    const links = await repo.readIcsLinks();
    expect(links.map((l) => l.uid)).toEqual(['standup-2026']);
  });

  it('ignores a non-checkbox line mentioning the same marker text', async () => {
    const { app, vault } = makeApp();
    vault.seed(
      'Weekly/2026-W36.md',
      'Notes: the marker looks like [ics-uid:: not-a-task] but this line has no checkbox.\n' +
        '- [ ] Real task [ics-uid:: real-uid]\n',
    );
    const repo = new VaultRepo(app, () => settings());

    const links = await repo.readIcsLinks();
    expect(links.map((l) => l.uid)).toEqual(['real-uid']);
  });

  it('respects excludeFolders', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '- [ ] Kept [ics-uid:: kept-uid]\n');
    vault.seed('Templates/Skip.md', '- [ ] Skipped [ics-uid:: skipped-uid]\n');
    const repo = new VaultRepo(app, () => settings({ excludeFolders: ['Templates'] }));

    const links = await repo.readIcsLinks();
    expect(links.map((l) => l.uid)).toEqual(['kept-uid']);
  });

  it('tolerates a file that fails to read, still returning links from the rest of the vault', async () => {
    const { app, vault } = makeApp();
    vault.seed('Weekly/2026-W36.md', '- [ ] Kept [ics-uid:: kept-uid]\n');
    vault.seedUnreadable('Weekly/Broken.md');
    const repo = new VaultRepo(app, () => settings());

    const links = await repo.readIcsLinks();
    expect(links.map((l) => l.uid)).toEqual(['kept-uid']);
  });
});

describe('VaultRepo.onChange', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces bursts of vault events into a single callback', () => {
    const { app, vault } = makeApp();
    const repo = new VaultRepo(app, () => settings());
    const cb = vi.fn();
    repo.onChange(cb);

    vault.trigger('modify');
    vault.trigger('modify');
    vault.trigger('modify');
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(299);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires on metadataCache "changed" too', () => {
    const { app, metadataCache } = makeApp();
    const repo = new VaultRepo(app, () => settings());
    const cb = vi.fn();
    repo.onChange(cb);

    metadataCache.trigger('changed');
    vi.advanceTimersByTime(300);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('the returned unsubscribe releases every EventRef and stops future callbacks', () => {
    const { app, vault, metadataCache } = makeApp();
    const repo = new VaultRepo(app, () => settings());
    const cb = vi.fn();
    const unsubscribe = repo.onChange(cb);

    expect(vault.listenerCount('modify')).toBeGreaterThan(0);
    expect(metadataCache.listenerCount('changed')).toBeGreaterThan(0);

    unsubscribe();

    expect(vault.listenerCount('modify')).toBe(0);
    expect(vault.listenerCount('create')).toBe(0);
    expect(vault.listenerCount('delete')).toBe(0);
    expect(vault.listenerCount('rename')).toBe(0);
    expect(metadataCache.listenerCount('changed')).toBe(0);

    vault.trigger('modify');
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe also cancels a pending debounced call', () => {
    const { app, vault } = makeApp();
    const repo = new VaultRepo(app, () => settings());
    const cb = vi.fn();
    const unsubscribe = repo.onChange(cb);

    vault.trigger('modify');
    unsubscribe();
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
  });
});

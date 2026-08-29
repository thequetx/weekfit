import { describe, expect, it } from 'vitest';
import { buildCaptureLine, collectBacklog } from '../src/data/backlog';
import { DEFAULT_SETTINGS } from '../src/data/contract';
import type { WeekfitSettings } from '../src/data/contract';
import type { VaultTask } from '../src/lib/types';

// Same discipline `rail.test.tsx` documents: `parse.ts` stores the **whole
// raw line** in `VaultTask.text`, checkbox and all, and `hasPlacement` (via
// `DAY_PLANNER_RE`, `^`-anchored against a line's *body*) only gives the
// right answer against a real line. A fixture that omitted the `- [ ] `
// prefix would let an "already scheduled" exclusion ship broken behind a
// green test — that bug shipped once already. So: prefix by default.
function task(text: string, opts: Partial<VaultTask> = {}): VaultTask {
  return {
    text: `- [ ] ${text}`,
    done: false,
    file: 'Weekly/2026-W36.md',
    line: 0,
    ...opts,
  };
}

function settingsWith(byKind: Record<string, number> = {}): WeekfitSettings {
  return { ...DEFAULT_SETTINGS, durations: { defaultMinutes: 60, byKind } };
}

describe('collectBacklog', () => {
  it('excludes a done task', () => {
    const items = collectBacklog(
      [task('Finished already', { done: true }), task('Still open')],
      settingsWith(),
    );
    expect(items.map((i) => i.meta.title)).toEqual(['Still open']);
  });

  it('excludes a task that already carries a Day Planner range, on a realistic full line', () => {
    // A real vault line: checkbox prefix *and* the leading range together —
    // not a bare body, which is exactly the shape that let this exclusion
    // ship broken once (DAY_PLANNER_RE is `^`-anchored against the body,
    // not the raw line `hasPlacement` is actually handed).
    const items = collectBacklog(
      [task('09:00 - 10:00 Already scheduled'), task('Not yet scheduled')],
      settingsWith(),
    );
    expect(items.map((i) => i.meta.title)).toEqual(['Not yet scheduled']);
  });

  it('sizes an explicit ~90m estimate from the line itself, source "override"', () => {
    const [item] = collectBacklog([task('Write the report ~90m')], settingsWith());
    expect(item.est.minutes).toBe(90);
    expect(item.est.source).toBe('override');
  });

  it('sizes an untagged-but-kinded task from durations.byKind, source "kind"', () => {
    const [item] = collectBacklog(
      [task('Edit the clip #content')],
      settingsWith({ content: 45 }),
    );
    expect(item.est.minutes).toBe(45);
    expect(item.est.source).toBe('kind');
  });

  it('falls back to the global default when nothing else fires, source "default"', () => {
    const [item] = collectBacklog([task('Do the thing')], settingsWith());
    expect(item.est.minutes).toBe(60);
    expect(item.est.source).toBe('default');
  });

  it('sorts by priority then due date (compareMeta order)', () => {
    const items = collectBacklog(
      [
        task('Low priority, no date 🔽'),
        task('Highest priority 🔺'),
        task('Due sooner 📅 2026-09-01'),
        task('Due later 📅 2026-09-10'),
      ],
      settingsWith(),
    );
    expect(items.map((i) => i.meta.title)).toEqual([
      'Highest priority',
      'Due sooner',
      'Due later',
      'Low priority, no date',
    ]);
  });

  it('returns an empty list for an empty input, without throwing', () => {
    expect(() => collectBacklog([], settingsWith())).not.toThrow();
    expect(collectBacklog([], settingsWith())).toEqual([]);
  });
});

describe('buildCaptureLine', () => {
  it('wraps plain text in an open checkbox line', () => {
    expect(buildCaptureLine('Buy milk')).toBe('- [ ] Buy milk');
  });

  it('does not double-prefix a line that already starts with "- [ ] "', () => {
    expect(buildCaptureLine('- [ ] Buy milk')).toBe('- [ ] Buy milk');
  });

  it('trims trailing whitespace before writing', () => {
    expect(buildCaptureLine('Buy milk   ')).toBe('- [ ] Buy milk');
  });

  it('writes nothing for an empty submit', () => {
    expect(buildCaptureLine('')).toBeNull();
  });

  it('writes nothing for a whitespace-only submit', () => {
    expect(buildCaptureLine('   ')).toBeNull();
  });
});

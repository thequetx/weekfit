import { describe, expect, it } from 'vitest';
import {
  clearDue,
  clearEstimate,
  clearPriority,
  estimateRaw,
  withDue,
  withEstimate,
  withPriority,
} from '../src/data/taskfields';
import { parseTaskMeta } from '../src/lib/taskmeta';

const meta = (line: string) => parseTaskMeta(line);
const due = (line: string) => meta(line).dates.due?.date ?? null;
const est = (line: string) => meta(line).fields['wd:est']?.minutes ?? null;
const pri = (line: string) => meta(line).priority?.level ?? null;

describe('a field written is a field the parser reads back', () => {
  it.each([
    ['- [ ] Book dentist', '2026-09-04'],
    ['- [ ] Book dentist #admin', '2026-09-04'],
    ['- [ ] Book dentist ~90m', '2026-12-31'],
    ['- [ ] Book dentist 🔺', '2026-01-01'],
  ])('round-trips a due date on %s', (line, date) => {
    expect(due(withDue(line, date))).toBe(date);
  });

  it.each([15, 30, 45, 60, 90, 120, 150, 480])('round-trips a %i-minute estimate', (minutes) => {
    expect(est(withEstimate('- [ ] Draft the plan', minutes))).toBe(minutes);
  });

  it.each(['highest', 'high', 'medium', 'low', 'lowest'] as const)(
    'round-trips %s priority',
    (level) => {
      expect(pri(withPriority('- [ ] Draft the plan', level))).toBe(level);
    },
  );

  // The bug this guards: `fmtEstimate(90)` is `1h 30m`, and the `~` parser
  // stops at the space — the line would come back `~1h` with a stray `30m`
  // left sitting in the title.
  it('never writes a duration the reader will misparse', () => {
    const line = withEstimate('- [ ] Draft the plan', 90);
    expect(est(line)).toBe(90);
    expect(meta(line).title).toBe('Draft the plan');
    expect(estimateRaw(90, 'tilde')).toBe('~90m');
    expect(estimateRaw(120, 'tilde')).toBe('~2h');
  });
});

describe('the line keeps the dialect it was written in', () => {
  it('writes emoji onto an emoji line', () => {
    expect(withDue('- [ ] Task 🔺', '2026-09-04')).toContain('📅 2026-09-04');
    expect(withPriority('- [ ] Task 📅 2026-09-04', 'high')).toContain('⏫');
  });

  it('writes inline onto an inline line', () => {
    expect(withDue('- [ ] Task [priority:: high]', '2026-09-04')).toContain('[due:: 2026-09-04]');
    expect(withPriority('- [ ] Task [due:: 2026-09-04]', 'high')).toContain('[priority:: high]');
  });

  it('defaults a bare line to emoji, the same call withCompletion makes', () => {
    expect(withDue('- [ ] Task', '2026-09-04')).toContain('📅');
  });

  // The duration has a third spelling that is this plugin's own, and the one
  // the docs advertise.
  it('defaults a bare line to the tilde form, but keeps an inline estimate inline', () => {
    expect(withEstimate('- [ ] Task', 45)).toContain('~45m');
    expect(withEstimate('- [ ] Task [est:: 30m]', 45)).toContain('[est:: 45m]');
    expect(withEstimate('- [ ] Task [est:: 30m]', 45)).not.toContain('~');
  });
});

describe('setting a field twice does not stack two of them', () => {
  it.each([
    ['- [ ] Task 📅 2026-09-01', '2026-09-04'],
    ['- [ ] Task 📆 2026-09-01', '2026-09-04'],
    ['- [ ] Task 🗓 2026-09-01', '2026-09-04'],
    ['- [ ] Task [due:: 2026-09-01]', '2026-09-04'],
  ])('replaces the due date on %s', (line, date) => {
    const out = withDue(line, date);
    expect(due(out)).toBe(date);
    expect(out).not.toContain('2026-09-01');
  });

  it('replaces an estimate in either spelling', () => {
    expect(est(withEstimate('- [ ] Task ~30m', 90))).toBe(90);
    expect(withEstimate('- [ ] Task ~30m', 90)).not.toContain('30m');
    expect(est(withEstimate('- [ ] Task [est:: 30m]', 90))).toBe(90);
  });

  it('replaces a priority rather than adding a second glyph', () => {
    const out = withPriority('- [ ] Task 🔽', 'highest');
    expect(pri(out)).toBe('highest');
    expect(out).not.toContain('🔽');
  });
});

describe('clearing', () => {
  it('removes a due date in either flavour', () => {
    expect(due(clearDue('- [ ] Task 📅 2026-09-04'))).toBeNull();
    expect(due(clearDue('- [ ] Task [due:: 2026-09-04]'))).toBeNull();
    expect(due(withDue('- [ ] Task 📅 2026-09-04', null))).toBeNull();
  });

  it('removes an estimate in either spelling', () => {
    expect(est(clearEstimate('- [ ] Task ~90m'))).toBeNull();
    expect(est(clearEstimate('- [ ] Task [est:: 90m]'))).toBeNull();
  });

  // `none` is the middle of the scale, not a marker — the standard has no
  // glyph for it, so writing one would be inventing syntax.
  it('treats `none` as a clear rather than a value', () => {
    const out = withPriority('- [ ] Task 🔺', 'none');
    expect(pri(out)).toBeNull();
    expect(out).not.toContain('priority::');
  });

  it('leaves the rest of the line alone', () => {
    expect(clearDue('- [ ] Task #admin 📅 2026-09-04 ~90m')).toBe('- [ ] Task #admin ~90m');
  });
});

/**
 * `clearCompletion` in the vendored lib collapses any run of two or more
 * spaces, which includes a line's leading indentation — and an indented line
 * is exactly what splitting writes for each sitting of a task. Every function
 * here splits the prefix off first so a caller cannot reintroduce that bug.
 */
describe('indentation survives', () => {
  it.each([
    '    - [ ] Sitting 1/3 📅 2026-09-01',
    '\t- [ ] Sitting 1/3 📅 2026-09-01',
    '  - [ ] Sitting 1/3',
  ])('keeps the leading whitespace of %j', (line) => {
    const lead = (s: string) => /^\s*/.exec(s)![0];
    expect(lead(withDue(line, '2026-09-04'))).toBe(lead(line));
    expect(lead(withEstimate(line, 45))).toBe(lead(line));
    expect(lead(withPriority(line, 'high'))).toBe(lead(line));
    expect(lead(clearDue(line))).toBe(lead(line));
  });
});

describe('fields the plugin has never touched stay untouched', () => {
  // Recurrence is the Tasks plugin's to own — the weekly roll deliberately
  // leaves `🔁` lines in place rather than moving them.
  it('leaves a recurrence rule intact, and does not land inside it', () => {
    const out = withDue('- [ ] Water plants 🔁 every week', '2026-09-04');
    expect(out).toContain('🔁 every week');
    expect(meta(out).recurrence?.rule).toBe('every week');
    expect(due(out)).toBe('2026-09-04');
  });

  it('leaves an on-completion instruction intact', () => {
    const out = withEstimate('- [ ] Task 🏁 delete', 45);
    expect(meta(out).onCompletion?.value).toBe('delete');
    expect(est(out)).toBe(45);
  });

  it('leaves a completion stamp intact', () => {
    const out = withDue('- [x] Task ✅ 2026-08-25', '2026-09-04');
    expect(meta(out).dates.completion?.date).toBe('2026-08-25');
    expect(due(out)).toBe('2026-09-04');
  });

  it('leaves a Day Planner range where it is', () => {
    const out = withDue('- [ ] 09:00 - 10:30 Team sync', '2026-09-04');
    expect(out.startsWith('- [ ] 09:00 - 10:30 Team sync')).toBe(true);
  });

  it('leaves tags where the author put them', () => {
    expect(withPriority('- [ ] Task #admin #urgent', 'high')).toBe('- [ ] Task #admin #urgent ⏫');
  });
});

describe('refusing rather than writing something the reader discards', () => {
  // Outside taskmeta's own sanity rails the value is ignored on read, so
  // writing it produces a line showing one duration and planning another.
  it.each([0, 1, 4, 13 * 60, 100000])('leaves the line untouched for %i minutes', (minutes) => {
    const line = '- [ ] Task';
    expect(withEstimate(line, minutes)).toBe(line);
  });

  it('accepts the boundaries themselves', () => {
    expect(est(withEstimate('- [ ] Task', 5))).toBe(5);
    expect(est(withEstimate('- [ ] Task', 12 * 60))).toBe(12 * 60);
  });

  it('does not throw on a line that is not a task at all', () => {
    expect(() => withDue('just some prose', '2026-09-04')).not.toThrow();
    expect(() => withEstimate('', 45)).not.toThrow();
  });
});

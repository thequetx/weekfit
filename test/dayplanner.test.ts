import { describe, expect, it } from 'vitest';
import { applyPlacement, hasPlacement } from '../src/data/dayplanner';

const RANGE = '09:00 - 10:30';
const RANGE_2 = '14:00 - 15:00';

describe('applyPlacement', () => {
  it('is idempotent: applying the same placement twice equals applying it once', () => {
    const line = '- [ ] Book dentist';
    const once = applyPlacement(line, { range: RANGE, scheduledDate: '2026-09-04' });
    const twice = applyPlacement(once, { range: RANGE, scheduledDate: '2026-09-04' });
    expect(twice).toBe(once);
  });

  it('is idempotent with no scheduled date too', () => {
    const line = '- [ ] Book dentist';
    const once = applyPlacement(line, { range: RANGE, scheduledDate: null });
    const twice = applyPlacement(once, { range: RANGE, scheduledDate: null });
    expect(twice).toBe(once);
  });

  it('replaces an existing range rather than stacking a second one', () => {
    const line = '- [ ] Book dentist';
    const first = applyPlacement(line, { range: RANGE, scheduledDate: null });
    expect(first).toBe('- [ ] 09:00 - 10:30 Book dentist');

    const second = applyPlacement(first, { range: RANGE_2, scheduledDate: null });
    expect(second).toBe('- [ ] 14:00 - 15:00 Book dentist');
    expect(second).not.toContain(RANGE);
  });

  it('replaces an existing scheduled date rather than stacking a second one', () => {
    const line = '- [ ] Book dentist';
    const first = applyPlacement(line, { range: RANGE, scheduledDate: '2026-09-04' });
    const second = applyPlacement(first, { range: RANGE, scheduledDate: '2026-09-05' });
    expect(second).toBe('- [ ] 09:00 - 10:30 Book dentist ⏳ 2026-09-05');
    // Only one stamp, not two.
    expect(second.match(/⏳/g)?.length).toBe(1);
  });

  it('leaves a line with no metadata at all with exactly the range and an emoji-flavour date', () => {
    const line = '- [ ] Book dentist';
    const out = applyPlacement(line, { range: RANGE, scheduledDate: '2026-09-04' });
    expect(out).toBe('- [ ] 09:00 - 10:30 Book dentist ⏳ 2026-09-04');
  });

  it('keeps ~90m, a due date, priority and a tag unchanged and in order when only placing (no scheduled date)', () => {
    const line = '- [ ] Edit video ~90m 📅 2026-09-04 🔼 #content';
    const out = applyPlacement(line, { range: RANGE, scheduledDate: null });
    expect(out).toBe('- [ ] 09:00 - 10:30 Edit video ~90m 📅 2026-09-04 🔼 #content');
  });

  it('writes the scheduled date in inline flavour when the line already uses [due:: …]', () => {
    const line = '- [ ] Edit video [due:: 2026-09-04]';
    const out = applyPlacement(line, { range: RANGE, scheduledDate: '2026-09-05' });
    expect(out).toContain('[scheduled:: 2026-09-05]');
    expect(out).not.toContain('⏳');
  });

  it('writes the scheduled date in emoji flavour when the line already uses 📅 (emoji)', () => {
    const line = '- [ ] Edit video 📅 2026-09-04';
    const out = applyPlacement(line, { range: RANGE, scheduledDate: '2026-09-05' });
    expect(out).toContain('⏳ 2026-09-05');
    expect(out).not.toContain('[scheduled::');
  });

  it('preserves indentation and a `*` bullet byte-identically', () => {
    const line = '  * [ ] nested subtask';
    const out = applyPlacement(line, { range: RANGE, scheduledDate: null });
    expect(out).toBe('  * [ ] 09:00 - 10:30 nested subtask');
  });

  it('preserves tab indentation byte-identically', () => {
    const line = '\t- [ ] tab-indented subtask';
    const out = applyPlacement(line, { range: RANGE, scheduledDate: null });
    expect(out).toBe('\t- [ ] 09:00 - 10:30 tab-indented subtask');
  });

  it('keeps a completed `- [x]` line marked done', () => {
    const line = '- [x] Already done';
    const out = applyPlacement(line, { range: RANGE, scheduledDate: null });
    expect(out).toBe('- [x] 09:00 - 10:30 Already done');
  });

  it('leaves a trailing recurrence untouched', () => {
    const line = '- [ ] Water the plants 🔁 every week';
    const out = applyPlacement(line, { range: RANGE, scheduledDate: null });
    expect(out).toBe('- [ ] 09:00 - 10:30 Water the plants 🔁 every week');
  });

  it('leaves a trailing recurrence untouched even when a scheduled date is also written', () => {
    const line = '- [ ] Water the plants 🔁 every week';
    const out = applyPlacement(line, { range: RANGE, scheduledDate: '2026-09-04' });
    expect(out).toBe('- [ ] 09:00 - 10:30 Water the plants 🔁 every week ⏳ 2026-09-04');
  });

  it('survives an emoji and CJK in the title', () => {
    const line = '- [ ] 買い物に行く 🎉 celebrate after';
    const out = applyPlacement(line, { range: RANGE, scheduledDate: null });
    expect(out).toBe('- [ ] 09:00 - 10:30 買い物に行く 🎉 celebrate after');
  });

  // --- malformed input -------------------------------------------------

  it('does not throw on an empty string', () => {
    expect(() => applyPlacement('', { range: RANGE, scheduledDate: null })).not.toThrow();
  });

  it('does not throw on a line that is not a task', () => {
    const line = 'Just some prose, no checkbox at all';
    expect(() => applyPlacement(line, { range: RANGE, scheduledDate: null })).not.toThrow();
    const out = applyPlacement(line, { range: RANGE, scheduledDate: null });
    expect(out).toBe('09:00 - 10:30 Just some prose, no checkbox at all');
  });

  it('does not throw on a range-only line with nothing else on it', () => {
    const line = '10:00 - 11:00';
    expect(() => applyPlacement(line, { range: RANGE, scheduledDate: null })).not.toThrow();
  });

  it('replaces a bare leading range even with no checkbox and no title', () => {
    // DAY_PLANNER_RE requires trailing whitespace after the second time, so a
    // range followed by more text is the realistic shape to assert on.
    const line = '10:00 - 11:00 old title';
    const out = applyPlacement(line, { range: RANGE, scheduledDate: null });
    expect(out).toBe('09:00 - 10:30 old title');
  });
});

describe('applyPlacement — range: null unschedules', () => {
  it('strips an existing range and leaves nothing in its place', () => {
    const line = '- [ ] 09:00 - 10:30 Book dentist';
    const out = applyPlacement(line, { range: null, scheduledDate: null });
    expect(out).toBe('- [ ] Book dentist');
  });

  it('leaves a ⏳ this file wrote alone when unscheduling — it cannot tell whose it is, so it never touches it', () => {
    const line = '- [ ] 09:00 - 10:30 Book dentist ⏳ 2026-09-04';
    const out = applyPlacement(line, { range: null, scheduledDate: null });
    expect(out).toBe('- [ ] Book dentist ⏳ 2026-09-04');
  });

  it('leaves a ⏳ the user typed themselves alone too — same code path, same result, because there is no way to tell them apart', () => {
    // Nothing distinguishes a user-authored ⏳ from one this app wrote; both
    // are just "a scheduled-date field on the line" by the time this function
    // sees it. Asserting this is the honest way to document that limitation:
    // the behaviour for "our ⏳" and "their ⏳" is identical, not because the
    // code specially preserves the user's, but because it can't do anything
    // else.
    const userWritten = '- [ ] 09:00 - 10:30 Book dentist ⏳ 2026-09-04';
    const ours = '- [ ] 09:00 - 10:30 Book dentist ⏳ 2026-09-04';
    expect(applyPlacement(userWritten, { range: null, scheduledDate: null })).toBe(
      applyPlacement(ours, { range: null, scheduledDate: null }),
    );
  });

  it('leaves ~90m, a due date, priority, a tag and a recurrence untouched when unscheduling', () => {
    const line = '- [ ] 09:00 - 10:30 Edit video ~90m 📅 2026-09-04 🔼 #content 🔁 every week';
    const out = applyPlacement(line, { range: null, scheduledDate: null });
    expect(out).toBe('- [ ] Edit video ~90m 📅 2026-09-04 🔼 #content 🔁 every week');
  });

  it('is a no-op on a line with no range to begin with', () => {
    const line = '- [ ] Book dentist';
    const out = applyPlacement(line, { range: null, scheduledDate: null });
    expect(out).toBe('- [ ] Book dentist');
  });

  it('preserves indentation and bullet style while unscheduling', () => {
    const line = '  * [ ] 09:00 - 10:30 nested subtask';
    const out = applyPlacement(line, { range: null, scheduledDate: null });
    expect(out).toBe('  * [ ] nested subtask');
  });

  it('does not throw on an empty string', () => {
    expect(() => applyPlacement('', { range: null, scheduledDate: null })).not.toThrow();
  });
});

describe('hasPlacement — the real-line shape, not a bare body', () => {
  // The bug this exists to prevent: `DAY_PLANNER_RE` is `^`-anchored and
  // documented as matching a task line's *body*, but `VaultTask.text` is the
  // whole raw line including `- [ ] `. Testing the regex directly against a
  // VaultTask therefore always says "no range", so already-scheduled work was
  // listed as unscheduled and "Fit this week" would propose moving it.
  //
  // Phase 1 had a green test for this exclusion. It passed a bare body, so it
  // asserted nothing about real data. These cases use the shape `parse.ts`
  // actually produces.
  it('sees a range on a real checkbox line', () => {
    expect(hasPlacement('- [ ] 09:00 - 10:30 Fix badge alpha')).toBe(true);
  });

  it('still sees one on a bare body', () => {
    expect(hasPlacement('09:00 - 10:30 Fix badge alpha')).toBe(true);
  });

  it('sees one through indentation, a * bullet and a ticked box', () => {
    expect(hasPlacement('    * [x] 14:00 - 15:00 Retro')).toBe(true);
  });

  it('says no for a task with no range', () => {
    expect(hasPlacement('- [ ] Book dentist ~90m 📅 2026-09-04')).toBe(false);
  });

  it('is not fooled by a time later in the line', () => {
    expect(hasPlacement('- [ ] Email them about the 09:00 - 10:30 slot')).toBe(false);
  });

  it('survives empty and malformed input', () => {
    expect(hasPlacement('')).toBe(false);
    expect(hasPlacement('- [ ] ')).toBe(false);
  });
});

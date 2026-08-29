import { describe, expect, it } from 'vitest';
import { weeklyNoteTemplate } from '../src/data/template';
import { parseSections, parseTasksIn, sweepTagged } from '../src/data/parse';
import { startOfISOWeek } from '../src/lib/week';

// A Wednesday, to prove the template normalises to the Monday rather than
// keying off whatever day the user happened to press the button.
const WED = new Date(2026, 8, 2);

describe('weeklyNoteTemplate', () => {
  it('carries the three sections the parser reads, in order', () => {
    const text = weeklyNoteTemplate(WED);
    const sections = parseSections(text);
    expect(Object.keys(sections)).toEqual(['intentions', 'tasks', 'review']);
  });

  it('normalises any day of the week to that week', () => {
    const text = weeklyNoteTemplate(WED);
    expect(text).toContain('week: 2026-W36');
    expect(text).toContain('range: 2026-08-31/2026-09-06');
  });

  it('starts in the planning state', () => {
    expect(weeklyNoteTemplate(WED)).toContain('status: planning');
  });

  // The one that matters. The guidance is written as an HTML comment
  // specifically so its example `- [ ]` lines are not real tasks. If they
  // parsed, a brand-new vault's very first "Fit this week" would try to
  // schedule the instructions.
  it('the example lines are not parsed as tasks', () => {
    const text = weeklyNoteTemplate(WED);
    expect(text).toContain('Book dentist'); // the guidance really is present
    const sections = parseSections(text);
    const tasks = parseTasksIn(text, 'Weekly/2026-W36.md', sections['tasks'].start, sections['tasks'].end);
    expect(tasks).toEqual([]);
  });

  it('and its #thisweek mention is not swept either', () => {
    const text = weeklyNoteTemplate(WED);
    expect(sweepTagged(text, 'Weekly/2026-W36.md', '#thisweek')).toEqual([]);
  });

  it('can be produced without the guidance', () => {
    const text = weeklyNoteTemplate(WED, { withExamples: false });
    expect(text).not.toContain('Book dentist');
    expect(Object.keys(parseSections(text))).toEqual(['intentions', 'tasks', 'review']);
  });

  it('ends with a newline and has no trailing whitespace on any line', () => {
    const text = weeklyNoteTemplate(WED);
    expect(text.endsWith('\n')).toBe(true);
    for (const line of text.split('\n')) expect(line).toBe(line.replace(/\s+$/, ''));
  });

  it('agrees with startOfISOWeek about which week it is', () => {
    const text = weeklyNoteTemplate(WED);
    const monday = startOfISOWeek(WED);
    expect(text).toContain(`range: 2026-08-${String(monday.getDate()).padStart(2, '0')}/`);
  });
});

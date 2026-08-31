import { describe, expect, it } from 'vitest';
import { parseSections, parseTasksIn, scheduledEvents, sweepTagged } from '../src/data/parse';
import { startOfISOWeek } from '../src/lib/week';

const WEEKLY_NOTE = `---
week: 2026-W36
range: 2026-08-31/2026-09-06
status: planning
---

## Intentions

- Ship the Weekfit Phase 0 scaffold

## Tasks

- [ ] Book dentist
- [ ] Prep talk slides ~90m
- [x] Edit VOD ~90m 📅 2026-09-04 🔼
- [ ] Write newsletter [est:: 45m] [due:: 2026-09-03] [priority:: high]
- [ ] 09:00 - 10:30 Fix badge alpha
- [ ] Plan next stream #content

## Review

`;

describe('parseSections', () => {
  it('finds Intentions, Tasks and Review with correct line ranges', () => {
    const sections = parseSections(WEEKLY_NOTE);
    const lines = WEEKLY_NOTE.split('\n');
    expect(sections['intentions']).toBeDefined();
    expect(sections['tasks']).toBeDefined();
    expect(sections['review']).toBeDefined();

    // The Tasks heading's body should span exactly the checkbox lines.
    const { start, end } = sections['tasks'];
    for (let i = start; i <= end; i++) {
      if (lines[i].trim() === '') continue;
      expect(lines[i]).toMatch(/^- \[[ x]\]/);
    }
  });

  it('a note missing a section simply has no key for it', () => {
    const sections = parseSections('## Tasks\n\n- [ ] only tasks here\n');
    expect(sections['tasks']).toBeDefined();
    expect(sections['intentions']).toBeUndefined();
    expect(sections['review']).toBeUndefined();
  });

  it('tolerates a heading one level too deep (###)', () => {
    const sections = parseSections('### Tasks\n\n- [ ] deep heading task\n');
    expect(sections['tasks']).toBeDefined();
  });

  it('ignores a heading-looking line inside a fenced code block', () => {
    const content = ['## Tasks', '', '```', '## Not a real heading', '```', '', '## Review'].join(
      '\n',
    );
    const sections = parseSections(content);
    expect(sections['not a real heading']).toBeUndefined();
    expect(sections['review']).toBeDefined();
  });
});

describe('parseTasksIn', () => {
  it('parses a plain checkbox line with the correct 0-indexed line number', () => {
    const content = 'para one\n- [ ] Book dentist\npara two';
    const tasks = parseTasksIn(content, 'Weekly/2026-W36.md', 0, 2);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual({
      text: '- [ ] Book dentist',
      done: false,
      file: 'Weekly/2026-W36.md',
      line: 1,
    });
  });

  it('marks a done task from -[x]', () => {
    const content = '- [x] done thing';
    const tasks = parseTasksIn(content, 'f.md', 0, 0);
    expect(tasks[0].done).toBe(true);
  });

  it('marks a done task from -[X] (uppercase)', () => {
    const content = '- [X] also done';
    const tasks = parseTasksIn(content, 'f.md', 0, 0);
    expect(tasks[0].done).toBe(true);
  });

  it('parses indented/nested checkbox lines, keeping the raw text', () => {
    const content = '- [ ] parent task\n  - [ ] nested subtask\n\t- [x] tab-indented subtask';
    const tasks = parseTasksIn(content, 'f.md', 0, 2);
    expect(tasks).toHaveLength(3);
    expect(tasks[1]).toEqual({ text: '  - [ ] nested subtask', done: false, file: 'f.md', line: 1 });
    expect(tasks[2]).toEqual({
      text: '\t- [x] tab-indented subtask',
      done: true,
      file: 'f.md',
      line: 2,
    });
  });

  it('respects the given line range, excluding lines outside it', () => {
    const content = '- [ ] before\n- [ ] inside\n- [ ] after';
    const tasks = parseTasksIn(content, 'f.md', 1, 1);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].text).toBe('- [ ] inside');
  });

  it('extracts the real Tasks section from the fixture-shaped weekly note', () => {
    const sections = parseSections(WEEKLY_NOTE);
    const { start, end } = sections['tasks'];
    const tasks = parseTasksIn(WEEKLY_NOTE, 'Weekly/2026-W36.md', start, end);
    expect(tasks.map((t) => t.done)).toEqual([false, false, true, false, false, false]);
  });
});

describe('sweepTagged', () => {
  it('sweeps a checkbox line carrying #thisweek', () => {
    const content = '- [ ] Plan next stream #thisweek';
    const out = sweepTagged(content, 'Notes/Loose ideas.md', 'thisweek');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      text: '- [ ] Plan next stream #thisweek',
      done: false,
      file: 'Notes/Loose ideas.md',
      line: 0,
    });
  });

  it('does NOT sweep #thisweekend', () => {
    const content = '- [ ] Plan the trip #thisweekend';
    expect(sweepTagged(content, 'f.md', 'thisweek')).toHaveLength(0);
  });

  it('does NOT sweep a #thisweek inside a fenced code block', () => {
    const content = ['```', '- [ ] example line #thisweek', '```'].join('\n');
    expect(sweepTagged(content, 'f.md', 'thisweek')).toHaveLength(0);
  });

  it('does NOT sweep a #thisweek that only appears inside a [[wikilink]]', () => {
    const content = '- [ ] see [[Some Note#thisweek]] for context';
    expect(sweepTagged(content, 'f.md', 'thisweek')).toHaveLength(0);
  });

  it('does not require the checkbox to be unchecked', () => {
    const content = '- [x] already done #thisweek';
    const out = sweepTagged(content, 'f.md', 'thisweek');
    expect(out).toHaveLength(1);
    expect(out[0].done).toBe(true);
  });

  it('ignores non-checkbox lines even if tagged', () => {
    const content = 'Just a note #thisweek, not a task';
    expect(sweepTagged(content, 'f.md', 'thisweek')).toHaveLength(0);
  });
});

describe('scheduledEvents', () => {
  const weekStart = startOfISOWeek(new Date(2026, 7, 31)); // Mon 2026-08-31

  it('places a Day Planner line in a daily note on the note’s own day', () => {
    const content = '- [ ] 09:00 - 10:30 Fix badge alpha';
    const noteDate = new Date(2026, 8, 2); // Wed 2026-09-02, inside the week
    const { events, unresolved } = scheduledEvents(content, 'Daily/2026-09-02.md', noteDate, weekStart);
    expect(unresolved).toBe(0);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.title).toBe('Fix badge alpha');
    expect(ev.allDay).toBe(false);
    expect(ev.uid).toBe('Daily/2026-09-02.md:0');
    expect(ev.source).toBe('Daily/2026-09-02.md#L0');
    expect(ev.start).toEqual(new Date(2026, 8, 2, 9, 0));
    expect(ev.end).toEqual(new Date(2026, 8, 2, 10, 30));
  });

  it('places a Day Planner line with ⏳ YYYY-MM-DD on that date (no note date)', () => {
    const content = '- [ ] 09:00 - 10:30 Fix badge alpha ⏳ 2026-09-04';
    const { events, unresolved } = scheduledEvents(content, 'Weekly/2026-W36.md', null, weekStart);
    expect(unresolved).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0].start).toEqual(new Date(2026, 8, 4, 9, 0));
    expect(events[0].end).toEqual(new Date(2026, 8, 4, 10, 30));
    expect(events[0].title).toBe('Fix badge alpha');
  });

  it('places a Day Planner line with [scheduled:: YYYY-MM-DD] identically', () => {
    const content = '- [ ] 09:00 - 10:30 Fix badge alpha [scheduled:: 2026-09-04]';
    const { events, unresolved } = scheduledEvents(content, 'Weekly/2026-W36.md', null, weekStart);
    expect(unresolved).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0].start).toEqual(new Date(2026, 8, 4, 9, 0));
    expect(events[0].end).toEqual(new Date(2026, 8, 4, 10, 30));
    expect(events[0].title).toBe('Fix badge alpha');
  });

  it('counts a Day Planner line with neither a note date nor a scheduled date as unresolved', () => {
    const content = '- [ ] 09:00 - 10:30 Fix badge alpha';
    const { events, unresolved } = scheduledEvents(content, 'Weekly/2026-W36.md', null, weekStart);
    expect(events).toHaveLength(0);
    expect(unresolved).toBe(1);
  });

  it('does not count an undated Day Planner line carrying an [ics-uid::] marker as unresolved', () => {
    // icsCaptureLine (icsCapture.ts) writes exactly this shape on purpose —
    // a calendar event dropped onto the rail is meant to land unscheduled —
    // so it must not trip the "N timed lines have no date" banner.
    const content = [
      '- [ ] 09:00 - 09:30 Plain undated timed line', // unresolved -> counted
      '- [ ] 10:00 - 10:30 Standup [ics-uid:: abc-123]', // deliberately undated -> not counted
    ].join('\n');
    const { events, unresolved } = scheduledEvents(content, 'Weekly/2026-W36.md', null, weekStart);
    expect(events).toHaveLength(0);
    expect(unresolved).toBe(1);
  });

  it('drops a resolved event that falls outside the rendered week', () => {
    const content = '- [ ] 09:00 - 10:30 Fix badge alpha ⏳ 2026-09-14';
    const { events, unresolved } = scheduledEvents(content, 'Weekly/2026-W36.md', null, weekStart);
    expect(events).toHaveLength(0);
    expect(unresolved).toBe(0); // it had a date — it's just not this week
  });

  it('ignores a malformed range (24:00) without throwing', () => {
    const content = '- [ ] 24:00 - 25:00 midnight overflow';
    const noteDate = new Date(2026, 8, 2);
    expect(() => scheduledEvents(content, 'f.md', noteDate, weekStart)).not.toThrow();
    const { events, unresolved } = scheduledEvents(content, 'f.md', noteDate, weekStart);
    expect(events).toHaveLength(0);
    expect(unresolved).toBe(0);
  });

  it('ignores a malformed range (single-digit minute, 9:5) without throwing', () => {
    const content = '- [ ] 9:5 - 10:30 bad minute';
    const noteDate = new Date(2026, 8, 2);
    expect(() => scheduledEvents(content, 'f.md', noteDate, weekStart)).not.toThrow();
    const { events, unresolved } = scheduledEvents(content, 'f.md', noteDate, weekStart);
    expect(events).toHaveLength(0);
    expect(unresolved).toBe(0);
  });

  it('ignores a range where the end is not after the start', () => {
    const content = '- [ ] 10:30 - 09:00 backwards range';
    const noteDate = new Date(2026, 8, 2);
    const { events, unresolved } = scheduledEvents(content, 'f.md', noteDate, weekStart);
    expect(events).toHaveLength(0);
    expect(unresolved).toBe(0);
  });

  it('ignores checkbox lines with no time range at all', () => {
    const content = '- [ ] Book dentist';
    const { events, unresolved } = scheduledEvents(content, 'f.md', null, weekStart);
    expect(events).toHaveLength(0);
    expect(unresolved).toBe(0);
  });

  // --- scheduledLines: index-aligned with events, skips never shift it ------
  //
  // `events[i]` must always have come from `lines[i]` — the writer refuses to
  // touch a line whose text doesn't match what was read, so if this drifts by
  // even one, a re-time or unschedule action would silently edit the wrong
  // line in the vault. That's the worst failure this code can have.
  describe('lines — index-aligned with events', () => {
    it('is index-aligned for a single resolved event', () => {
      const content = '- [ ] 09:00 - 10:30 Fix badge alpha ⏳ 2026-09-04';
      const { events, lines } = scheduledEvents(content, 'Weekly/2026-W36.md', null, weekStart);
      expect(events).toHaveLength(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({
        text: content,
        done: false,
        file: 'Weekly/2026-W36.md',
        line: 0,
      });
    });

    it('carries the done flag through to the aligned line', () => {
      const content = '- [x] 09:00 - 10:30 Fix badge alpha ⏳ 2026-09-04';
      const { lines } = scheduledEvents(content, 'f.md', null, weekStart);
      expect(lines[0].done).toBe(true);
    });

    it('stays aligned when an undated line (unresolved) sits between two resolved ones', () => {
      const content = [
        '- [ ] 08:00 - 08:30 First ⏳ 2026-08-31', // resolved -> events[0]
        '- [ ] 09:00 - 09:30 No date at all', // unresolved -> dropped, no shift
        '- [ ] 10:00 - 10:30 Second ⏳ 2026-09-01', // resolved -> events[1]
      ].join('\n');
      const { events, lines, unresolved } = scheduledEvents(content, 'f.md', null, weekStart);

      expect(unresolved).toBe(1);
      expect(events).toHaveLength(2);
      expect(lines).toHaveLength(2);

      // events[i] must have come from lines[i] — checked by line number and
      // by title, not just by count, so an off-by-one silently swapping two
      // *different* real lines would still be caught.
      expect(lines[0].line).toBe(0);
      expect(lines[1].line).toBe(2);
      expect(events[0].title).toBe('First');
      expect(events[1].title).toBe('Second');
      expect(lines[0].text).toContain('First');
      expect(lines[1].text).toContain('Second');
    });

    it('stays aligned across a fenced code block that contains a Day-Planner-shaped line', () => {
      const content = [
        '- [ ] 08:00 - 08:30 Before the fence ⏳ 2026-08-31',
        '```',
        '- [ ] 09:00 - 09:30 Inside a fence ⏳ 2026-09-01',
        '```',
        '- [ ] 10:00 - 10:30 After the fence ⏳ 2026-09-02',
      ].join('\n');
      const { events, lines } = scheduledEvents(content, 'f.md', null, weekStart);

      expect(events).toHaveLength(2);
      expect(lines).toHaveLength(2);
      expect(events.map((e) => e.title)).toEqual(['Before the fence', 'After the fence']);
      expect(lines.map((l) => l.line)).toEqual([0, 4]);
    });

    it('stays aligned when a malformed range sits between two resolved ones', () => {
      const content = [
        '- [ ] 08:00 - 08:30 Good one ⏳ 2026-08-31',
        '- [ ] 24:00 - 25:00 Malformed range ⏳ 2026-09-01',
        '- [ ] 10:00 - 10:30 Another good one ⏳ 2026-09-02',
      ].join('\n');
      const { events, lines } = scheduledEvents(content, 'f.md', null, weekStart);

      expect(events).toHaveLength(2);
      expect(lines).toHaveLength(2);
      expect(events.map((e) => e.title)).toEqual(['Good one', 'Another good one']);
      expect(lines.map((l) => l.line)).toEqual([0, 2]);
    });

    it('stays aligned when a resolved event falls outside the rendered week', () => {
      const content = [
        '- [ ] 08:00 - 08:30 In this week ⏳ 2026-08-31',
        '- [ ] 09:00 - 09:30 Two weeks out ⏳ 2026-09-14',
        '- [ ] 10:00 - 10:30 Also in this week ⏳ 2026-09-01',
      ].join('\n');
      const { events, lines } = scheduledEvents(content, 'f.md', null, weekStart);

      expect(events).toHaveLength(2);
      expect(lines).toHaveLength(2);
      expect(events.map((e) => e.title)).toEqual(['In this week', 'Also in this week']);
      expect(lines.map((l) => l.line)).toEqual([0, 2]);
    });

    it('is empty when nothing resolves', () => {
      const { events, lines } = scheduledEvents('- [ ] Book dentist', 'f.md', null, weekStart);
      expect(events).toEqual([]);
      expect(lines).toEqual([]);
    });
  });
});

describe('HTML comments are not content', () => {
  // Commenting a task out is how people defer one without deleting it, and it
  // renders as nothing — so it must parse as nothing. Found by the weekly-note
  // template's own test: the template puts its worked examples in a comment,
  // and without this a brand-new vault's first "Fit this week" would try to
  // schedule the instructions.
  const note = [
    '## Tasks',
    '',
    '- [ ] Real task',
    '<!--',
    '- [ ] Commented out for now',
    '- [ ] 09:00 - 10:00 Also commented ⏳ 2026-09-01',
    '-->',
    '- [ ] Another real task',
    '- [ ] Parked <!-- one-liner --> but still real',
    '',
  ].join('\n');

  it('does not parse a task inside a comment block', () => {
    const sec = parseSections(note);
    const tasks = parseTasksIn(note, 'n.md', sec['tasks'].start, sec['tasks'].end);
    expect(tasks.map((t) => t.text)).toEqual(['- [ ] Real task', '- [ ] Another real task']);
  });

  it('a single-line comment masks only its own line', () => {
    const lines = ['- [ ] a', '<!-- - [ ] b -->', '- [ ] c'].join('\n');
    const tasks = parseTasksIn(lines, 'n.md', 0, 2);
    expect(tasks.map((t) => t.text)).toEqual(['- [ ] a', '- [ ] c']);
  });

  it('does not sweep a #thisweek inside a comment', () => {
    const lines = ['<!--', '- [ ] hidden #thisweek', '-->', '- [ ] shown #thisweek'].join('\n');
    expect(sweepTagged(lines, 'n.md', 'thisweek').map((t) => t.text)).toEqual([
      '- [ ] shown #thisweek',
    ]);
  });

  it('does not turn a commented Day Planner line into an event', () => {
    const lines = ['<!--', '- [ ] 09:00 - 10:00 Ghost ⏳ 2026-09-01', '-->'].join('\n');
    const weekStart = startOfISOWeek(new Date(2026, 7, 31));
    expect(scheduledEvents(lines, 'n.md', null, weekStart).events).toEqual([]);
  });

  it('an unterminated comment masks to end of file', () => {
    const lines = ['- [ ] before', '<!--', '- [ ] after'].join('\n');
    const tasks = parseTasksIn(lines, 'n.md', 0, 2);
    expect(tasks.map((t) => t.text)).toEqual(['- [ ] before']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DATE_FIELDS,
  PRIORITIES,
  PRIORITY_RANK,
  clearCompletion,
  compareMeta,
  completionRaw,
  fmtDue,
  isOverdue,
  isRecurring,
  parseDurationValue,
  parseTaskMeta,
  priorityRank,
  taskTitle,
  withCompletion,
} from '../src/lib/taskmeta';
import type { PriorityName, TaskMeta } from '../src/lib/taskmeta';

// ---------------------------------------------------------------------------
// Tier 1 — read. Both flavours of one standard, never two ecosystems.
// ---------------------------------------------------------------------------

describe('the six date fields, in both spellings', () => {
  const CASES: Array<[string, string, string]> = [
    ['due', '📅 2026-09-04', '[due:: 2026-09-04]'],
    ['scheduled', '⏳ 2026-09-01', '[scheduled:: 2026-09-01]'],
    ['start', '🛫 2026-08-31', '[start:: 2026-08-31]'],
    ['completion', '✅ 2026-09-05', '[completion:: 2026-09-05]'],
    ['cancelled', '❌ 2026-09-06', '[cancelled:: 2026-09-06]'],
    ['created', '➕ 2026-08-20', '[created:: 2026-08-20]'],
  ];

  it.each(CASES)('reads %s in the emoji flavour and strips it', (name, emoji) => {
    const m = parseTaskMeta(`Fix badge alpha ${emoji}`);
    expect(m.title).toBe('Fix badge alpha');
    expect(m.dates[name as never]).toMatchObject({ flavour: 'emoji' });
    expect(m.flavour).toBe('emoji');
  });

  it.each(CASES)('reads %s in the Dataview flavour and strips it', (name, _e, inline) => {
    const m = parseTaskMeta(`Fix badge alpha ${inline}`);
    expect(m.title).toBe('Fix badge alpha');
    expect(m.dates[name as never]).toMatchObject({ flavour: 'inline' });
    expect(m.flavour).toBe('inline');
  });

  it.each(CASES)('reads the same date whichever spelling %s uses', (name, emoji, inline) => {
    const a = parseTaskMeta(`Fix badge alpha ${emoji}`).dates[name as never] as any;
    const b = parseTaskMeta(`Fix badge alpha ${inline}`).dates[name as never] as any;
    expect(a.date).toBe(b.date);
  });

  it('takes the alternates the plugin itself accepts', () => {
    expect(parseTaskMeta('x 📆 2026-09-04').dates.due?.date).toBe('2026-09-04');
    expect(parseTaskMeta('x 🗓 2026-09-04').dates.due?.date).toBe('2026-09-04');
    expect(parseTaskMeta('x ⌛ 2026-09-04').dates.scheduled?.date).toBe('2026-09-04');
  });

  it('reads a whole line at once and keeps only the words', () => {
    const m = parseTaskMeta(
      '- [ ] Fix badge alpha ➕ 2026-08-20 🛫 2026-08-31 ⏳ 2026-09-01 📅 2026-09-04 ⏫ ~90m 🆔 dg1st4 #content',
    );
    expect(m.title).toBe('Fix badge alpha #content');
    expect(m.dates.created?.date).toBe('2026-08-20');
    expect(m.dates.start?.date).toBe('2026-08-31');
    expect(m.dates.scheduled?.date).toBe('2026-09-01');
    expect(m.dates.due?.date).toBe('2026-09-04');
    expect(m.priority?.level).toBe('high');
    expect(m.fields['wd:est']?.minutes).toBe(90);
    expect(m.id).toBe('dg1st4');
  });

  it('leaves a malformed value in the title, so the typo stays visible', () => {
    expect(parseTaskMeta('Fix it [due:: soon]').title).toBe('Fix it [due:: soon]');
    expect(parseTaskMeta('Fix it [due:: soon]').dates.due).toBeUndefined();
    expect(parseTaskMeta('Fix it 📅 tomorrow').title).toBe('Fix it 📅 tomorrow');
  });

  it('covers every field the standard has — no quiet gaps', () => {
    expect([...DATE_FIELDS]).toEqual([
      'due',
      'scheduled',
      'start',
      'completion',
      'cancelled',
      'created',
    ]);
  });
});

describe('the six priorities', () => {
  const CASES: Array<[PriorityName, string, string]> = [
    ['highest', '🔺', '[priority:: highest]'],
    ['high', '⏫', '[priority:: high]'],
    ['medium', '🔼', '[priority:: medium]'],
    ['low', '🔽', '[priority:: low]'],
    ['lowest', '⏬', '[priority:: lowest]'],
  ];

  it.each(CASES)('reads %s in both spellings', (level, emoji, inline) => {
    expect(parseTaskMeta(`Fix badge alpha ${emoji}`).priority?.level).toBe(level);
    expect(parseTaskMeta(`Fix badge alpha ${inline}`).priority?.level).toBe(level);
    expect(parseTaskMeta(`Fix badge alpha ${emoji}`).title).toBe('Fix badge alpha');
    expect(parseTaskMeta(`Fix badge alpha ${inline}`).title).toBe('Fix badge alpha');
  });

  it('treats the sixth — the unwritten one — as a rank, not a gap', () => {
    const m = parseTaskMeta('Fix badge alpha');
    expect(m.priority).toBeUndefined();
    expect(priorityRank(m)).toBe(PRIORITY_RANK.none);
    // An unmarked task is more urgent than an explicitly low one, and less
    // urgent than a medium one. That's the plugin's own ordering.
    expect(PRIORITY_RANK.medium).toBeLessThan(PRIORITY_RANK.none);
    expect(PRIORITY_RANK.none).toBeLessThan(PRIORITY_RANK.low);
    expect([...PRIORITIES]).toHaveLength(6);
  });

  it('accepts Dataview `normal` as the unwritten middle', () => {
    expect(parseTaskMeta('x [priority:: normal]').priority?.level).toBe('none');
  });

  it('ignores a priority word that isn’t one', () => {
    expect(parseTaskMeta('x [priority:: urgent]').priority).toBeUndefined();
    expect(parseTaskMeta('x [priority:: urgent]').title).toBe('x [priority:: urgent]');
  });
});

describe('mixed flavours on one line', () => {
  it('parses both halves and prefers the majority spelling for writing', () => {
    const m = parseTaskMeta('Ship it 📅 2026-09-04 [priority:: highest] ~90m');
    expect(m.title).toBe('Ship it');
    expect(m.dates.due?.date).toBe('2026-09-04');
    expect(m.priority?.level).toBe('highest');
    expect(m.fields['wd:est']?.minutes).toBe(90);
    // due + `~90m` are emoji-side, priority is inline — emoji wins the tie-break
    // and the tie, because emoji is the plugin's default.
    expect(m.flavour).toBe('emoji');
  });

  it('goes inline only when the line is mostly inline', () => {
    const m = parseTaskMeta('Ship it [due:: 2026-09-04] [priority:: low] ⏳ 2026-09-01');
    expect(m.title).toBe('Ship it');
    expect(m.flavour).toBe('inline');
  });

  it('lets the emoji spelling win when the same field is written twice', () => {
    const m = parseTaskMeta('Ship it 📅 2026-09-04 [due:: 2026-12-25]');
    expect(m.dates.due).toMatchObject({ date: '2026-09-04', flavour: 'emoji' });
    expect(m.title).toBe('Ship it');
  });
});

// ---------------------------------------------------------------------------
// The property that makes the whole thing safe to ship
// ---------------------------------------------------------------------------

describe('a line with no metadata behaves exactly as it did before', () => {
  const PLAIN = [
    'Buy milk',
    '- [ ] Buy milk',
    '- [x] Buy milk',
    '    - [ ] A nested one',
    'Edit video A #content',
    'Call the vet about the cat',
    '',
  ];

  it.each(PLAIN)('%j parses to itself, with nothing claimed', (line) => {
    const m = parseTaskMeta(line);
    expect(m.hasMeta).toBe(false);
    expect(m.flavour).toBeNull();
    expect(m.dates).toEqual({});
    expect(m.priority).toBeUndefined();
    expect(m.recurrence).toBeUndefined();
    expect(m.id).toBeNull();
    expect(m.dependsOn).toEqual([]);
    expect(m.fields).toEqual({});
    expect(m.title).toBe(line.replace(/^\s*-\s\[[ xX]\]\s+/, '').trim());
  });

  it('sorts as a plain list does — stable, in the order it came in', () => {
    const metas = ['Third', 'First', 'Second'].map(parseTaskMeta);
    expect([...metas].sort(compareMeta).map((m) => m.title)).toEqual([
      'Third',
      'First',
      'Second',
    ]);
  });
});

describe('titles that merely look like they carry a signifier', () => {
  const LEFT_ALONE = [
    'Email the ✅ team about the launch', // a bare ✅ is not a completion date
    'Read the 2026-09-04 report', // a date with no field naming it
    'Explain the due:: convention to Sam', // no brackets, no field
    'Ask about priority:: values', // ditto
    '~~90m~~', // strikethrough, not an estimate
    'Old idea ~90m~~', // ambiguous markdown — leave the whole thing visible
    'roughly~90m', // a word, not an estimate
    'Do the thing ~5 times', // no unit
    'Book dentist ~0m', // outside the sanity rails
    'Ship v2 [est:: soon]', // malformed value
    'Look up [[2026-W36]] and check it', // a wikilink, not an inline field
  ];

  it.each(LEFT_ALONE)('%j comes through untouched', (line) => {
    const m = parseTaskMeta(line);
    expect(m.title).toBe(line);
    expect(m.hasMeta).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Read-only by design: 🔁 and 🏁
// ---------------------------------------------------------------------------

describe('recurrence and on-completion are read, never acted on', () => {
  it('reads the rule without swallowing the rest of the line', () => {
    const m = parseTaskMeta('Water plants 🔁 every week 📅 2026-09-04 #home');
    expect(m.recurrence?.rule).toBe('every week');
    expect(m.dates.due?.date).toBe('2026-09-04');
    expect(m.title).toBe('Water plants #home');
  });

  it('reads the Dataview spelling too', () => {
    expect(parseTaskMeta('Water plants [repeat:: every week]').recurrence?.rule).toBe(
      'every week',
    );
    expect(parseTaskMeta('Water plants [recurrence:: every day]').recurrence?.rule).toBe(
      'every day',
    );
  });

  it('reads 🏁 and stops there', () => {
    const m = parseTaskMeta('Water plants 🔁 every week when done 🏁 delete');
    expect(m.recurrence?.rule).toBe('every week when done');
    expect(m.onCompletion?.value).toBe('delete');
    expect(m.title).toBe('Water plants');
  });

  it('isRecurring is the one question rollWeek asks', () => {
    expect(isRecurring('- [ ] Water plants 🔁 every week')).toBe(true);
    expect(isRecurring('- [ ] Water plants [repeat:: every week]')).toBe(true);
    expect(isRecurring('- [ ] Water plants')).toBe(false);
    expect(isRecurring('- [ ] Talk about recurring meetings')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tier 3 — `wd:est`, ours and flagged as ours
// ---------------------------------------------------------------------------

describe('wd:est rides the same parser', () => {
  it('is filed under the namespaced key, in both spellings', () => {
    expect(Object.keys(parseTaskMeta('Cut the VOD ~90m').fields)).toEqual(['wd:est']);
    expect(Object.keys(parseTaskMeta('Cut the VOD [est:: 90m]').fields)).toEqual(['wd:est']);
    expect(Object.keys(parseTaskMeta('Cut the VOD').fields)).toEqual([]);
  });

  it('keeps the named inline field winning over the tilde', () => {
    expect(parseTaskMeta('Edit video ~30m [est:: 2h]').fields['wd:est']).toEqual({
      minutes: 120,
      raw: '[est:: 2h]',
      flavour: 'inline',
    });
    expect(parseTaskMeta('Edit video ~30m [est:: 2h]').title).toBe('Edit video');
  });

  it('survives the company of the standard’s own fields', () => {
    const m = parseTaskMeta('Edit video 📅 2026-09-04 🔺 ~2h ⛔ abc123');
    expect(m.fields['wd:est']?.minutes).toBe(120);
    expect(m.dependsOn).toEqual(['abc123']);
    expect(m.title).toBe('Edit video');
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — the write side, all of it
// ---------------------------------------------------------------------------

describe('the completion stamp — the only thing this app writes', () => {
  it('matches the flavour already on the line', () => {
    expect(withCompletion('- [x] Fix badge alpha 📅 2026-09-04', '2026-09-05')).toBe(
      '- [x] Fix badge alpha 📅 2026-09-04 ✅ 2026-09-05',
    );
    expect(withCompletion('- [x] Fix badge alpha [due:: 2026-09-04]', '2026-09-05')).toBe(
      '- [x] Fix badge alpha [due:: 2026-09-04] [completion:: 2026-09-05]',
    );
  });

  it('uses emoji for a line that carries no metadata at all', () => {
    expect(withCompletion('- [x] Buy milk', '2026-09-05')).toBe('- [x] Buy milk ✅ 2026-09-05');
    expect(completionRaw('2026-09-05', 'emoji')).toBe('✅ 2026-09-05');
    expect(completionRaw('2026-09-05', 'inline')).toBe('[completion:: 2026-09-05]');
  });

  it('never stacks two dates', () => {
    const once = withCompletion('- [x] Buy milk', '2026-09-05');
    expect(withCompletion(once, '2026-09-06')).toBe('- [x] Buy milk ✅ 2026-09-06');
  });

  it('comes back off on an untick, in either flavour', () => {
    expect(clearCompletion('- [ ] Buy milk ✅ 2026-09-05')).toBe('- [ ] Buy milk');
    expect(clearCompletion('- [ ] Buy milk [completion:: 2026-09-05]')).toBe('- [ ] Buy milk');
    expect(clearCompletion('- [ ] Buy milk')).toBe('- [ ] Buy milk');
  });

  it('leaves 🔁 and 🏁 exactly where they were', () => {
    const line = '- [x] Water plants 🔁 every week 🏁 keep';
    const after = withCompletion(line, '2026-09-05');
    expect(after).toBe('- [x] Water plants 🔁 every week 🏁 keep ✅ 2026-09-05');
    expect(parseTaskMeta(after).recurrence?.rule).toBe('every week');
    expect(parseTaskMeta(after).onCompletion?.value).toBe('keep');
  });
});

// ---------------------------------------------------------------------------
// Sorting the Unscheduled rail
// ---------------------------------------------------------------------------

describe('rail order — priority, then due date, then whatever it was', () => {
  const order = (lines: string[]) =>
    lines.map(parseTaskMeta).sort(compareMeta).map((m) => m.title);

  it('puts the most urgent priority first', () => {
    expect(
      order(['Low ⏬', 'Normal', 'Highest 🔺', 'High ⏫', 'Medium 🔼', 'Lower 🔽']),
    ).toEqual(['Highest', 'High', 'Medium', 'Normal', 'Lower', 'Low']);
  });

  it('breaks a priority tie on the due date, soonest first', () => {
    expect(
      order(['C ⏫ 📅 2026-09-10', 'A ⏫ 📅 2026-09-01', 'B ⏫ [due:: 2026-09-05]']),
    ).toEqual(['A', 'B', 'C']);
  });

  it('puts an undated task after a dated one at the same priority', () => {
    expect(order(['Undated ⏫', 'Dated ⏫ 📅 2026-12-25'])).toEqual(['Dated', 'Undated']);
  });

  it('priority beats a due date — an urgent thing is urgent', () => {
    expect(order(['Later 🔺 📅 2026-12-25', 'Sooner 🔽 📅 2026-09-01'])).toEqual([
      'Later',
      'Sooner',
    ]);
  });
});

describe('overdue', () => {
  const at = (line: string) => parseTaskMeta(line);

  it('is a past due date and nothing else', () => {
    expect(isOverdue(at('x 📅 2026-09-01'), '2026-09-02')).toBe(true);
    expect(isOverdue(at('x 📅 2026-09-02'), '2026-09-02')).toBe(false); // due today
    expect(isOverdue(at('x 📅 2026-09-03'), '2026-09-02')).toBe(false);
    expect(isOverdue(at('x ⏳ 2026-09-01'), '2026-09-02')).toBe(false); // scheduled ≠ due
    expect(isOverdue(at('x'), '2026-09-02')).toBe(false);
  });

  it('formats short enough for the rail', () => {
    expect(fmtDue('2026-09-04')).toBe('4 Sep');
    expect(fmtDue('2026-12-25')).toBe('25 Dec');
    expect(fmtDue('nonsense')).toBe('nonsense');
  });
});

describe('taskTitle', () => {
  it('is what the rail, the ghost block and the Google summary all show', () => {
    expect(taskTitle('- [ ] Fix badge alpha 📅 2026-09-04 ⏫ ~90m 🆔 dg1st4')).toBe(
      'Fix badge alpha',
    );
  });
});

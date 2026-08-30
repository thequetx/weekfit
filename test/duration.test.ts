import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DURATIONS,
  EST_FIELD,
  FALLBACK_MINUTES,
  MAX_ESTIMATE_MINUTES,
  MIN_ESTIMATE_MINUTES,
  committedMinutes,
  fmtEstimate,
  fmtHours,
  parseDurationValue,
  parseTaskLine,
  resolveTaskDuration,
  snapToGrid,
  taskKind,
} from '../src/lib/duration';
import type { DurationMap, VaultTask } from '../src/lib/types';

const MAP: DurationMap = {
  defaultMinutes: 60,
  byKind: { content: 90, admin: 30, errand: 45, 'meal-prep': 120 },
};

const task = (text: string, done = false): VaultTask => ({
  text,
  done,
  file: 'Weekly/2026-W36.md',
  line: 0,
});

// ---------------------------------------------------------------------------
// The value grammar (shared by the yaml map, `~90m` and `[est:: 90m]`)
// ---------------------------------------------------------------------------

describe('parseDurationValue', () => {
  it('reads minutes, in every spelling', () => {
    expect(parseDurationValue('90m')).toBe(90);
    expect(parseDurationValue('90min')).toBe(90);
    expect(parseDurationValue('90mins')).toBe(90);
    expect(parseDurationValue('90 minutes')).toBe(90);
  });

  it('reads hours, including fractional ones', () => {
    expect(parseDurationValue('2h')).toBe(120);
    expect(parseDurationValue('1.5h')).toBe(90);
    expect(parseDurationValue('1.5 hours')).toBe(90);
    expect(parseDurationValue('0.25hr')).toBe(15);
  });

  it('treats a bare number as minutes — yaml writes `90`, not `"90m"`', () => {
    expect(parseDurationValue('45')).toBe(45);
    expect(parseDurationValue(45)).toBe(45);
  });

  it('is case-insensitive and tolerates surrounding space', () => {
    expect(parseDurationValue('  90M ')).toBe(90);
    expect(parseDurationValue('2H')).toBe(120);
  });

  it('rejects a zero or negative estimate rather than making a 0-height block', () => {
    expect(parseDurationValue('0m')).toBeNull();
    expect(parseDurationValue('0')).toBeNull();
    expect(parseDurationValue('-30m')).toBeNull();
  });

  it('rejects an absurd one rather than making a year-long block', () => {
    expect(parseDurationValue('9999h')).toBeNull();
    expect(parseDurationValue('5000m')).toBeNull();
    expect(parseDurationValue(MAX_ESTIMATE_MINUTES + 1)).toBeNull();
    expect(parseDurationValue(MAX_ESTIMATE_MINUTES)).toBe(MAX_ESTIMATE_MINUTES);
  });

  it('rejects anything below the sanity floor', () => {
    expect(parseDurationValue(MIN_ESTIMATE_MINUTES - 1)).toBeNull();
    expect(parseDurationValue(MIN_ESTIMATE_MINUTES)).toBe(MIN_ESTIMATE_MINUTES);
  });

  it('rejects things that are not durations at all', () => {
    expect(parseDurationValue('banana')).toBeNull();
    expect(parseDurationValue('90 bananas')).toBeNull();
    expect(parseDurationValue('')).toBeNull();
    expect(parseDurationValue(null)).toBeNull();
    expect(parseDurationValue(undefined)).toBeNull();
    expect(parseDurationValue('1:30')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rung B — `~90m`, and the strikethrough it must not collide with
// ---------------------------------------------------------------------------

describe('rung B — the `~90m` override', () => {
  it('reads the estimate and strips it from the display title', () => {
    const p = parseTaskLine('Cut the Tuesday VOD ~90m');
    expect(p.fields[EST_FIELD]).toEqual({ minutes: 90, raw: '~90m', flavour: 'tilde' });
    expect(p.title).toBe('Cut the Tuesday VOD');
  });

  it('reads hours and half-hours', () => {
    expect(parseTaskLine('Edit video A ~1.5h').fields[EST_FIELD]?.minutes).toBe(90);
    expect(parseTaskLine('Edit video A ~2h').fields[EST_FIELD]?.minutes).toBe(120);
    expect(parseTaskLine('Quick one ~30min').fields[EST_FIELD]?.minutes).toBe(30);
  });

  it('is typeable anywhere on the line, not only at the end', () => {
    const p = parseTaskLine('~45m Book dentist');
    expect(p.fields[EST_FIELD]?.minutes).toBe(45);
    expect(p.title).toBe('Book dentist');
  });

  it('leaves a doubled tilde alone — `~~` is strikethrough', () => {
    for (const line of ['~~90m~~', '~~Done anyway 90m~~', 'a ~~90m~~ b']) {
      expect(parseTaskLine(line).fields[EST_FIELD]).toBeUndefined();
      expect(parseTaskLine(line).title).toBe(line);
    }
  });

  it('will not eat half of a strikethrough that trails an estimate-shaped run', () => {
    // `~90m~~` is ambiguous markdown; leave the whole thing visible rather than
    // silently removing the opening half and stranding a `~~`.
    expect(parseTaskLine('Old idea ~90m~~').fields[EST_FIELD]).toBeUndefined();
  });

  it('needs whitespace (or the line start) before the tilde', () => {
    // `approx~90m` is a word, not an estimate.
    expect(parseTaskLine('roughly~90m').fields[EST_FIELD]).toBeUndefined();
  });

  it('needs a unit — a lone `~5` is "about five of something"', () => {
    expect(parseTaskLine('Do the thing ~5').fields[EST_FIELD]).toBeUndefined();
    expect(parseTaskLine('Do the thing ~5 times').fields[EST_FIELD]).toBeUndefined();
  });

  it('leaves a malformed estimate in the title, so the typo stays visible', () => {
    expect(parseTaskLine('Book dentist ~0m').title).toBe('Book dentist ~0m');
    expect(parseTaskLine('Edit video ~9999h').title).toBe('Edit video ~9999h');
    expect(parseTaskLine('Edit video ~9999h').fields[EST_FIELD]).toBeUndefined();
  });

  it('tidies the seam it leaves behind', () => {
    expect(parseTaskLine('Book ~30m dentist').title).toBe('Book dentist');
    expect(parseTaskLine('  Book dentist ~30m  ').title).toBe('Book dentist');
  });
});

// ---------------------------------------------------------------------------
// Rung C — `[est:: 90m]`
// ---------------------------------------------------------------------------

describe('rung C — the `[est:: 90m]` inline field', () => {
  it('reads the Dataview flavour and strips it', () => {
    const p = parseTaskLine('Book dentist [est:: 90m]');
    expect(p.fields[EST_FIELD]).toEqual({
      minutes: 90,
      raw: '[est:: 90m]',
      flavour: 'inline',
    });
    expect(p.title).toBe('Book dentist');
  });

  it('accepts the parenthesised flavour and odd spacing', () => {
    expect(parseTaskLine('Book dentist (est:: 1.5h)').fields[EST_FIELD]?.minutes).toBe(90);
    expect(parseTaskLine('Book dentist [est::30m]').fields[EST_FIELD]?.minutes).toBe(30);
    expect(parseTaskLine('Book dentist [EST ::  2h ]').fields[EST_FIELD]?.minutes).toBe(120);
  });

  it('parses regardless of the flavour the rest of the line uses', () => {
    const p = parseTaskLine('Book dentist [due:: 2026-09-02] [est:: 45m] #admin');
    expect(p.fields[EST_FIELD]?.minutes).toBe(45);
    // Phase 5 §1: `[due:: …]` is a field this app understands now, so it comes
    // out of the display title too. Before, only the estimate did, and the rail
    // showed the raw Dataview alongside the name of the work.
    expect(p.title).toBe('Book dentist #admin');
  });

  it('leaves a malformed value alone', () => {
    const p = parseTaskLine('Book dentist [est:: soon]');
    expect(p.fields[EST_FIELD]).toBeUndefined();
    expect(p.title).toBe('Book dentist [est:: soon]');
  });

  it('files the result under a namespaced key — this is not the Tasks standard', () => {
    expect(EST_FIELD).toBe('wd:est');
    expect(Object.keys(parseTaskLine('x ~30m').fields)).toEqual(['wd:est']);
    expect(Object.keys(parseTaskLine('x').fields)).toEqual([]);
  });
});

describe('B and C together', () => {
  it('lets the named inline field win — it is the more deliberate of the two', () => {
    const p = parseTaskLine('Edit video ~30m [est:: 2h]');
    expect(p.fields[EST_FIELD]).toEqual({
      minutes: 120,
      raw: '[est:: 2h]',
      flavour: 'inline',
    });
  });

  it('strips both regardless of which one won', () => {
    expect(parseTaskLine('Edit video ~30m [est:: 2h]').title).toBe('Edit video');
    expect(parseTaskLine('Edit video [est:: 2h] ~30m').title).toBe('Edit video');
  });

  it('falls back to the tilde when the inline field is junk', () => {
    const p = parseTaskLine('Edit video ~30m [est:: soon]');
    expect(p.fields[EST_FIELD]?.minutes).toBe(30);
    expect(p.title).toBe('Edit video [est:: soon]');
  });
});

// ---------------------------------------------------------------------------
// Rung A — default by kind
// ---------------------------------------------------------------------------

describe('taskKind', () => {
  const byKind = MAP.byKind;

  it('matches a tag that names a durations key', () => {
    expect(taskKind('Cut the VOD #content', byKind)).toBe('content');
    expect(taskKind('#admin Book dentist', byKind)).toBe('admin');
  });

  it('is case-insensitive and handles hyphenated kinds', () => {
    expect(taskKind('Sunday cook #Meal-Prep', byKind)).toBe('meal-prep');
  });

  it('falls back to the last segment of a nested tag', () => {
    expect(taskKind('Invoice #work/admin', byKind)).toBe('admin');
  });

  it('ignores tags that name nothing in the map', () => {
    expect(taskKind('Book dentist #thisweek', byKind)).toBeNull();
    expect(taskKind('Book dentist', byKind)).toBeNull();
  });

  it('takes the first matching tag when a line carries several', () => {
    expect(taskKind('Thing #admin #content', byKind)).toBe('admin');
    expect(taskKind('Thing #thisweek #content #admin', byKind)).toBe('content');
  });

  it('needs a real tag, not a mid-word hash', () => {
    expect(taskKind('Fix issue no#content', byKind)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The ladder — precedence
// ---------------------------------------------------------------------------

describe('resolveTaskDuration — override > kind > fallback', () => {
  it('gives every task a size, including a plain untagged line', () => {
    expect(resolveTaskDuration('Book dentist', MAP)).toEqual({
      title: 'Book dentist',
      minutes: 60,
      source: 'default',
    });
  });

  it('uses the kind default when a tag names one', () => {
    expect(resolveTaskDuration('Cut the VOD #content', MAP)).toEqual({
      title: 'Cut the VOD #content',
      minutes: 90,
      source: 'kind',
      kind: 'content',
    });
  });

  it('leaves the kind tag in the title — only the estimate is stripped', () => {
    expect(resolveTaskDuration('Cut the VOD #content ~2h', MAP).title).toBe(
      'Cut the VOD #content',
    );
  });

  it('lets a `~90m` override beat the kind default', () => {
    expect(resolveTaskDuration('Cut the VOD #content ~30m', MAP)).toEqual({
      title: 'Cut the VOD #content',
      minutes: 30,
      source: 'override',
      flavour: 'tilde',
    });
  });

  it('lets an `[est:: …]` override beat the kind default', () => {
    expect(resolveTaskDuration('Cut the VOD #content [est:: 3h]', MAP)).toMatchObject({
      minutes: 180,
      source: 'override',
      flavour: 'inline',
    });
  });

  it('falls past a malformed override to the kind default', () => {
    expect(resolveTaskDuration('Cut the VOD #content ~0m', MAP)).toMatchObject({
      minutes: 90,
      source: 'kind',
    });
  });

  it('falls all the way to the fallback when nothing matches', () => {
    expect(resolveTaskDuration('Book dentist ~9999h #nope', MAP)).toMatchObject({
      minutes: 60,
      source: 'default',
    });
  });

  it('honours a fallback other than 60m', () => {
    const map: DurationMap = { defaultMinutes: 25, byKind: {} };
    expect(resolveTaskDuration('Book dentist', map).minutes).toBe(25);
  });

  it('defaults to 60m with no map at all — exactly the pre-Phase-4 behaviour', () => {
    expect(resolveTaskDuration('Book dentist').minutes).toBe(FALLBACK_MINUTES);
    expect(DEFAULT_DURATIONS.defaultMinutes).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Consumers: the grid snap and the rail footer
// ---------------------------------------------------------------------------

describe('snapToGrid', () => {
  it('snaps a dropped block to the grid quantum', () => {
    expect(snapToGrid(90)).toBe(90);
    expect(snapToGrid(45)).toBe(60);
    expect(snapToGrid(44)).toBe(30);
    expect(snapToGrid(120)).toBe(120);
  });

  it('never produces a zero-height block', () => {
    expect(snapToGrid(5)).toBe(30);
    expect(snapToGrid(0)).toBe(30);
    expect(snapToGrid(Number.NaN)).toBe(30);
  });
});

describe('committedMinutes', () => {
  it('adds up the open tasks and ignores the done ones', () => {
    const tasks = [
      task('Cut the VOD #content'), // 90 (kind)
      task('Book dentist'), // 60 (fallback)
      task('Invoice #admin ~15m'), // 15 → booked as 30
      task('Already finished #content', true), // ignored
    ];
    expect(committedMinutes(tasks, MAP)).toBe(180);
  });

  it('counts each task as it would actually be booked', () => {
    // The footer's whole job is making over-commitment visible, and it is read
    // against the free hours the gap engine reports. Every path that books a
    // task — the grid drop handler and the gap engine both — snaps to the
    // 30-minute lattice, so a footer that summed the raw estimates would
    // under-report by a quarter-hour per odd task and quietly disagree with the
    // week it is describing.
    expect(committedMinutes([task('Quick note ~15m')], MAP)).toBe(30);
    expect(committedMinutes([task('Errand ~45m')], MAP)).toBe(60);
    // A task already on the lattice is unchanged.
    expect(committedMinutes([task('Cut the VOD #content')], MAP)).toBe(90);
  });

  it('is zero for an empty rail', () => {
    expect(committedMinutes([], MAP)).toBe(0);
  });
});

describe('labels', () => {
  it('formats a chip', () => {
    expect(fmtEstimate(30)).toBe('30m');
    expect(fmtEstimate(60)).toBe('1h');
    expect(fmtEstimate(90)).toBe('1h 30m');
    expect(fmtEstimate(180)).toBe('3h');
  });

  it('formats the footer total to one decimal', () => {
    expect(fmtHours(390)).toBe('6.5h');
    expect(fmtHours(840)).toBe('14h');
    expect(fmtHours(0)).toBe('0h');
    expect(fmtHours(50)).toBe('0.8h');
  });
});

// ---------------------------------------------------------------------------

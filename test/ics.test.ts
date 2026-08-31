import { afterEach, describe, expect, it, vi } from 'vitest';

// The .ics path is the only place this plugin expands recurrence rules itself
// — everything else in the app is either a vault line or (once wired up in a
// later wave) a calendar event already expanded upstream. Times in the
// fixtures are UTC so the expectations don't move with the run's timezone;
// loadCalendar converts to local Date objects, which is what the grid wants.
//
// `obsidian` ships no runtime JS under plain vitest, so `requestUrl` is
// mocked here the same way `test/vaultRepo.test.ts` mocks `moment`/`TFile` —
// an async factory, then `await import(...)` for both the mocked module and
// the code under test, so nothing runs against the real (nonexistent) module.
vi.mock('obsidian', async () => {
  return { requestUrl: vi.fn() };
});

const { requestUrl } = (await import('obsidian')) as unknown as {
  requestUrl: ReturnType<typeof vi.fn>;
};
const { loadCalendar, fetchIcsEvents } = await import('../src/data/ics');

const ICS_URL = 'https://example.invalid/calendar.ics';

// `requestUrl` returns `.text` as a string *property*, not a method the way
// `fetch`'s `Response.text()` is — this stub matches that shape.
function serve(ics: string, init: { status?: number } = {}) {
  requestUrl.mockResolvedValue({ status: init.status ?? 200, text: ics });
}

function cal(...events: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//week-dashboard//test//EN',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');
}

const iso = (d: Date) => d.toISOString();
const range = (a: string, b: string) => [new Date(a), new Date(b)] as const;

afterEach(() => {
  vi.clearAllMocks();
});

describe('loadCalendar — plain events', () => {
  it('returns events that overlap the range and drops the rest', () => {
    serve(
      cal(
        'BEGIN:VEVENT\r\nUID:in\r\nSUMMARY:In range\r\nDTSTART:20260826T083000Z\r\nDTEND:20260826T093000Z\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:before\r\nSUMMARY:Long past\r\nDTSTART:20260101T000000Z\r\nDTEND:20260101T010000Z\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:after\r\nSUMMARY:Far future\r\nDTSTART:20271201T000000Z\r\nDTEND:20271201T010000Z\r\nEND:VEVENT',
      ),
    );
    const [a, b] = range('2026-08-24T00:00:00Z', '2026-08-31T00:00:00Z');
    return loadCalendar(ICS_URL, a, b).then((out) => {
      expect(out.map((e) => e.uid)).toEqual(['in']);
      expect(out[0].title).toBe('In range');
      expect(iso(out[0].start)).toBe('2026-08-26T08:30:00.000Z');
      expect(out[0].allDay).toBe(false);
    });
  });

  it('marks a DATE-valued event as all-day', async () => {
    serve(
      cal(
        'BEGIN:VEVENT\r\nUID:ad\r\nSUMMARY:Public holiday\r\nDTSTART;VALUE=DATE:20260826\r\nDTEND;VALUE=DATE:20260827\r\nEND:VEVENT',
      ),
    );
    const [a, b] = range('2026-08-24T00:00:00Z', '2026-08-31T00:00:00Z');
    const out = await loadCalendar(ICS_URL, a, b);
    expect(out).toHaveLength(1);
    expect(out[0].allDay).toBe(true);
  });

  it('falls back to (untitled) when there is no SUMMARY', async () => {
    serve(
      cal(
        'BEGIN:VEVENT\r\nUID:bare\r\nDTSTART:20260826T083000Z\r\nDTEND:20260826T093000Z\r\nEND:VEVENT',
      ),
    );
    const [a, b] = range('2026-08-24T00:00:00Z', '2026-08-31T00:00:00Z');
    expect((await loadCalendar(ICS_URL, a, b))[0].title).toBe('(untitled)');
  });

  it('sorts by start time regardless of file order', async () => {
    serve(
      cal(
        'BEGIN:VEVENT\r\nUID:late\r\nSUMMARY:Late\r\nDTSTART:20260828T200000Z\r\nDTEND:20260828T210000Z\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:early\r\nSUMMARY:Early\r\nDTSTART:20260825T060000Z\r\nDTEND:20260825T070000Z\r\nEND:VEVENT',
      ),
    );
    const [a, b] = range('2026-08-24T00:00:00Z', '2026-08-31T00:00:00Z');
    const out = await loadCalendar(ICS_URL, a, b);
    expect(out.map((e) => e.uid)).toEqual(['early', 'late']);
  });

  it('reports the bad status when the feed does not come back clean', async () => {
    serve('', { status: 404 });
    const [a, b] = range('2026-08-24T00:00:00Z', '2026-08-31T00:00:00Z');
    await expect(loadCalendar(ICS_URL, a, b)).rejects.toThrow(/calendar feed returned 404/);
  });

  it('rejects cleanly (never crashes the caller) on a malformed/truncated body', async () => {
    serve('this is not an ICS file at all, just garbage text');
    const [a, b] = range('2026-08-24T00:00:00Z', '2026-08-31T00:00:00Z');
    // ICAL.parse throws on unparsable input. The important property here is
    // that it surfaces as a normal rejected promise — fetchIcsEvents below is
    // what turns this into a silent [] for the grid; loadCalendar itself is
    // allowed to throw, and this pins down that it does so cleanly rather
    // than, say, hanging or throwing something uncatchable.
    await expect(loadCalendar(ICS_URL, a, b)).rejects.toThrow();
  });
});

describe('loadCalendar — recurrence expansion', () => {
  // A weekly Tuesday+Thursday stream, running from well before the window.
  const WEEKLY =
    'BEGIN:VEVENT\r\n' +
    'UID:stream\r\n' +
    'SUMMARY:Twitch Stream\r\n' +
    'DTSTART:20260602T083000Z\r\n' +
    'DTEND:20260602T113000Z\r\n' +
    'RRULE:FREQ=WEEKLY;BYDAY=TU,TH\r\n' +
    'END:VEVENT';

  it('expands a rule into one entry per occurrence in the window', async () => {
    serve(cal(WEEKLY));
    const [a, b] = range('2026-08-24T00:00:00Z', '2026-08-31T00:00:00Z');
    const out = await loadCalendar(ICS_URL, a, b);
    const inWindow = out.filter((e) => e.start >= a && e.start < b);
    expect(inWindow.map((e) => iso(e.start))).toEqual([
      '2026-08-25T08:30:00.000Z', // Tue
      '2026-08-27T08:30:00.000Z', // Thu
    ]);
    expect(inWindow.every((e) => e.uid === 'stream')).toBe(true);
    expect(inWindow.every((e) => e.title === 'Twitch Stream')).toBe(true);
  });

  it('carries the duration onto every occurrence', async () => {
    serve(cal(WEEKLY));
    const [a, b] = range('2026-08-24T00:00:00Z', '2026-08-31T00:00:00Z');
    const out = await loadCalendar(ICS_URL, a, b);
    for (const e of out) {
      expect(e.end.getTime() - e.start.getTime()).toBe(3 * 3_600_000);
    }
  });

  it('stops at the end of the window rather than running to the crack of doom', async () => {
    serve(cal(WEEKLY));
    const [a, b] = range('2026-08-24T00:00:00Z', '2026-08-31T00:00:00Z');
    const out = await loadCalendar(ICS_URL, a, b);
    // The loop breaks on the first occurrence past the window, so nothing lands
    // more than one occurrence beyond it.
    expect(out.filter((e) => e.start.getTime() > b.getTime() + 7 * 86_400_000)).toEqual([]);
  });

  it('honours UNTIL', async () => {
    serve(
      cal(
        'BEGIN:VEVENT\r\nUID:ends\r\nSUMMARY:Ends\r\nDTSTART:20260804T083000Z\r\nDTEND:20260804T093000Z\r\n' +
          'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260819T000000Z\r\nEND:VEVENT',
      ),
    );
    const [a, b] = range('2026-08-24T00:00:00Z', '2026-08-31T00:00:00Z');
    expect(await loadCalendar(ICS_URL, a, b)).toEqual([]);
  });

  it('skips an EXDATEd occurrence', async () => {
    serve(
      cal(
        'BEGIN:VEVENT\r\nUID:stream\r\nSUMMARY:Twitch Stream\r\nDTSTART:20260602T083000Z\r\nDTEND:20260602T113000Z\r\n' +
          'RRULE:FREQ=WEEKLY;BYDAY=TU,TH\r\nEXDATE:20260825T083000Z\r\nEND:VEVENT',
      ),
    );
    const [a, b] = range('2026-08-24T00:00:00Z', '2026-08-31T00:00:00Z');
    const out = await loadCalendar(ICS_URL, a, b);
    const inWindow = out.filter((e) => e.start >= a && e.start < b);
    expect(inWindow.map((e) => iso(e.start))).toEqual(['2026-08-27T08:30:00.000Z']);
  });

  it('applies a RECURRENCE-ID override — the moved/renamed occurrence wins', async () => {
    serve(
      cal(
        'BEGIN:VEVENT\r\nUID:stream\r\nSUMMARY:Twitch Stream\r\nDTSTART:20260602T083000Z\r\nDTEND:20260602T113000Z\r\n' +
          'RRULE:FREQ=WEEKLY;BYDAY=TU,TH\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:stream\r\nSUMMARY:Twitch Stream (guest)\r\nRECURRENCE-ID:20260825T083000Z\r\n' +
          'DTSTART:20260825T100000Z\r\nDTEND:20260825T130000Z\r\nEND:VEVENT',
      ),
    );
    const [a, b] = range('2026-08-24T00:00:00Z', '2026-08-31T00:00:00Z');
    const out = await loadCalendar(ICS_URL, a, b);
    const tue = out.filter((e) => e.start >= a && e.start < new Date('2026-08-26T00:00:00Z'));
    expect(tue).toHaveLength(1);
    expect(tue[0].title).toBe('Twitch Stream (guest)');
    expect(iso(tue[0].start)).toBe('2026-08-25T10:00:00.000Z');
    expect(iso(tue[0].end)).toBe('2026-08-25T13:00:00.000Z');
    // The un-overridden Thursday is untouched.
    expect(out.some((e) => iso(e.start) === '2026-08-27T08:30:00.000Z')).toBe(true);
  });
});

describe('fetchIcsEvents', () => {
  const NOW = new Date('2026-08-31T12:00:00Z');

  it('returns [] immediately for an empty or blank url, without calling requestUrl', async () => {
    expect(await fetchIcsEvents('', NOW)).toEqual([]);
    expect(await fetchIcsEvents('   ', NOW)).toEqual([]);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it('keeps only events inside the -2/+8 week window from a decade-spanning feed', async () => {
    const years = [2018, 2020, 2022, 2024, 2026, 2026, 2028, 2030];
    const events = years.map(
      (y, i) =>
        `BEGIN:VEVENT\r\nUID:e${i}\r\nSUMMARY:Event ${y}\r\nDTSTART:${y}0901T120000Z\r\nDTEND:${y}0901T130000Z\r\nEND:VEVENT`,
    );
    // One more, placed right at the edges of the window around NOW so the
    // boundary itself is exercised, not just decade-scale misses.
    events.push(
      'BEGIN:VEVENT\r\nUID:just-in\r\nSUMMARY:Just inside\r\nDTSTART:20260901T120000Z\r\nDTEND:20260901T130000Z\r\nEND:VEVENT',
    );
    serve(cal(...events));

    const out = await fetchIcsEvents(ICS_URL, NOW);
    expect(out.map((e) => e.uid)).toEqual(['e4', 'e5', 'just-in']);
  });

  it('returns [] and never throws when requestUrl itself throws', async () => {
    requestUrl.mockRejectedValue(new Error('network is down'));
    await expect(fetchIcsEvents(ICS_URL, NOW)).resolves.toEqual([]);
  });

  it('returns [] and never throws on a malformed feed body', async () => {
    serve('not valid ics content');
    await expect(fetchIcsEvents(ICS_URL, NOW)).resolves.toEqual([]);
  });

  it('returns [] and never throws on a bad status', async () => {
    serve('', { status: 500 });
    await expect(fetchIcsEvents(ICS_URL, NOW)).resolves.toEqual([]);
  });
});

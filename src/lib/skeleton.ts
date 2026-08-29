import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type {
  AvailabilityWindow,
  DurationMap,
  SkeletonBlock,
  SkeletonDoc,
} from './types';
import { readSkeletonYaml } from './shell';
import { FALLBACK_MINUTES, parseDurationValue } from './duration';
import { DEFAULT_MIN_BLOCK } from './gaps';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_MAP: Record<string, number> = Object.fromEntries(
  DAYS.map((d, i) => [d, i]),
);

/** Reserved key inside `durations:` — the global fallback, not a task kind. */
const DEFAULT_KEY = 'default';

function toMinutes(hhmm: string): number {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function fromMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

interface RawBlock {
  name: string;
  kind?: string;
  days: string[];
  start: string;
  end: string;
  note?: string;
  /** Phase 6 §1 — minutes of pre-block escalation; 0 disables it. */
  lead?: unknown;
}

interface RawWindow {
  name?: string;
  days?: string[];
  start?: string;
  end?: string;
  min_block?: unknown;
}

interface RawDoc {
  blocks?: RawBlock[];
  durations?: Record<string, unknown>;
  windows?: RawWindow[];
  timezone?: string;
  task_folders?: unknown;
}

/** The `task_folders:` list — Phase 5 §3's sweep scope. Undefined when the key
 *  is absent, which is not the same as an empty list: absent leaves
 *  `WD_TASK_FOLDERS` in charge, empty means the whole vault. */
export function parseTaskFolders(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => String(s).trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, ''))
    .filter((s, i, all) => s && s !== '.' && all.indexOf(s) === i);
}

function parseDays(days: unknown): number[] {
  return (Array.isArray(days) ? days : [])
    .map((d) => DAY_MAP[String(d).toLowerCase()])
    .filter((n): n is number => n !== undefined);
}

function parseBlocks(raw: RawDoc | null): SkeletonBlock[] {
  return (raw?.blocks ?? []).map((b) => ({
    name: b.name,
    kind: b.kind ?? 'block',
    days: parseDays(b.days),
    startMin: toMinutes(b.start),
    endMin: toMinutes(b.end),
    note: b.note,
    // Phase 6 §1. `0` is meaningful (escalation off for this block), so an
    // explicit zero has to survive the round trip that a `||` would swallow.
    leadMin: b.lead == null ? undefined : Math.max(0, Math.round(Number(b.lead) || 0)),
  }));
}

/** The `windows:` list — Phase 4 §2's time map. A window that spans nothing
 *  (missing or inverted times) is dropped rather than kept as a zero-width
 *  range that would quietly contribute no gaps and no explanation. */
export function parseWindows(raw: unknown): AvailabilityWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: AvailabilityWindow[] = [];
  for (const w of raw as RawWindow[]) {
    if (!w || typeof w !== 'object') continue;
    const name = String(w.name ?? '').trim().toLowerCase();
    const startMin = toMinutes(w.start ?? '');
    const endMin = toMinutes(w.end ?? '');
    if (!name || !(endMin > startMin)) continue;
    const days = parseDays(w.days);
    if (!days.length) continue;
    // `min_block: 0` is a deliberate "no minimum"; anything unparseable is a
    // typo and gets the default rather than silently turning the rule off.
    const zero = Number(w.min_block) === 0 && String(w.min_block ?? '').trim() !== '';
    const minBlock = zero ? 0 : parseDurationValue(w.min_block);
    out.push({
      name,
      days,
      startMin,
      endMin,
      minBlockMin: minBlock ?? DEFAULT_MIN_BLOCK,
    });
  }
  return out;
}

/** The `durations:` map — rung A of Phase 4 §1. Unparseable values are dropped
 *  rather than defaulted, so one typo can't silently resize every task of a
 *  kind; that kind just falls through to the global fallback. */
export function parseDurations(raw: unknown): DurationMap {
  const out: DurationMap = { defaultMinutes: FALLBACK_MINUTES, byKind: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const minutes = parseDurationValue(v);
    if (minutes == null) continue;
    const key = String(k).trim().toLowerCase();
    if (!key) continue;
    if (key === DEFAULT_KEY) out.defaultMinutes = minutes;
    else out.byKind[key] = minutes;
  }
  return out;
}

/**
 * A stable string for a set of availability windows — equal whenever the time
 * map is, whatever arrays it happens to be sitting in.
 *
 * `parseSkeletonDoc` allocates a new `windows` array on every read, and the app
 * re-reads the yaml on every refresh tick, so array identity says "the time map
 * changed" several times a minute when nothing has. Anything that must react to
 * a *real* edit — clearing stale ghosts, most of all — keys off this instead.
 */
export function keyOfWindows(windows: AvailabilityWindow[]): string {
  return (windows ?? [])
    .map((w) =>
      [w.name, w.days.join('.'), w.startMin, w.endMin, w.minBlockMin].join('|'),
    )
    .join(';');
}

export function parseSkeletonDoc(text: string): SkeletonDoc {
  const raw = parseYaml(text) as RawDoc | null;
  return {
    blocks: parseBlocks(raw),
    durations: parseDurations(raw?.durations),
    windows: parseWindows(raw?.windows),
    timezone: typeof raw?.timezone === 'string' ? raw.timezone : undefined,
    taskFolders: parseTaskFolders(raw?.task_folders),
  };
}

/** Prefer the editable copy in userData (Electron); fall back to the bundled file. */
export async function loadSkeleton(url: string): Promise<SkeletonDoc> {
  const fromStore = await readSkeletonYaml();
  if (fromStore != null) return parseSkeletonDoc(fromStore);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`skeleton ${res.status}`);
  return parseSkeletonDoc(await res.text());
}

/** Serialise the doc back to the on-disk YAML shape. */
export function stringifySkeleton(doc: SkeletonDoc): string {
  // Always written back in plain minutes (`90m`), which is what
  // parseDurationValue reads — `1h 30m` would look nicer and round-trip wrong.
  const durations: Record<string, string> = {
    [DEFAULT_KEY]: `${doc.durations.defaultMinutes}m`,
  };
  for (const [kind, minutes] of Object.entries(doc.durations.byKind)) {
    durations[kind] = `${minutes}m`;
  }
  const out: Record<string, unknown> = {};
  // Unused by the parser, but it's the user's line and a save must not eat it.
  if (doc.timezone) out.timezone = doc.timezone;
  out.blocks = doc.blocks.map((b) => {
    const block: Record<string, unknown> = {
      name: b.name,
      kind: b.kind,
      days: b.days.slice().sort((a, z) => a - z).map((n) => DAYS[n]),
      start: fromMinutes(b.startMin),
      end: fromMinutes(b.endMin),
    };
    if (b.note) block.note = b.note;
    if (b.leadMin != null) block.lead = b.leadMin;
    return block;
  });
  out.durations = durations;
  out.windows = (doc.windows ?? []).map((w) => ({
    name: w.name,
    days: w.days.slice().sort((a, z) => a - z).map((n) => DAYS[n]),
    start: fromMinutes(w.startMin),
    end: fromMinutes(w.endMin),
    // Bare 0 rather than "0m": `0m` fails the estimate grammar's sanity floor
    // on the way back in, and would round-trip to the default instead.
    min_block: w.minBlockMin > 0 ? `${w.minBlockMin}m` : 0,
  }));
  // Phase 5 §3 — written whenever the doc has an opinion, *including* an empty
  // list. An empty `task_folders: []` is how the editor says "the whole vault"
  // and takes the setting over from WD_TASK_FOLDERS; dropping the key would
  // hand it back to the environment on every save.
  if (doc.taskFolders) out.task_folders = doc.taskFolders;
  return stringifyYaml(out);
}

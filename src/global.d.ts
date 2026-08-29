// Ambient type support for src/lib/shell.ts, which is ported verbatim from
// week-dashboard and reads `window.wd` — the Electron preload bridge.
//
// week-dashboard declares this interface (`WdBridge` + the `Window.wd`
// augmentation) in its own src/vite-env.d.ts, which lives outside src/lib and
// so was not part of this port. Without it, `tsc --noEmit` fails on
// shell.ts — first with "Property 'wd' does not exist on type 'Window'",
// and (if `wd` is typed loosely as `any` instead) a second error deeper in
// the file: `onCalendarChange`'s callback parameter loses the contextual type
// it gets from the real interface and trips noImplicitAny under strict mode.
//
// So this reproduces the interface verbatim from week-dashboard/src/vite-env.d.ts
// (module reference-comment and the `__WD_MODE__` field included for fidelity
// even though nothing here reads it) rather than approximating it. Every wd?.
// call in shell.ts is still a safe no-op outside Electron (i.e. always, inside
// Obsidian) — this file only restores the types tsc needs to check that code,
// it doesn't make any of it live. No file in src/lib was changed to make this
// work. Phase 1 is expected to replace shell.ts's role with real Obsidian file
// I/O, at which point this file goes away with it.
export {};

interface WdBridge {
  isElectron: boolean;
  hidePlanner: () => void;
  quit: () => void;
  resizeHud: (height: number) => void;
  /** debug: fires on Ctrl+Alt+Shift+H; returns an unsubscribe fn */
  onHudDebugCycle: (cb: () => void) => () => void;
  readWeek: (weekId: string) => Promise<unknown>;
  toggleTask: (ref: { file: string; line: number; done: boolean }) => Promise<boolean>;
  ensureTaskId: (ref: { file: string; line: number; id: string }) => Promise<{
    ok: boolean;
    id?: string;
    created?: boolean;
    error?: string;
  }>;
  noteReplan: (ref: { weekId: string; title: string }) => Promise<{
    ok: boolean;
    count?: number;
    title?: string;
    error?: string;
  }>;
  setSchedule: (ref: {
    file: string;
    line: number;
    range: string | null;
    title?: string | null;
  }) => Promise<{ ok: boolean; stale?: boolean; error?: string }>;
  openNote: (uri: string) => Promise<{ ok: boolean; error?: string }>;
  readBacklog: () => Promise<{
    ok: boolean;
    file?: string;
    items?: Array<{ text: string; done: boolean; file: string; line: number }>;
    error?: string;
  }>;
  appendBacklog: (text: string) => Promise<{ ok: boolean; error?: string }>;
  moveToWeek: (ref: { line: number; text?: string | null; weekId: string }) => Promise<{
    ok: boolean;
    stale?: boolean;
    error?: string;
  }>;
  hideCapture: () => Promise<boolean>;
  focusGet: () => Promise<{
    uid: string;
    title: string;
    start: string;
    end: string;
  } | null>;
  focusStart: (session: {
    uid: string;
    title: string;
    start: string;
    end: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  focusEnd: () => Promise<{ ok: boolean }>;
  onFocusChange: (
    cb: (session: { uid: string; title: string; start: string; end: string } | null) => void,
  ) => () => void;
  calOutcome: (ref: { id: string; outcome: string }) => Promise<{
    ok: boolean;
    needsAuth?: boolean;
    error?: string;
  }>;
  hudImminent: (key: string) => Promise<{ ok: boolean; shown?: boolean }>;
  readAudit: (weekId: string) => Promise<{
    ok: boolean;
    weekId?: string;
    rows?: Array<{ label: string; plannedMin: number; keptMin: number }>;
    error?: string;
  }>;
  rollWeek: (
    weekId: string,
    opts?: {
      audit?: string[];
      streaks?: Array<{ name: string; kept: number; slots: number }>;
    },
  ) => Promise<{
    ok: boolean;
    rolled?: number;
    nextId?: string;
    nextCreated?: boolean;
    flagged?: Array<{ title: string; count: number }>;
    audited?: number;
    error?: string;
  }>;
  createWeek: (
    weekId: string,
  ) => Promise<{ ok: boolean; created?: boolean; notePath?: string; error?: string }>;
  onVaultChange: (cb: () => void) => () => void;
  skeletonRead: () => Promise<{ ok: true; yaml: string } | { ok: false; error?: string }>;
  skeletonWrite: (yaml: string) => Promise<{ ok: boolean; error?: string }>;
  openSkeletonEditor: () => void;
  onSkeletonChange: (cb: () => void) => () => void;
  googleStatus: () => Promise<{ configured: boolean; connected: boolean; email: string | null }>;
  connectGoogle: () => Promise<{ ok: boolean; error?: string; connected?: boolean; email?: string | null }>;
  disconnectGoogle: () => Promise<{ ok: boolean }>;
  calList: (range: { timeMin: string; timeMax: string }) => Promise<
    | { ok: true; events: Array<Record<string, unknown>>; sync?: Record<string, unknown> }
    | { ok: false; needsAuth?: boolean; error?: string }
  >;
  calStatus: () => Promise<Record<string, unknown> | null>;
  calInsert: (ev: {
    summary: string;
    start: string;
    end: string;
    props?: { taskId?: string; session?: number; sessions?: number; source?: string };
  }) => Promise<
    | { ok: true; event: Record<string, unknown> }
    | { ok: false; needsAuth?: boolean; error?: string }
  >;
  calPatch: (patch: { id: string; start: string; end: string }) => Promise<
    | { ok: true; event: Record<string, unknown> }
    | { ok: false; needsAuth?: boolean; error?: string }
  >;
  calDelete: (
    id: string,
  ) => Promise<{ ok: true } | { ok: false; needsAuth?: boolean; error?: string }>;
  onGoogleChange: (cb: () => void) => () => void;
  onCalendarChange: (cb: (sync: Record<string, unknown>) => void) => () => void;
}

declare global {
  interface Window {
    // kept in sync with Mode in src/lib/types.ts
    __WD_MODE__?: 'planner' | 'ambient' | 'hud' | 'capture';
    wd?: WdBridge;
  }
}

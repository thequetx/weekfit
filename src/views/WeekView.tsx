import { ItemView, WorkspaceLeaf } from 'obsidian';
import { createRoot, Root } from 'react-dom/client';
import { WeekViewRoot } from './WeekViewRoot';
import { DEFAULT_SETTINGS } from '../data/contract';
import type {
  FitState,
  WeekSnapshot,
  WeekfitSettings,
  WriteResult,
} from '../data/contract';
import type { CalEvent } from '../lib/types';
import { startOfISOWeek } from '../lib/week';

export const VIEW_TYPE_WEEK = 'weekfit-week-view';

/** Everything `WeekViewRoot` needs. Held here so the plugin can hand over
 *  only what changed (a new snapshot on a vault refresh, a settings save, a
 *  clock tick for the now-line) without re-supplying the rest. */
export interface WeekViewState {
  snapshot: WeekSnapshot | null;
  settings: WeekfitSettings;
  now: Date;
  // --- Phase 2C: week navigation -------------------------------------------
  weekStart: Date;
  isCurrentWeek: boolean;
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onToday: () => void;
  fit: FitState | null;
  fitting: boolean;
  lastWrite: WriteResult | null;
  onRefresh: () => void;
  onFit: () => void;
  onClearFit: () => void;
  onAccept: (groupKey: string) => void;
  onAcceptAll: () => void;
  onDismiss: (groupKey: string) => void;
  onMoveProposal: (groupKey: string, day: number, startMin: number) => void;
  onToggleGaps: () => void;
  onCreateWeekNote: () => void;
  onReplan: () => void;
  onReview: () => void;
  onOpenTask: (file: string, line: number) => void;
  onToggleDone: (file: string, line: number, text: string, done: boolean) => void;
  onScheduleTask: (file: string, line: number, text: string, day: number, startMin: number) => void;
  onTaskMenu: (file: string, line: number, text: string, x: number, y: number) => void;
  onSetDue: (file: string, line: number, text: string, x: number, y: number) => void;
  onSetPriority: (file: string, line: number, text: string, x: number, y: number) => void;
  onSetEstimate: (file: string, line: number, text: string, x: number, y: number) => void;
  onSplitBlock: (uid: string, x: number, y: number) => void;
  // --- Phase 2C: manipulating a block already on the grid ------------------
  onMoveBlock: (uid: string, day: number, startMin: number) => void;
  onUnschedule: (uid: string) => void;
  onOpenSource: (uid: string) => void;
  onResizeBlock: (uid: string, startMin: number, endMin: number) => void;
  onResizeProposal: (groupKey: string, startMin: number, endMin: number) => void;
  // --- Read-only calendar-feed events ---------------------------------------
  onDropIcsToRail: (ev: CalEvent) => void;
}

const noop = () => {};

const INITIAL_STATE: WeekViewState = {
  snapshot: null,
  settings: DEFAULT_SETTINGS,
  now: new Date(),
  // Sensible defaults for a view that hasn't been handed real navigation
  // state yet — "the current week" and every nav control a no-op, same
  // "nothing has happened yet" spirit as `fit: null` below. The plugin
  // overwrites these on the first `setWeekState` call.
  weekStart: startOfISOWeek(new Date()),
  isCurrentWeek: true,
  onPrevWeek: noop,
  onNextWeek: noop,
  onToday: noop,
  fit: null,
  fitting: false,
  lastWrite: null,
  onRefresh: noop,
  onFit: noop,
  onClearFit: noop,
  onAccept: noop,
  onAcceptAll: noop,
  onDismiss: noop,
  onMoveProposal: noop,
  onToggleGaps: noop,
  onCreateWeekNote: noop,
  onReplan: noop,
  onReview: noop,
  onOpenTask: noop,
  onToggleDone: noop,
  onScheduleTask: noop,
  onTaskMenu: noop,
  onSetDue: noop,
  onSetPriority: noop,
  onSetEstimate: noop,
  onSplitBlock: noop,
  onMoveBlock: noop,
  onUnschedule: noop,
  onOpenSource: noop,
  onResizeBlock: noop,
  onResizeProposal: noop,
  onDropIcsToRail: noop,
};

/**
 * Thin `ItemView` shell: mounts the React tree on open, unmounts on close,
 * and re-renders it whenever `setWeekState` hands it new data. All the real
 * logic lives in `WeekViewRoot`, which takes plain props and no Obsidian
 * imports, so it stays testable without an Obsidian runtime.
 *
 * Named `setWeekState` rather than `setState` on purpose: `ItemView` already
 * has a `setState`/`getState` pair in Obsidian's own API, used for restoring
 * per-leaf state across app restarts. Reusing that name for a different
 * shape and calling convention would collide with that lifecycle rather than
 * extend it, so this is a distinct method the plugin calls explicitly
 * instead.
 */
export class WeekView extends ItemView {
  private root: Root | null = null;
  private state: WeekViewState = INITIAL_STATE;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_WEEK;
  }

  getDisplayText(): string {
    return 'Weekfit';
  }

  getIcon(): string {
    return 'calendar-range';
  }

  async onOpen(): Promise<void> {
    this.root = createRoot(this.contentEl);
    this.render();
  }

  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
  }

  /** The plugin's one entry point for handing this view fresh data. Partial,
   *  so a clock tick can update just `now` without re-supplying the rest. */
  setWeekState(next: Partial<WeekViewState>): void {
    this.state = { ...this.state, ...next };
    this.render();
  }

  private render(): void {
    this.root?.render(<WeekViewRoot {...this.state} />);
  }
}

import { ItemView, WorkspaceLeaf } from 'obsidian';
import { createRoot, Root } from 'react-dom/client';
import { BacklogRoot } from './BacklogRoot';
import type { BacklogItem } from '../data/backlog';

export const VIEW_TYPE_BACKLOG = 'weekfit-backlog-view';

/** Everything `BacklogRoot` needs. Held here, same reason `WeekViewState`
 *  is held on `WeekView`: the plugin hands over only what changed (a fresh
 *  sweep of the configured folders) without re-supplying the rest. */
export interface BacklogViewState {
  items: BacklogItem[];
  onOpenSource: (file: string, line: number) => void;
}

const noop = () => {};

const INITIAL_STATE: BacklogViewState = {
  items: [],
  onOpenSource: noop,
};

/**
 * Thin `ItemView` shell: mounts the React tree on open, unmounts on close,
 * and re-renders it whenever `setBacklogState` hands it new data. Mirrors
 * `WeekView.tsx` deliberately — same shape, same lifecycle, same reason: all
 * the real logic lives in `BacklogRoot`, which takes plain props and no
 * Obsidian imports, so it stays testable without an Obsidian runtime.
 */
export class BacklogView extends ItemView {
  private root: Root | null = null;
  private state: BacklogViewState = INITIAL_STATE;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_BACKLOG;
  }

  getDisplayText(): string {
    return 'Weekfit backlog';
  }

  getIcon(): string {
    return 'list-todo';
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
   *  so (for instance) a new `onOpenSource` closure can land without
   *  re-supplying `items`. */
  setBacklogState(next: Partial<BacklogViewState>): void {
    this.state = { ...this.state, ...next };
    this.render();
  }

  private render(): void {
    this.root?.render(<BacklogRoot {...this.state} />);
  }
}

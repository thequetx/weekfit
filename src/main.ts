import { Menu, Notice, Plugin, TFile } from 'obsidian';
import { VIEW_TYPE_WEEK, WeekView } from './views/WeekView';
import { VIEW_TYPE_BACKLOG, BacklogView } from './views/BacklogView';
import { CaptureModal } from './views/CaptureModal';
import { VaultRepo, notePathFor } from './data/vaultRepo';
import { resolveNoteLocations } from './data/periodicNotes';
import { computeFit, computeReplan } from './data/planner';
import { collectBacklog } from './data/backlog';
import { computeReview, rollForward, writeReview } from './data/review';
import { ReviewModal } from './views/ReviewModal';
import { weeklyNoteTemplate } from './data/template';
import { beginJournal, endJournal } from './data/journal';
import { UndoStack } from './data/undo';
import { maxSittingsFor, planSplit, planSplitAuto } from './data/split';
import type { SplitPlan, SplitTarget } from './data/split';
import {
  acceptProposals,
  appendUnderHeading,
  createNote,
  editPlacements,
  isoDateFor,
  setTaskDone,
  setTaskFields,
} from './data/writer';
import { SettingsTab } from './settings/SettingsTab';
import { DEFAULT_SETTINGS } from './data/contract';
import type {
  FitState,
  PlacementEdit,
  WeekSnapshot,
  WeekfitSettings,
  WriteResult,
} from './data/contract';
import type { Proposal } from './lib/gaps';
import { dayPlannerRange } from './lib/source';
import { fmtDue, parseTaskMeta, PRIORITIES, taskTitle } from './lib/taskmeta';
import type { PriorityName } from './lib/taskmeta';
import { PRIORITY_GLYPH } from './components/priority';
import { DURATION_CHOICES, dueChoices } from './data/dates';
import { DueDateModal } from './views/DueDateModal';
import { fmtEstimate, resolveTaskDuration, snapToGrid } from './lib/duration';
import { addDays, addWeeks, dayIndex, minutesOfDay, startOfISOWeek } from './lib/week';

/** How often the now-line moves. A minute is the resolution it's drawn at, so
 *  anything finer is repaint for nothing. */
const CLOCK_MS = 60_000;

export default class WeekfitPlugin extends Plugin {
  settings: WeekfitSettings = DEFAULT_SETTINGS;
  private repo!: VaultRepo;

  private snapshot: WeekSnapshot | null = null;
  private fit: FitState | null = null;
  private fitting = false;
  private lastWrite: WriteResult | null = null;
  /**
   * Groups the user has waved away this round.
   *
   * Any write triggers a refresh, and a refresh recomputes the fit — which
   * regenerates every proposal, including ones already dismissed. Accepting one
   * ghost therefore brought back all the ghosts you had just cleared. Dismissal
   * has to outlive the recompute; it is cleared when a *new* fit, replan or
   * split is asked for, which is the point at which the question is genuinely
   * being asked again.
   */
  private dismissed = new Set<string>();
  /** Session-only lifeline — see src/data/undo.ts for why it is not persisted. */
  private undoStack = new UndoStack();

  /** Monday of the week being shown. Not necessarily the current one — the
   *  main reason to open a planner is to plan the week that hasn't happened
   *  yet, so this is state, not a derived value. */
  private weekStart: Date = startOfISOWeek(new Date());

  /** Guards overlapping reads: a burst of vault events can otherwise land two
   *  `readWeek`s out of order and paint the older one last. */
  private reading = false;
  private readAgain = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    // A getter, not a value, so the repo always sees live settings — a change
    // takes effect on the next read with nothing to re-wire.
    this.repo = new VaultRepo(this.app, () => this.settings);

    this.registerView(VIEW_TYPE_WEEK, (leaf) => new WeekView(leaf));
    this.registerView(VIEW_TYPE_BACKLOG, (leaf) => new BacklogView(leaf));
    this.addSettingTab(new SettingsTab(this.app, this));

    this.addCommand({
      id: 'open-week-view',
      name: 'Open week view',
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: 'fit-this-week',
      name: 'Fit this week',
      callback: () => void this.runFit(),
    });
    this.addCommand({
      id: 'toggle-gaps',
      name: 'Toggle gap candidates',
      callback: () => void this.toggleGaps(),
    });
    this.addCommand({
      id: 'refresh-week',
      name: 'Refresh week',
      callback: () => void this.refresh(),
    });
    this.addCommand({
      id: 'previous-week',
      name: 'Previous week',
      callback: () => void this.goToWeek(addWeeks(this.weekStart, -1)),
    });
    this.addCommand({
      id: 'next-week',
      name: 'Next week',
      callback: () => void this.goToWeek(addWeeks(this.weekStart, 1)),
    });
    this.addCommand({
      id: 'this-week',
      name: 'Go to this week',
      callback: () => void this.goToWeek(new Date()),
    });
    this.addCommand({
      id: 'replan-passed',
      name: 'Replan what has passed',
      callback: () => void this.runReplan(),
    });
    this.addCommand({
      id: 'capture-task',
      name: 'Capture a task',
      callback: () => this.openCapture(),
    });
    this.addCommand({
      id: 'open-backlog',
      name: 'Open backlog',
      callback: () => void this.activateBacklog(),
    });
    this.addCommand({
      id: 'weekly-review',
      name: 'Review this week',
      callback: () => void this.openReview(),
    });
    this.addCommand({
      id: 'undo-last',
      name: 'Undo last Weekfit change',
      callback: () => void this.undoLast(),
    });
    this.addCommand({
      id: 'create-week-note',
      name: "Create this week's note",
      callback: () => void this.createWeekNote(),
    });

    this.addRibbonIcon('calendar-range', 'Open week view', () => void this.activateView());

    // The entire file-watcher subsystem, in one line. The desktop app spent
    // ~600 lines of Electron on this and four of its nineteen bugs came from
    // it; `register` hands teardown back to the plugin lifecycle.
    this.register(this.repo.onChange(() => void this.refresh()));

    this.registerInterval(window.setInterval(() => this.push({ now: new Date() }), CLOCK_MS));

    // The metadata cache isn't populated until layout is ready; reading before
    // that gives an empty week on a cold start.
    this.app.workspace.onLayoutReady(() => void this.refresh());
  }

  onunload(): void {
    // Deliberately not detaching leaves — Obsidian's current guidance. A
    // disabled or updated plugin shouldn't yank the user's panes out from
    // under them; Obsidian re-associates the view on reload.
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    await this.refresh();
  }

  // -------------------------------------------------------------------------
  // reading
  // -------------------------------------------------------------------------

  async refresh(): Promise<void> {
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.readAgain = false;
        this.snapshot = await this.repo.readWeek(this.weekStart);
      } while (this.readAgain);
    } finally {
      this.reading = false;
    }

    // Ghosts were computed against a week that has now changed underneath
    // them, so a stale proposal could point at a line that has moved.
    // Recompute rather than redraw: the alternative is offering a placement we
    // can no longer honour, which the writer would refuse later anyway.
    // A pending split is not a fit result and must not be recomputed as one:
    // `computeFit` would replace its sittings with an ordinary proposal set
    // and the block being split would reappear underneath. The ghosts stand
    // until they are accepted or cleared — and the writer re-verifies every
    // line before touching it, so a stale one is refused rather than misapplied.
    if (this.fit && this.snapshot && this.fit.replacing == null) {
      const recomputed = computeFit(this.snapshot, this.settings, new Date());
      this.fit = {
        ...recomputed,
        proposals: recomputed.proposals.filter((p) => !this.dismissed.has(p.groupKey)),
      };
    }

    this.pushAll();
    // Only sweeps if a backlog pane is actually open — see `refreshBacklog`.
    await this.refreshBacklog();
  }

  // -------------------------------------------------------------------------
  // fitting — still only proposals; nothing here writes
  // -------------------------------------------------------------------------

  private async runFit(): Promise<void> {
    if (!this.snapshot) await this.refresh();
    if (!this.snapshot) return;

    if (!this.settings.windows.length) {
      new Notice(
        'Weekfit: no availability windows set, so there is nowhere to fit anything. Add one in Settings.',
      );
      return;
    }

    this.dismissed.clear();
    this.fitting = true;
    this.pushAll();
    try {
      this.fit = computeFit(this.snapshot, this.settings, new Date());
    } finally {
      this.fitting = false;
    }
    // Same as replan: an empty result is not something to leave sitting on the
    // board with controls attached. A week with everything already scheduled
    // is the common way to reach this.
    if (this.fit && this.fit.proposals.length === 0 && this.fit.unplaced.length === 0) {
      this.fit = null;
      new Notice('Weekfit: nothing left to fit — everything is either scheduled or done.');
    }
    this.pushAll();
  }

  private clearFit(): void {
    this.dismissed.clear();
    this.fit = null;
    this.lastWrite = null;
    this.pushAll();
  }

  private dismiss(groupKey: string): void {
    this.dismissed.add(groupKey);
    if (!this.fit) return;
    this.fit = {
      ...this.fit,
      proposals: this.fit.proposals.filter((p) => p.groupKey !== groupKey),
    };
    this.pushAll();
  }

  /** A dragged ghost, re-timed but still a ghost. The view has already asked
   *  `snapToGap` whether the destination is legal; this only records it. */
  private moveProposal(key: string, day: number, startMin: number): void {
    if (!this.fit) return;
    // Keyed on the **individual** proposal, not its group. Matching on
    // groupKey moved every sitting of a split task to the same slot at once —
    // they stacked exactly on top of each other and read as a single ghost.
    // Accept and dismiss are group-shaped; moving and resizing are not.
    this.fit = {
      ...this.fit,
      proposals: this.fit.proposals.map((p) =>
        p.key === key ? { ...p, day, startMin, endMin: startMin + (p.endMin - p.startMin) } : p,
      ),
    };
    this.pushAll();
  }

  // -------------------------------------------------------------------------
  // accepting — the only path that writes
  // -------------------------------------------------------------------------

  private async accept(groupKeys: string[]): Promise<void> {
    if (!this.fit || !this.snapshot) return;
    const keys = new Set(groupKeys);
    const chosen: Proposal[] = this.fit.proposals.filter((p) => keys.has(p.groupKey));
    if (!chosen.length) return;

    const weekStart = this.snapshot.weekStart;
    const locations = resolveNoteLocations(this.app, this.settings);

    beginJournal();
    const result = await acceptProposals(this.app, chosen, {
      weekStart,
      // A line living in the daily note for its own day needs no scheduled
      // date — the filename already says which day it is, which is Day
      // Planner's native convention. A line in a weekly note does need one.
      isDailyNoteFor: (path, day) =>
        path ===
        notePathFor(addDays(weekStart, day), locations.daily.folder, locations.daily.format),
    });

    this.undoStack.push(
      chosen.length === 1 ? 'Accept a placement' : `Accept ${chosen.length} placements`,
      endJournal(),
    );
    this.lastWrite = result;

    // Accepted ghosts stop being ghosts. Dropping only what was actually
    // written keeps a refused group on screen with its reason attached,
    // rather than vanishing as though it had worked.
    const refused = new Set(result.skipped.map((s) => s.key));
    const remaining = this.fit.proposals.filter(
      (p) => !keys.has(p.groupKey) || refused.has(p.groupKey),
    );
    // Nothing left to decide on — drop the whole result, which also stops
    // hiding the block a split was replacing. Leaving `replacing` set with no
    // ghosts would blank a block that is now perfectly real.
    this.fit = remaining.length === 0 ? null : { ...this.fit, proposals: remaining };

    if (result.errors.length) {
      new Notice(`Weekfit: ${result.errors.length} file(s) could not be written — see the view.`);
    }

    // The write fires `vault.on('modify')` anyway, but refreshing directly
    // means the view doesn't sit stale for the debounce interval.
    await this.refresh();
  }

  private async toggleGaps(): Promise<void> {
    this.settings.showGaps = !this.settings.showGaps;
    await this.saveSettings();
  }

  // -------------------------------------------------------------------------
  // replan — the feature that makes this useful on a Wednesday
  // -------------------------------------------------------------------------

  /** Blocks whose time passed without being ticked, re-fitted into what's left
   *  of the week. Produces the same ghosts "Fit this week" does, so accepting
   *  one goes through the identical verified write path. */
  private async runReplan(): Promise<void> {
    if (!this.snapshot) await this.refresh();
    if (!this.snapshot) return;
    if (!this.settings.windows.length) {
      new Notice('Weekfit: no availability windows set, so there is nowhere to replan into.');
      return;
    }
    this.dismissed.clear();
    this.fitting = true;
    this.pushAll();
    try {
      this.fit = computeReplan(this.snapshot, this.settings, new Date());
    } finally {
      this.fitting = false;
    }
    // A result with nothing in it is not a result worth leaving on the board.
    // The Notice has already said what happened; keeping a non-null `fit`
    // around would light up "Accept all" and "Clear ghosts" over an empty
    // week, inviting the user to act on nothing.
    if (this.fit && this.fit.proposals.length === 0 && this.fit.unplaced.length === 0) {
      this.fit = null;
      new Notice('Weekfit: nothing has passed unfinished — nothing to replan.');
    }
    this.pushAll();
  }

  // -------------------------------------------------------------------------
  // capture, backlog, review
  // -------------------------------------------------------------------------

  /** The current week's note path, whether or not the file exists — capture
   *  and review both need somewhere to aim before it does. */
  private weekNotePath(): string {
    const locations = resolveNoteLocations(this.app, this.settings);
    return notePathFor(this.weekStart, locations.weekly.folder, locations.weekly.format);
  }

  private openCapture(): void {
    new CaptureModal(this.app, {
      getTargetPath: () => this.weekNotePath(),
      write: async (path, line) => {
        beginJournal();
        try {
          return await appendUnderHeading(this.app, [
            { file: path, heading: 'Tasks', lines: [line] },
          ]);
        } finally {
          this.undoStack.push('Capture a task', endJournal());
        }
      },
    }).open();
  }

  private async activateBacklog(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_BACKLOG)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_BACKLOG, active: true });
    }
    workspace.revealLeaf(leaf);
    await this.refreshBacklog();
  }

  private async refreshBacklog(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_BACKLOG);
    if (!leaves.length) return; // nothing open — don't sweep the vault for nobody

    const { tasks, unscoped, truncated, errors } = await this.repo.readBacklog();
    if (unscoped) {
      new Notice(
        'Weekfit: set "Folders to scan" in settings to use the backlog — otherwise it would list every checkbox in your vault.',
      );
    }
    if (truncated) new Notice('Weekfit: backlog is showing the first 300 tasks found.');
    // One line, not one per file: a vault with a folder full of unreadable
    // notes would otherwise bury the user in Notices. Silence would be worse
    // — a backlog quietly missing entries looks like the sweep working.
    if (errors.length) {
      new Notice(`Weekfit: ${errors.length} file(s) could not be read for the backlog.`);
    }

    const items = collectBacklog(tasks, this.settings, this.snapshot?.scheduledLines ?? []);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof BacklogView) {
        view.setBacklogState({
          items,
          onOpenSource: (file: string, line: number) => void this.openLine(file, line),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // acting on an unscheduled task without leaving the pane
  // -------------------------------------------------------------------------

  private async toggleDone(
    file: string,
    line: number,
    text: string,
    done: boolean,
  ): Promise<void> {
    await this.applyWrite(done ? 'Mark done' : 'Mark not done', () =>
      setTaskDone(this.app, [{ file, line, expectedText: text, title: taskTitle(text), done }]),
    );
  }

  // -------------------------------------------------------------------------
  // Editing the three fields the rail already displays
  //
  // Each menu opens from the chip showing the value, so the control sits where
  // the information is. All three land in `setTaskFields`, which is
  // `rewriteVerifiedLines` plus a transform — so they inherit the refusal on a
  // line that moved, and `applyWrite` journals them, so undo covers them free.
  // -------------------------------------------------------------------------

  private async setField(
    label: string,
    file: string,
    line: number,
    text: string,
    fields: { due?: string | null; priority?: PriorityName; estimate?: number | null },
  ): Promise<void> {
    await this.applyWrite(label, () =>
      setTaskFields(this.app, [
        { file, line, expectedText: text, title: taskTitle(text), ...fields },
      ]),
    );
  }

  private dueMenu(file: string, line: number, text: string, x: number, y: number): void {
    const current = parseTaskMeta(text).dates.due?.date ?? null;
    const menu = new Menu();

    for (const choice of dueChoices(new Date())) {
      menu.addItem((i) =>
        i
          .setTitle(`${choice.label} — ${fmtDue(choice.date)}`)
          // Ticked when it is the date already on the line, so the menu says
          // what the value *is* rather than only offering to replace it.
          .setChecked(choice.date === current)
          .onClick(() => void this.setField('Set due date', file, line, text, { due: choice.date })),
      );
    }

    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle('Pick a date…')
        .setIcon('calendar')
        .onClick(() => {
          new DueDateModal(this.app, {
            title: taskTitle(text),
            current,
            onPick: (date) => void this.setField('Set due date', file, line, text, { due: date }),
          }).open();
        }),
    );

    if (current) {
      menu.addItem((i) =>
        i
          .setTitle('Clear due date')
          .setIcon('x')
          .onClick(() => void this.setField('Clear due date', file, line, text, { due: null })),
      );
    }

    menu.showAtPosition({ x, y });
  }

  private priorityMenu(file: string, line: number, text: string, x: number, y: number): void {
    const current = parseTaskMeta(text).priority?.level ?? 'none';
    const menu = new Menu();

    // Most urgent first, with `none` in the middle where the plugin's own
    // ranking puts it — an unmarked task is not the least urgent one.
    for (const level of PRIORITIES) {
      menu.addItem((i) =>
        i
          .setTitle(level === 'none' ? 'None' : `${PRIORITY_GLYPH[level]}  ${level}`)
          .setChecked(level === current)
          .onClick(() => void this.setField('Set priority', file, line, text, { priority: level })),
      );
    }

    menu.showAtPosition({ x, y });
  }

  private estimateMenu(file: string, line: number, text: string, x: number, y: number): void {
    // What the *line* says, not what the ladder resolved to — clearing is only
    // offered when there is something written to clear, and a `#tag` default
    // is not something this menu put there.
    const written = parseTaskMeta(text).fields['wd:est']?.minutes ?? null;
    const menu = new Menu();

    for (const minutes of DURATION_CHOICES) {
      menu.addItem((i) =>
        i
          .setTitle(fmtEstimate(minutes))
          .setChecked(minutes === written)
          .onClick(() => void this.setField('Set duration', file, line, text, { estimate: minutes })),
      );
    }

    if (written != null) {
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle('Clear — fall back to the #tag default')
          .setIcon('x')
          .onClick(() => void this.setField('Clear duration', file, line, text, { estimate: null })),
      );
    }

    menu.showAtPosition({ x, y });
  }

  /**
   * Place a rail task by hand. The same verified write accepting a proposal
   * uses — a hand-drop is a different way of choosing a slot, not a different
   * way of writing one.
   */
  private async scheduleTask(
    file: string,
    line: number,
    text: string,
    day: number,
    startMin: number,
  ): Promise<void> {
    const snap = this.snapshot;
    if (!snap) return;

    const minutes = snapToGrid(resolveTaskDuration(text, this.settings.durations).minutes);
    const locations = resolveNoteLocations(this.app, this.settings);
    const isDaily =
      file === notePathFor(addDays(snap.weekStart, day), locations.daily.folder, locations.daily.format);

    await this.applyEdits('Schedule a task', [
      {
        file,
        line,
        expectedText: text,
        range: dayPlannerRange(startMin, startMin + minutes),
        scheduledDate: isDaily ? null : isoDateFor(snap.weekStart, day),
        title: taskTitle(text),
      },
    ]);
  }

  /**
   * Offer to break a placed block into sittings.
   *
   * Fitting splits automatically when nothing else will do; this is the case
   * where it *does* fit and you'd still rather not do it in one go. The result
   * is ghosts, not a write — the same as every other proposal here.
   */
  private splitMenu(uid: string, x: number, y: number): void {
    const snap = this.snapshot;
    if (!snap) return;
    const i = snap.scheduled.findIndex((e) => e.uid === uid);
    const ev = snap.scheduled[i];
    const line = snap.scheduledLines[i];
    if (!ev || !line) return;

    // A sitting is already a piece of a task. Splitting one nests a level
    // deeper every time, and the tree it makes is both unreadable and enough
    // to break the parent-detection that decides what belongs in the rail —
    // observed in a real note as a three-deep nest with rangeless lines in it.
    // One level of sittings is the format; there is no second level.
    const above = snap.scheduledLines.find(
      (l) => l.file === line.file && l.line === line.line - 1,
    );
    const indent = (t: string) => (/^[ 	]*/.exec(t)?.[0].length ?? 0);
    const parentAbove = [...snap.tasks, ...snap.thisweek, ...snap.scheduledLines].find(
      (t) => t.file === line.file && t.line < line.line && indent(t.text) < indent(line.text),
    );
    if (indent(line.text) > 0 && (above != null || parentAbove != null)) {
      new Notice(
        'Weekfit: this is already one sitting of a task. Unschedule it, or split the task itself.',
      );
      return;
    }

    const target: SplitTarget = {
      uid,
      task: line,
      day: dayIndex(ev.start, snap.weekStart),
      startMin: minutesOfDay(ev.start),
      endMin: minutesOfDay(ev.end),
    };
    const max = maxSittingsFor(target.endMin - target.startMin);

    this.dismissed.clear();
    const apply = (plan: SplitPlan | null) => {
      if (!plan) {
        new Notice('Weekfit: this block is too short to split.');
        return;
      }
      // Real capacity for the week, not zeroes. A hand-rolled empty `Capacity`
      // renders as "no availability windows set" — false, and alarming, while
      // the user is only reconsidering one block. The gaps come with it, so a
      // split ghost snaps against the same lattice everything else does.
      const week = computeFit(snap, this.settings, new Date());
      this.fit = {
        gaps: week.gaps,
        proposals: plan.proposals,
        unplaced: plan.unplaced,
        capacity: week.capacity,
        replacing: plan.replacing,
      };
      if (plan.unplaced.length) {
        new Notice(`Weekfit: ${plan.unplaced.length} sitting(s) had nowhere to go.`);
      }
      this.pushAll();
    };

    const menu = new Menu();
    for (let n = 2; n <= max; n++) {
      menu.addItem((item) =>
        item.setTitle(`${n} sittings`).onClick(() => {
          apply(planSplit(snap, this.settings, new Date(), target, n));
        }),
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle('Fit — fewest that will fit')
        .setIcon('calendar-range')
        .onClick(() => {
          apply(planSplitAuto(snap, this.settings, new Date(), target));
        }),
    );
    menu.showAtPosition({ x, y });
  }

  private taskMenu(file: string, line: number, text: string, x: number, y: number): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle('Open in note')
        .setIcon('file-text')
        .onClick(() => void this.openLine(file, line)),
    );
    menu.addItem((i) =>
      i
        .setTitle('Mark done')
        .setIcon('check')
        .onClick(() => void this.toggleDone(file, line, text, true)),
    );
    menu.addSeparator();
    // The same three menus the rail's own chips open. Duplicated here because
    // right-click is where a lot of people look first, and a control that
    // exists only on a chip you have to notice is a control half the users
    // never find.
    //
    // Deferred a tick. Obsidian closes an open menu from a document-level
    // handler, and a second menu built synchronously inside the first one's
    // click is created while that same click is still propagating — so what
    // dismisses the outer menu can dismiss the inner one with it, and the
    // item reads as doing nothing. `setSubmenu` would be the proper answer;
    // it is not in the typings this builds against.
    const nested = (open: () => void) => window.setTimeout(open, 0);
    menu.addItem((i) =>
      i
        .setTitle('Due date…')
        .setIcon('calendar')
        .onClick(() => nested(() => this.dueMenu(file, line, text, x, y))),
    );
    menu.addItem((i) =>
      i
        .setTitle('Duration…')
        .setIcon('clock')
        .onClick(() => nested(() => this.estimateMenu(file, line, text, x, y))),
    );
    menu.addItem((i) =>
      i
        .setTitle('Priority…')
        .setIcon('signal')
        .onClick(() => nested(() => this.priorityMenu(file, line, text, x, y))),
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle('Fit this week')
        .setIcon('calendar-range')
        .onClick(() => void this.runFit()),
    );
    menu.showAtPosition({ x, y });
  }

  private async openReview(): Promise<void> {
    if (!this.snapshot) await this.refresh();
    const snapshot = this.snapshot;
    if (!snapshot) return;

    const review = computeReview(snapshot, this.settings, new Date());
    const locations = resolveNoteLocations(this.app, this.settings);
    const nextWeekPath = notePathFor(
      addWeeks(this.weekStart, 1),
      locations.weekly.folder,
      locations.weekly.format,
    );

    new ReviewModal(this.app, {
      review,
      nextWeekPath,
      onWriteReview: async () => {
        beginJournal();
        const r = await writeReview(this.app, snapshot, review, this.settings);
        this.undoStack.push('Write the weekly review', endJournal());
        await this.refresh();
        return r;
      },
      onRollForward: async () => {
        // Seed next week's note first if it doesn't exist. `appendUnderHeading`
        // will happily create a file containing nothing but `## Tasks`, which
        // is not a weekly note: no frontmatter for the year-of-weeks table, no
        // `## Intentions`, and no `## Review` for the review flow to write into
        // when that week ends. Rolling work into a malformed note is a quiet
        // way to break the week you're rolling into.
        beginJournal();
        if (!this.app.vault.getAbstractFileByPath(nextWeekPath)) {
          await createNote(
            this.app,
            nextWeekPath,
            weeklyNoteTemplate(addWeeks(this.weekStart, 1), { withExamples: false }),
          );
        }
        const r = await rollForward(this.app, snapshot, review, nextWeekPath, this.settings);
        this.undoStack.push(
          `Roll ${review.unfinished.length} task(s) forward`,
          endJournal(),
        );
        await this.refresh();
        return r;
      },
    }).open();
  }

  /**
   * Seed the week's note. The actual day-one wall: a vault that has never heard
   * of this plugin has no weekly note, so the view opens empty and expects the
   * user to build a three-heading structure by hand before anything works.
   */
  private async createWeekNote(): Promise<void> {
    const path = this.weekNotePath();
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice(`Weekfit: ${path} already exists.`);
      await this.openLine(path, 0);
      return;
    }
    beginJournal();
    const result = await createNote(this.app, path, weeklyNoteTemplate(this.weekStart));
    this.undoStack.push("Create this week's note", endJournal());
    if (result.errors.length) {
      new Notice(`Weekfit: could not create ${path} — ${result.errors[0]}`);
      return;
    }
    new Notice(`Weekfit: created ${path}.`);
    await this.refresh();
    await this.openLine(path, 0);
  }

  private async openLine(file: string, line: number): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(file);
    if (!(f instanceof TFile)) {
      new Notice(`Weekfit: could not find ${file}`);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(f, { eState: { line } });
  }

  // -------------------------------------------------------------------------
  // navigation
  // -------------------------------------------------------------------------

  /** Ghosts belong to the week they were computed for. Carrying them across a
   *  week change would draw proposals against gaps that don't exist here, so
   *  navigating clears them rather than silently re-anchoring them. */
  private async goToWeek(weekStart: Date): Promise<void> {
    this.weekStart = startOfISOWeek(weekStart);
    this.fit = null;
    this.lastWrite = null;
    await this.refresh();
  }

  private isCurrentWeek(): boolean {
    return startOfISOWeek(new Date()).getTime() === this.weekStart.getTime();
  }

  // -------------------------------------------------------------------------
  // editing a block that's already on the grid
  // -------------------------------------------------------------------------

  /**
   * The line behind a block, from **this** snapshot.
   *
   * `scheduled[i]` came from `scheduledLines[i]`, and the writer refuses any
   * edit whose `expectedText` no longer matches the file. So the text has to
   * come from the snapshot the user is actually looking at — reusing a stale
   * one would get every edit refused as `line-changed`, which would look
   * exactly like the feature being broken.
   */
  private lineFor(uid: string): { file: string; line: number; text: string; title: string } | null {
    const snap = this.snapshot;
    if (!snap) return null;
    const i = snap.scheduled.findIndex((e) => e.uid === uid);
    if (i < 0) return null;
    const task = snap.scheduledLines[i];
    if (!task) return null;
    return { file: task.file, line: task.line, text: task.text, title: snap.scheduled[i].title };
  }

  /** Run a write, record what happened, tell the user if a whole file failed,
   *  and re-read. Every write in this plugin ends the same way. */
  /**
   * Run a write, record what it did to the vault so it can be undone, tell the
   * user if a whole file failed, and re-read.
   *
   * Every write goes through here, which is the only reason a single undo step
   * can span the several files a roll-forward touches: the journal is opened
   * around the *action*, not around each file.
   */
  private async applyWrite(label: string, work: () => Promise<WriteResult>): Promise<void> {
    beginJournal();
    try {
      this.lastWrite = await work();
    } finally {
      this.undoStack.push(label, endJournal());
    }
    if (this.lastWrite.errors.length) {
      new Notice(
        `Weekfit: ${this.lastWrite.errors.length} file(s) could not be written — see the view.`,
      );
    }
    await this.refresh();
  }

  /** Put the last Weekfit change back. */
  private async undoLast(): Promise<void> {
    const pending = this.undoStack.peek();
    if (!pending) {
      new Notice('Weekfit: nothing to undo in this session.');
      return;
    }
    const result = await this.undoStack.undo(this.app);
    if (!result) return;

    const parts = [`Weekfit: undid "${result.label}"`];
    if (result.refused.length) {
      // Naming the files matters: the user has to know which half of the
      // change is still in place, and why it was left alone.
      parts.push(
        `${result.refused.length} file(s) left alone because they changed since: ${result.refused.join(', ')}`,
      );
    }
    if (result.errors.length) parts.push(`${result.errors.length} error(s)`);
    new Notice(parts.join(' — '));
    await this.refresh();
  }

  private async applyEdits(label: string, edits: PlacementEdit[]): Promise<void> {
    if (!edits.length) return;
    await this.applyWrite(label, () => editPlacements(this.app, edits));
  }

  private async moveBlock(uid: string, day: number, startMin: number): Promise<void> {
    const target = this.lineFor(uid);
    const snap = this.snapshot;
    if (!target || !snap) return;

    const ev = snap.scheduled.find((e) => e.uid === uid);
    if (!ev) return;
    const minutes = Math.max(1, Math.round((ev.end.getTime() - ev.start.getTime()) / 60_000));

    const locations = resolveNoteLocations(this.app, this.settings);
    const isDaily =
      target.file ===
      notePathFor(addDays(snap.weekStart, day), locations.daily.folder, locations.daily.format);

    await this.applyEdits('Move a block', [
      {
        file: target.file,
        line: target.line,
        expectedText: target.text,
        range: dayPlannerRange(startMin, startMin + minutes),
        // Moving to a different day has to move the date with it, or the block
        // would render back where it started on the next read.
        scheduledDate: isDaily ? null : isoDateFor(snap.weekStart, day),
        title: target.title,
      },
    ]);
  }

  /**
   * A block's **placement** got longer or shorter. Not its estimate.
   *
   * `~90m` says how big the job is; `09:00 - 10:30` says when it's happening
   * and for how long. `lib/source.ts` is explicit that these are different
   * facts that coexist on one line, so dragging an edge rewrites the range and
   * leaves the estimate alone. Silently rewriting someone's stated estimate
   * because they nudged a block edge is the more destructive reading of the
   * gesture, and the harder one to undo.
   */
  private async resizeBlock(uid: string, startMin: number, endMin: number): Promise<void> {
    const target = this.lineFor(uid);
    if (!target) return;
    await this.applyEdits('Resize a block', [
      {
        file: target.file,
        line: target.line,
        expectedText: target.text,
        range: dayPlannerRange(startMin, endMin),
        // The day hasn't changed, so the scheduled date shouldn't either —
        // and `null` means "leave whatever is there alone".
        scheduledDate: null,
        title: target.title,
      },
    ]);
  }

  /** A ghost resized before it's been accepted. Still a proposal, still
   *  nothing written — this only re-sizes the pending placement. */
  private resizeProposal(key: string, startMin: number, endMin: number): void {
    if (!this.fit) return;
    // Individual, for the same reason as `moveProposal`.
    this.fit = {
      ...this.fit,
      proposals: this.fit.proposals.map((p) =>
        p.key === key ? { ...p, startMin, endMin, minutes: Math.max(1, endMin - startMin) } : p,
      ),
    };
    this.pushAll();
  }

  private async unschedule(uid: string): Promise<void> {
    const target = this.lineFor(uid);
    if (!target) return;
    await this.applyEdits('Unschedule a block', [
      {
        file: target.file,
        line: target.line,
        expectedText: target.text,
        // Strips the range; the task goes back to the rail.
        range: null,
        // Never a date here. We only ever *add* a `⏳`, and the writer can't
        // tell one we wrote from one the user typed — so unscheduling removes
        // the placement and leaves the date alone rather than risking deleting
        // something that was never ours.
        scheduledDate: null,
        title: target.title,
      },
    ]);
  }

  /** From a block on the grid to the actual line in the note. Without this a
   *  block is a dead end, and the plugin reads as a panel bolted on beside
   *  Obsidian rather than part of it. */
  private async openSource(uid: string): Promise<void> {
    const target = this.lineFor(uid);
    if (!target) return;
    await this.openLine(target.file, target.line);
  }

  // -------------------------------------------------------------------------
  // view plumbing
  // -------------------------------------------------------------------------

  private pushAll(): void {
    this.push({
      snapshot: this.snapshot,
      settings: this.settings,
      now: new Date(),
      weekStart: this.weekStart,
      isCurrentWeek: this.isCurrentWeek(),
      fit: this.fit,
      fitting: this.fitting,
      lastWrite: this.lastWrite,
    });
  }

  private push(next: Parameters<WeekView['setWeekState']>[0]): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_WEEK)) {
      const view = leaf.view;
      if (view instanceof WeekView) {
        view.setWeekState({
          onRefresh: () => void this.refresh(),
          onFit: () => void this.runFit(),
          onClearFit: () => this.clearFit(),
          onAccept: (groupKey: string) => void this.accept([groupKey]),
          onAcceptAll: () => void this.accept((this.fit?.proposals ?? []).map((p) => p.groupKey)),
          onDismiss: (groupKey: string) => this.dismiss(groupKey),
          onMoveProposal: (groupKey: string, day: number, startMin: number) =>
            this.moveProposal(groupKey, day, startMin),
          onToggleGaps: () => void this.toggleGaps(),
          onCreateWeekNote: () => void this.createWeekNote(),
          onReplan: () => void this.runReplan(),
          onReview: () => void this.openReview(),
          onOpenTask: (file: string, line: number) => void this.openLine(file, line),
          onToggleDone: (file: string, line: number, text: string, done: boolean) =>
            void this.toggleDone(file, line, text, done),
          onScheduleTask: (
            file: string,
            line: number,
            text: string,
            day: number,
            startMin: number,
          ) => void this.scheduleTask(file, line, text, day, startMin),
          onTaskMenu: (file: string, line: number, text: string, x: number, y: number) =>
            this.taskMenu(file, line, text, x, y),
          onSetDue: (file: string, line: number, text: string, x: number, y: number) =>
            this.dueMenu(file, line, text, x, y),
          onSetPriority: (file: string, line: number, text: string, x: number, y: number) =>
            this.priorityMenu(file, line, text, x, y),
          onSetEstimate: (file: string, line: number, text: string, x: number, y: number) =>
            this.estimateMenu(file, line, text, x, y),
          onSplitBlock: (uid: string, x: number, y: number) => this.splitMenu(uid, x, y),
          onPrevWeek: () => void this.goToWeek(addWeeks(this.weekStart, -1)),
          onNextWeek: () => void this.goToWeek(addWeeks(this.weekStart, 1)),
          onToday: () => void this.goToWeek(new Date()),
          onMoveBlock: (uid: string, day: number, startMin: number) =>
            void this.moveBlock(uid, day, startMin),
          onUnschedule: (uid: string) => void this.unschedule(uid),
          onOpenSource: (uid: string) => void this.openSource(uid),
          onResizeBlock: (uid: string, startMin: number, endMin: number) =>
            void this.resizeBlock(uid, startMin, endMin),
          onResizeProposal: (groupKey: string, startMin: number, endMin: number) =>
            this.resizeProposal(groupKey, startMin, endMin),
          ...next,
        });
      }
    }
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_WEEK)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_WEEK, active: true });
    }
    workspace.revealLeaf(leaf);
    await this.refresh();
  }
}

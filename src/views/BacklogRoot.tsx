// The backlog view's whole render — plain props in, no Obsidian import, so
// it's testable the same way `WeekViewRoot`/`IntentionsRail` are. Row shape
// deliberately mirrors `IntentionsRail`'s `TaskItem` (metadata-stripped
// title, the same priority/due/estimate badges, the same "this was guessed"
// marker) so a task looks like the same thing whether it's sitting in the
// week's rail or here — the only difference is a backlog row also names its
// source file, since this list can span every configured task folder rather
// than one week's note.

import type { BacklogItem } from '../data/backlog';
import { fmtEstimate } from '../lib/duration';
import type { TaskDuration } from '../lib/duration';
import { fmtDue, isOverdue, PRIORITY_EMOJI } from '../lib/taskmeta';

export interface BacklogRootProps {
  items: BacklogItem[];
  /** Open the vault line a row came from. The view doesn't implement the
   *  opening itself — that's a workspace concern the plugin (`main.ts`)
   *  owns, the same split `WeekView`'s `onOpenSource` already draws. */
  onOpenSource: (file: string, line: number) => void;
}

/** Today, in the machine's local timezone, as `YYYY-MM-DD` — same
 *  construction `IntentionsRail`'s own (unexported) `todayIso` uses.
 *  Duplicated rather than imported: this file doesn't touch
 *  `src/components/`. */
function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

const ESTIMATE_HINT: Record<TaskDuration['source'], string> = {
  override: 'estimate written on the task',
  kind: 'default for this kind of task',
  default: 'global fallback — no tag, no estimate',
};

/**
 * The backlog: everything unscheduled across the configured folders, sized
 * and sorted (`collectBacklog`, `src/data/backlog.ts`) before this ever sees
 * it. A row is a button in substance if not in tag — click it, or focus it
 * and press Enter/Space, and its source line opens.
 */
export function BacklogRoot({ items, onOpenSource }: BacklogRootProps) {
  const today = todayIso();

  return (
    <div className="weekfit-backlog">
      <h2 className="weekfit-backlog__heading">Backlog</h2>
      {items.length === 0 ? (
        <p className="weekfit-backlog__empty">
          Nothing here — capture something with the quick-capture command, or tag a task{' '}
          <code>#thisweek</code> to pull it onto the week's rail instead.
        </p>
      ) : (
        <ul className="weekfit-backlog__list">
          {items.map(({ task, meta, est }) => {
            const due = meta.dates.due ?? null;
            const overdue = Boolean(due && isOverdue(meta, today));
            // A guess, not a statement — anything that didn't come from an
            // explicit estimate on the line itself (same quiet-adoption
            // marker the rail uses).
            const guessed = est.source !== 'override';

            const open = () => onOpenSource(task.file, task.line);

            return (
              <li
                key={`${task.file}:${task.line}`}
                className="weekfit-backlog__item"
                role="button"
                tabIndex={0}
                onClick={open}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    open();
                  }
                }}
              >
                {meta.priority && (
                  <span
                    className={`weekfit-backlog__pri weekfit-backlog__pri--${meta.priority.level}`}
                    title={`${meta.priority.level} priority`}
                  >
                    {PRIORITY_EMOJI[meta.priority.level]}
                  </span>
                )}
                <span className="weekfit-backlog__title">{meta.title}</span>
                {due && (
                  <span
                    className={`weekfit-backlog__due${
                      overdue ? ' weekfit-backlog__due--overdue' : ''
                    }`}
                    title={`due ${due.date}${overdue ? ' — overdue' : ''}`}
                  >
                    {fmtDue(due.date)}
                  </span>
                )}
                <span
                  className={`weekfit-backlog__est weekfit-backlog__est--${est.source}`}
                  title={`${fmtEstimate(est.minutes)} — ${
                    est.kind ? `#${est.kind} ` : ''
                  }${ESTIMATE_HINT[est.source]}`}
                >
                  {guessed && (
                    <span className="weekfit-backlog__est-guess" aria-hidden="true">
                      ≈
                    </span>
                  )}
                  {fmtEstimate(est.minutes)}
                </span>
                <span className="weekfit-backlog__source" title={task.file}>
                  {task.file}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

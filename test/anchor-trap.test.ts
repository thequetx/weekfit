import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hasPlacement } from '../src/data/dayplanner';
import { DAY_PLANNER_RE } from '../src/lib/source';

/**
 * A drift guard for the mistake this codebase has now made three times.
 *
 * `DAY_PLANNER_RE` is `^`-anchored and documented as matching a task line's
 * **body**. `VaultTask.text` is the whole raw line, `- [ ] ` and all. So every
 * one of these is silently always-false on real vault data:
 *
 *     DAY_PLANNER_RE.test(task.text)
 *     withDayPlannerRange(task.text, null)
 *
 * It has bitten:
 *   1. the rail and `computeFit` — already-scheduled work was offered a second
 *      placement, and "Fit this week" would move it;
 *   2. `computeReplan` — `passedBlocks` matches an event to a task by title, so
 *      replan silently found nothing at all, ever;
 *   3. `computeReview` — `futureSessions` likewise, so rolling forward
 *      mid-week carried away work that was still scheduled to happen.
 *
 * Each was found by a test written after the fact. This one fails first.
 */

const ROOT = path.resolve(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // `src/lib` is a byte-for-byte vendored port and is not ours to police.
      if (entry.name === 'lib') continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** The only file allowed to touch the raw regex: it splits the prefix off
 *  first, which is the whole point of it existing. */
const ALLOWED = path.join(ROOT, 'data', 'dayplanner.ts');

describe('the DAY_PLANNER_RE anchoring trap', () => {
  it('is never applied to a whole task line outside dayplanner.ts', () => {
    // Matches `DAY_PLANNER_RE.test(x.text`, `withDayPlannerRange(x.text`, and
    // `x.text.replace(DAY_PLANNER_RE` — the three shapes the bug has taken.
    //
    // The fourth is `isPlaced(x.text)`, which arrived with the engine sync and
    // is the trap wearing a disguise: it makes the `DAY_PLANNER_RE` call
    // itself, and its own comment says "the vault hands over a task line with
    // its list marker and checkbox already stripped". That is true in
    // week-dashboard and false here — `VaultTask.text` is the whole raw line —
    // so `isPlaced(task.text)` is silently always-false on real vault data,
    // exactly like the other three. Nothing calls it yet. This is here so that
    // when something does, it fails immediately instead of in six months.
    const offenders: string[] = [];
    const patterns = [
      /DAY_PLANNER_RE\.(test|exec)\(\s*[A-Za-z_$][\w$]*\.text\b/,
      /withDayPlannerRange\(\s*[A-Za-z_$][\w$]*\.text\b/,
      /[A-Za-z_$][\w$]*\.text\.replace\(\s*DAY_PLANNER_RE/,
      /\bisPlaced\(\s*[A-Za-z_$][\w$]*\.text\b/,
    ];

    for (const file of sourceFiles(ROOT)) {
      if (file === ALLOWED) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Comments explaining the trap are the point, not a violation.
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
        if (patterns.some((re) => re.test(code))) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      'Use hasPlacement() or applyPlacement() from src/data/dayplanner.ts — they strip ' +
        'the checkbox prefix first. Applied to a whole task line, DAY_PLANNER_RE is ' +
        'always false and the bug is silent.\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  // The behavioural half: prove the trap is real, so the guard above can never
  // be dismissed as theoretical.
  it('really is always false on a whole task line', () => {
    const line = '- [ ] 09:00 - 10:00 Fix badge alpha';
    expect(DAY_PLANNER_RE.test(line)).toBe(false); // the trap
    expect(hasPlacement(line)).toBe(true); // the correct answer
  });
});

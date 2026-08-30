import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { IntentionsRail } from '../src/components/IntentionsRail';
import { PRIORITY_GLYPH, priorityLabel } from '../src/components/priority';
import { PRIORITIES, PRIORITY_EMOJI } from '../src/lib/taskmeta';
import { DEFAULT_SETTINGS } from '../src/data/contract';
import type { VaultTask } from '../src/lib/types';

afterEach(cleanup);

function task(text: string, line = 0): VaultTask {
  return { text: `- [ ] ${text}`, done: false, file: 'Weekly/2026-W36.md', line };
}

function rail(tasks: VaultTask[]) {
  return render(<IntentionsRail tasks={tasks} durations={DEFAULT_SETTINGS.durations} />);
}

describe('priority is drawn as theme-coloured text, not an emoji', () => {
  // The standard's own markers are emoji, and this plugin reads and writes
  // exactly those. But an emoji carries its own colour: on Windows `🔼` shows
  // as a blue-filled square, which in a UI with zero hardcoded colours reads
  // as a broken glyph. Worse, the CSS that was supposed to colour it could
  // never work.
  it('renders no emoji marker in the rail', () => {
    const { container } = rail([
      task('Highest 🔺', 1),
      task('High ⏫', 2),
      task('Medium 🔼', 3),
      task('Low 🔽', 4),
      task('Lowest ⏬', 5),
    ]);
    const text = container.textContent ?? '';
    for (const emoji of Object.values(PRIORITY_EMOJI)) {
      if (!emoji) continue;
      expect(text).not.toContain(emoji);
    }
  });

  it('renders a glyph for each written priority', () => {
    const { container } = rail([task('Highest 🔺', 1), task('Low 🔽', 2)]);
    const marks = [...container.querySelectorAll('.weekfit-rail__pri')];
    expect(marks).toHaveLength(2);
    expect(marks.map((m) => m.textContent)).toEqual([
      PRIORITY_GLYPH.highest,
      PRIORITY_GLYPH.low,
    ]);
  });

  it('carries the level as a class, so the theme can colour it', () => {
    const { container } = rail([task('Highest 🔺', 1)]);
    const mark = container.querySelector('.weekfit-rail__pri');
    expect(mark!.classList.contains('weekfit-rail__pri--highest')).toBe(true);
  });

  // Shape alone must never carry the meaning — a glyph is not readable by a
  // screen reader and not obvious to anyone who hasn't learned the scheme.
  it('names the priority in words as well', () => {
    rail([task('Highest 🔺', 1)]);
    expect(screen.getByTitle('highest priority')).toBeInTheDocument();
  });

  it('shows nothing at all for a task with no priority written', () => {
    const { container } = rail([task('Just a task')]);
    expect(container.querySelector('.weekfit-rail__pri')).toBeNull();
  });

  it('has a glyph for every level the standard defines', () => {
    for (const level of PRIORITIES) {
      // `none` is the absence of a marker, so an empty string is correct.
      expect(typeof PRIORITY_GLYPH[level]).toBe('string');
      if (level !== 'none') {
        expect(PRIORITY_GLYPH[level].length).toBeGreaterThan(0);
        expect(priorityLabel(level)).toContain(level);
      }
    }
    expect(PRIORITY_GLYPH.none).toBe('');
    expect(priorityLabel('none')).toBe('');
  });

  // The note keeps the standard's emoji — this is a rendering choice, and a
  // task line must round-trip unchanged through being displayed.
  it('does not change what a task line says', () => {
    const line = task('Medium 🔼', 1);
    rail([line]);
    expect(line.text).toBe('- [ ] Medium 🔼');
  });
});

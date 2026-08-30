/**
 * How a task's priority is *drawn*, as distinct from how it is written.
 *
 * The Obsidian Tasks standard marks priority with emoji — `🔺⏫🔼🔽⏬` — and
 * this plugin reads and writes exactly those, unchanged. But an emoji is a
 * raster glyph: it carries its own fixed colour, ignores `color`, and renders
 * differently on every platform. On Windows `🔼` comes out as a blue-filled
 * square that reads as a broken image, in a UI whose whole visual contract is
 * "inherit the user's theme and hardcode nothing".
 *
 * The styling was already there and had simply never been able to take effect:
 * `.weekfit-rail__pri--high { color: var(--color-red) }` cannot tint an emoji.
 *
 * So the glyphs below are plain geometric characters, which are text: they take
 * the theme's colour, scale with the font, and look the same everywhere. The
 * note on disk is untouched — this is a rendering choice, not a format one.
 *
 * Shape alone never carries the meaning: every caller pairs these with a
 * `title` naming the priority in words.
 */
import type { PriorityName } from '../lib/taskmeta';

export const PRIORITY_GLYPH: Record<PriorityName, string> = {
  // Direction reads as urgency, size as degree — so the five levels are
  // distinguishable at a glance without five different colours.
  highest: '▲',
  high: '▲',
  medium: '▴',
  none: '',
  low: '▾',
  lowest: '▼',
};

/** The word, for the `title`/`aria-label`. Never rely on the glyph alone. */
export function priorityLabel(level: PriorityName): string {
  return level === 'none' ? '' : `${level} priority`;
}

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Decorations on a block must not be drawn on top of its text.
 *
 * The conflict warning was pinned at `top: 2px; left: 5px`, which is exactly
 * where the time label starts — the block's own padding is `3px 7px`. So on
 * every conflicting block the two glyphs printed on top of each other, and an
 * 8pm block overlaid with `⚠` read as `4pm`. That is the worst way for a
 * calendar to be wrong: not obviously broken, just quietly showing a
 * different time than the one in the note.
 *
 * jsdom has no layout, so nothing here can measure an overlap. What it can do
 * is hold the two rules that prevent it — a reserved gutter, and that gutter
 * surviving the `padding` shorthands in the `--tight` rules.
 */

const CSS = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');

interface Rule {
  selectors: string[];
  body: string;
  index: number;
}

/** styles.css is flat — no at-rules — so a rule is any `selectors { body }`. */
const RULES: Rule[] = (() => {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean),
    body: m[2],
    index: m.index!,
  }));
})();

/** Rules targeting the block itself — `.x` or `.x--mod`, never a descendant. */
function blockRules(base: string): Rule[] {
  const own = new RegExp(`^${base.replace('.', '\\.')}(--[a-z-]+)*$`);
  return RULES.filter((r) => r.selectors.some((s) => own.test(s)));
}

function rulesFor(selector: string): Rule[] {
  const found = RULES.filter((r) => r.selectors.includes(selector));
  expect(found, `no rule found for ${selector}`).not.toHaveLength(0);
  return found;
}

/** Last-wins across every rule for a selector — they are all one class deep. */
function px(selector: string, prop: string): number | null {
  let value: number | null = null;
  for (const rule of rulesFor(selector)) {
    const m = new RegExp(`(?:^|;|\\n)\\s*${prop}:\\s*(-?[\\d.]+)px`).exec(rule.body);
    if (m) value = Number(m[1]);
  }
  return value;
}

function declares(selector: string, prop: string): boolean {
  return rulesFor(selector).some((r) => new RegExp(`(?:^|;|\\n)\\s*${prop}:`).test(r.body));
}

describe.each([
  ['.weekfit-ev', '.weekfit-ev--conflict', '.weekfit-ev__conflict'],
  ['.weekfit-ghost', '.weekfit-ghost--conflict', '.weekfit-ghost__conflict'],
])('the conflict warning on %s', (base, modifier, marker) => {
  it('is not pinned into the corner where the text begins', () => {
    // Centred down the left edge instead: `top: 50%` plus a translate. A
    // small pixel `top` is the bug this file exists for.
    const top = px(marker, 'top');
    expect(top === null || top > 12, `${marker} sits at top: ${top}px, over the first line`).toBe(
      true,
    );
  });

  it('has a gutter reserved for it, wide enough to clear the glyph', () => {
    const reserved = px(modifier, 'padding-left');
    const left = px(marker, 'left') ?? 0;
    expect(reserved, `${modifier} reserves no padding-left`).not.toBeNull();
    expect(reserved!).toBeGreaterThan(left + 8);
  });

  it('keeps that gutter after every `padding` shorthand that could reset it', () => {
    // `--tight` sets `padding: 2px 7px`. If the gutter rule came first the
    // shorthand would silently put the warning back over the text — the same
    // bug, reintroduced by an edit that looks unrelated to it.
    const gutter = Math.max(
      ...rulesFor(modifier)
        .filter((r) => /(?:^|;|\n)\s*padding-left:/.test(r.body))
        .map((r) => r.index),
    );
    const shorthands = blockRules(base)
      .filter((r) => /(?:^|;|\n)\s*padding:/.test(r.body))
      .map((r) => r.index);
    expect(shorthands.length, `${base} declares no padding shorthand at all`).toBeGreaterThan(0);
    expect(
      Math.max(...shorthands),
      `a \`padding\` shorthand for ${base} is declared after ${modifier}'s gutter`,
    ).toBeLessThan(gutter);
  });
});

describe('decorations claim different corners', () => {
  // `__ses` (the `1/3` split badge) escaped this only because it took the
  // top-right, where nothing else lives. Both can be on one block at once.
  it.each([
    ['.weekfit-ev__conflict', '.weekfit-ev__ses'],
    ['.weekfit-ghost__conflict', '.weekfit-ghost__ses'],
  ])('%s and %s do not both claim one edge', (warn, badge) => {
    expect(declares(warn, 'left')).toBe(true);
    expect(declares(warn, 'right')).toBe(false);
    expect(declares(badge, 'right')).toBe(true);
    expect(declares(badge, 'left')).toBe(false);
  });
});

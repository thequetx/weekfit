import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The day headers have to survive a scroll.
 *
 * `.weekfit-grid` is the scroll container and the headers are ordinary in-flow
 * children of each column, so scrolling to the evening took MON/TUE/WED off
 * screen and left seven near-identical columns with nothing saying which one
 * was Thursday. A screenshot of a scrolled week made it obvious; jsdom has no
 * layout and never could.
 *
 * What *is* checkable is the rule itself, and the invariant that keeps it
 * working: the header must outrank every layer that can be drawn inside a day
 * body. Those z-indexes get bumped whenever a new overlay appears — this fails
 * the next time one is raised past the header rather than after a ghost is
 * seen sliding over the day names.
 */

const CSS = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');

/** The declarations for one selector, as written (last block wins on repeat). */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
  const found = [...CSS.matchAll(re)];
  expect(found, `no rule found for ${selector}`).not.toHaveLength(0);
  return found.map((m) => m[1]).join('\n');
}

function zIndexOf(selector: string): number {
  const match = /z-index:\s*(-?\d+)/.exec(block(selector));
  expect(match, `${selector} declares no z-index`).not.toBeNull();
  return Number(match![1]);
}

describe('the day headers stay put while the grid scrolls', () => {
  it.each(['.weekfit-grid__colhead', '.weekfit-grid__gutterhead'])(
    '%s is sticky to the top of the scrollport',
    (selector) => {
      const rules = block(selector);
      expect(rules).toMatch(/position:\s*sticky/);
      expect(rules).toMatch(/top:\s*0/);
    },
  );

  // Transparent headers let blocks scroll straight through them, which is
  // arguably worse than no header at all — it looks like a rendering fault.
  it.each(['.weekfit-grid__colhead', '.weekfit-grid__gutterhead'])(
    '%s paints an opaque background',
    (selector) => {
      expect(block(selector)).toMatch(/background:\s*var\(--background-primary\)/);
    },
  );

  // The tint marking today lives on the column; an opaque header sitting over
  // it would break the column's colour at the very top.
  it("keeps today's tint on today's header", () => {
    expect(block('.weekfit-grid__col--today .weekfit-grid__colhead')).toMatch(/background:/);
  });

  it('outranks every other layer in the stylesheet', () => {
    const head = zIndexOf('.weekfit-grid__colhead');
    const all = [...CSS.matchAll(/z-index:\s*(-?\d+)/g)].map((m) => Number(m[1]));
    const others = all.filter((z) => z !== head);
    expect(others.length).toBeGreaterThan(0);
    expect(
      Math.max(...others),
      'a layer has been raised past the day header — it will scroll over the day names',
    ).toBeLessThan(head);
  });

  it('sits above the ghost layers by name, not just by luck', () => {
    const head = zIndexOf('.weekfit-grid__colhead');
    expect(head).toBeGreaterThan(zIndexOf('.weekfit-ghost'));
    expect(head).toBeGreaterThan(zIndexOf('.weekfit-ghost__actions--escape'));
    expect(head).toBeGreaterThan(zIndexOf('.weekfit-ev'));
  });

  it('has no clipping ancestor that would disable the sticking', () => {
    // `position: sticky` is silently inert if anything between it and the
    // scrollport clips overflow. The scroll container itself is allowed to.
    for (const selector of ['.weekfit-grid__col', '.weekfit-grid__gutter']) {
      expect(block(selector)).not.toMatch(/overflow[^:]*:\s*(hidden|clip|auto|scroll)/);
    }
    expect(block('.weekfit-grid')).toMatch(/overflow:\s*auto/);
  });
});

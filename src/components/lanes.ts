// src/components/lanes.ts
//
// Interval-graph column packing for the week grid — the maths that lets two
// blocks at the same time sit side by side instead of on top of each other.
// Pure: a function of the spans handed in, nothing else.

/** A block that occupies part of a day, identified by a caller-chosen id. */
export interface Spanned {
  id: string;
  startMin: number;
  endMin: number;
}

/** Where one block sits horizontally: which lane, and how many lanes its
 *  cluster was split into. `{ lane: 0, lanes: 1 }` is "full width, alone". */
export interface LanePlacement {
  lane: number;
  lanes: number;
}

export function packLanes(items: Spanned[]): Map<string, LanePlacement> {
  const out = new Map<string, LanePlacement>();
  const sorted = [...items].sort(
    (a, b) => a.startMin - b.startMin || a.endMin - b.endMin,
  );

  let cluster: Spanned[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (cluster.length === 0) return;

    const laneEnds: number[] = []; // laneEnds[i] = end of the last block in lane i
    const laneOf = new Map<string, number>();

    for (const it of cluster) {
      let lane = laneEnds.findIndex((end) => end <= it.startMin);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(it.endMin);
      } else {
        laneEnds[lane] = it.endMin;
      }
      laneOf.set(it.id, lane); // <-- inside the loop: `it` only exists here
    }

    const lanes = laneEnds.length;
    for (const it of cluster) {
      out.set(it.id, { lane: laneOf.get(it.id)!, lanes });
    }

    cluster = [];
    clusterEnd = -Infinity;
  }; // <-- `flush` is an arrow function assigned to a const; close it with `};`

  for (const it of sorted) {
    if (cluster.length > 0 && it.startMin >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  flush();

  return out;
}

/**
 * The inline style that positions a block horizontally, given its lane
 * placement. `laneStyle(0, 1)` reproduces the stylesheet's old fixed
 * `left: 8px; right: 4px` exactly — so a day with no overlaps, and every
 * test that doesn't opt in, renders pixel-for-pixel as before.
 */
export function laneStyle(
  lane: number,
  lanes: number,
): { left: string; width: string; right: 'auto' } {
  const GUTTER_L = 8; // was `left: 8px` in styles.css
  const GUTTER_R = 4; // was `right: 4px` in styles.css
  const LANE_GAP = 2; // breathing room between side-by-side blocks

  const n = Math.max(lanes, 1); // never divide by zero
  const i = Math.min(Math.max(lane, 0), n - 1); // a real column index

  const band = `(100% - ${GUTTER_L + GUTTER_R}px)`;
  return {
    left: `calc(${GUTTER_L}px + ${band} * ${i} / ${n})`,
    width: `calc(${band} / ${n} - ${i < n - 1 ? LANE_GAP : 0}px)`,
    right: 'auto',
  };
}
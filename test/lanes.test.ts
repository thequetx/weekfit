import { describe, it, expect } from 'vitest';
import { packLanes, laneStyle } from '../src/components/lanes';

const S = (id: string, startMin: number, endMin: number) => ({ id, startMin, endMin });

describe('packLanes', () => {
  it('leaves a lone block full width', () => {
    expect(packLanes([S('a', 540, 600)]).get('a')).toEqual({ lane: 0, lanes: 1 });
  });

  it('puts two overlapping blocks in two lanes', () => {
    const got = packLanes([S('a', 540, 600), S('b', 570, 630)]);
    expect(got.get('a')).toEqual({ lane: 0, lanes: 2 });
    expect(got.get('b')).toEqual({ lane: 1, lanes: 2 });
  });

  it('treats end-to-start touching as non-overlapping', () => {
    const got = packLanes([S('a', 540, 600), S('b', 600, 660)]);
    expect(got.get('a')).toEqual({ lane: 0, lanes: 1 });
    expect(got.get('b')).toEqual({ lane: 0, lanes: 1 });
  });

  it('reuses a freed lane inside a cluster', () => {
    const got = packLanes([S('a', 540, 600), S('b', 570, 630), S('c', 600, 660)]);
    expect(got.get('a')).toEqual({ lane: 0, lanes: 2 });
    expect(got.get('b')).toEqual({ lane: 1, lanes: 2 });
    expect(got.get('c')).toEqual({ lane: 0, lanes: 2 });
  });

  it('is independent of input order', () => {
    const items = [S('a', 540, 600), S('b', 570, 630), S('c', 600, 660)];
    const fwd = packLanes(items);
    const rev = packLanes([...items].reverse());
    for (const id of ['a', 'b', 'c']) expect(rev.get(id)).toEqual(fwd.get(id));
  });
});

describe('laneStyle', () => {
  it('reproduces the old fixed geometry for a lone block', () => {
    expect(laneStyle(0, 1)).toEqual({
      left: 'calc(8px + (100% - 12px) * 0 / 1)',
      width: 'calc((100% - 12px) / 1 - 0px)',
      right: 'auto',
    });
  });

  it('halves a two-lane cluster and gaps all but the last lane', () => {
    expect(laneStyle(0, 2).width).toBe('calc((100% - 12px) / 2 - 2px)');
    expect(laneStyle(1, 2).width).toBe('calc((100% - 12px) / 2 - 0px)');
    expect(laneStyle(1, 2).left).toBe('calc(8px + (100% - 12px) * 1 / 2)');
  });

  it('clamps nonsense input back to "alone, full width"', () => {
    expect(laneStyle(5, 0)).toEqual(laneStyle(0, 1));
  });
});
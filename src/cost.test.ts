import { describe, expect, it } from 'vitest';
import { crossedThresholds, TurnCostMeter } from './cost.ts';

const THRESHOLDS = [5, 10];

describe('crossedThresholds', () => {
  it('returns nothing while the total stays below every threshold', () => {
    expect(crossedThresholds(0, 4.99, THRESHOLDS)).toEqual([]);
  });

  it('returns the threshold the turn just crossed', () => {
    expect(crossedThresholds(4.2, 5.03, THRESHOLDS)).toEqual([5]);
  });

  it('counts landing exactly on a threshold as crossing it', () => {
    expect(crossedThresholds(4.5, 5, THRESHOLDS)).toEqual([5]);
  });

  it('does not re-cross a threshold the total already passed — one-shot per session', () => {
    expect(crossedThresholds(5.03, 7.8, THRESHOLDS)).toEqual([]);
  });

  it('returns every threshold a single expensive turn jumps over, ascending', () => {
    expect(crossedThresholds(4, 12, THRESHOLDS)).toEqual([5, 10]);
  });

  it('a total already past the last threshold never warns again', () => {
    expect(crossedThresholds(11, 60, THRESHOLDS)).toEqual([]);
  });

  it('handles custom threshold lists', () => {
    expect(crossedThresholds(0, 3.5, [1, 2, 3, 20])).toEqual([1, 2, 3]);
  });
});

describe('TurnCostMeter', () => {
  it('reports the first result total as the first turn cost', () => {
    const meter = new TurnCostMeter();
    expect(meter.turnCost(0.12)).toBeCloseTo(0.12);
  });

  it('reports deltas between the cumulative totals of successive turns', () => {
    const meter = new TurnCostMeter();
    meter.turnCost(0.12);
    expect(meter.turnCost(0.3)).toBeCloseTo(0.18);
    expect(meter.turnCost(0.3)).toBeCloseTo(0);
  });

  it('never reports a negative cost if the cumulative total goes backwards', () => {
    const meter = new TurnCostMeter();
    meter.turnCost(0.5);
    expect(meter.turnCost(0.2)).toBe(0);
  });
});

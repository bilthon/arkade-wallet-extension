import { describe, it, expect } from 'vitest';
// The formatter lives in the popup, but vitest only discovers tests under src/, so we
// import across the boundary. format.ts has no runtime imports (only an erased type), so
// this resolves cleanly.
import { untilRelative } from '../entrypoints/popup/format';

/**
 * `untilRelative` renders an expiry countdown. The coin-control screen leans on the days
 * tier for real multi-day VTXO lifetimes ("~7 days 5 h"); below 48 h it stays in the
 * hours/minutes tiers.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Build a future timestamp `ms` from now. Add a small cushion so rounding lands on the
 *  intended tier regardless of the sub-ms gap between here and the Date.now() inside. */
const inMs = (ms: number) => Date.now() + ms + 500;

describe('untilRelative — days tier', () => {
  it('shows days and remaining hours past 48 h', () => {
    expect(untilRelative(inMs(7 * DAY + 5 * HOUR))).toBe('7 days 5 h');
  });

  it('drops the hours when the remainder is a whole number of days', () => {
    expect(untilRelative(inMs(3 * DAY))).toBe('3 days');
  });

  it('switches to the days tier exactly at 48 h', () => {
    expect(untilRelative(inMs(48 * HOUR))).toBe('2 days');
  });

  it('stays in the hours tier just below 48 h', () => {
    expect(untilRelative(inMs(47 * HOUR))).toBe('47 h');
  });
});

describe('untilRelative — hours and minutes tiers (unchanged)', () => {
  it('shows hours and minutes under 48 h', () => {
    expect(untilRelative(inMs(1 * HOUR + 5 * MIN))).toBe('1 h 5 min');
  });

  it('shows minutes under an hour', () => {
    expect(untilRelative(inMs(12 * MIN))).toBe('12 min');
  });

  it('collapses a past/near-zero time to "soon"', () => {
    expect(untilRelative(Date.now() - 1000)).toBe('soon');
  });
});

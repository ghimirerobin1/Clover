import { Thresholds } from '../thresholds';

describe('Thresholds.resolve (item → category → global)', () => {
  it.each([
    [3, 10, 5, 3],
    [0, 10, 5, 0], // explicit 0 override is respected, not treated as missing
    [null, 10, 5, 10],
    [undefined, 0, 5, 0],
    [null, null, 5, 5],
    [undefined, undefined, 7, 7],
  ] as const)('item=%p category=%p global=%p → %p', (item, cat, global, expected) => {
    expect(Thresholds.resolve(item, cat, global)).toBe(expected);
  });
});

describe('Thresholds.status', () => {
  it.each([
    [null, 5, 'untracked'],
    [-2, 5, 'out'],
    [0, 5, 'out'],
    [0.5, 5, 'low'],
    [5, 5, 'low'],
    [6, 5, 'ok'],
    [1, 0, 'ok'],
  ] as const)('qty=%p threshold=%p → %s', (qty, t, s) => {
    expect(Thresholds.status(qty, t)).toBe(s);
    expect(Thresholds.tone(s)).toBeDefined();
  });
});

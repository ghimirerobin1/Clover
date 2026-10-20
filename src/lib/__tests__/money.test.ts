import { Money } from '../money';

describe('Money.format', () => {
  it.each([
    [0, '$0.00'],
    [5, '$0.05'],
    [99, '$0.99'],
    [100, '$1.00'],
    [2899, '$28.99'],
    [123456789, '$1,234,567.89'],
    [-5, '-$0.05'],
    [-150000, '-$1,500.00'],
  ])('%d → %s', (cents, expected) => {
    expect(Money.format(cents)).toBe(expected);
  });

  it.each([1.5, NaN, Infinity, 2 ** 60])('rejects non-integer/unsafe %p', (v) => {
    expect(() => Money.format(v)).toThrow(TypeError);
  });
});

describe('Money.marginBps', () => {
  it('uses integer math', () => {
    expect(Money.marginBps(2899, 2100)).toBe(2756);
    expect(Money.formatBps(2756)).toBe('27.6%');
    expect(Money.marginBps(0, 10)).toBeNull();
    expect(Money.marginBps(100, 150)).toBe(-5000);
    expect(() => Money.marginBps(1.1, 1)).toThrow(TypeError);
  });
});

import { StockMath, type StockIntent } from '../StockMath';

const receive = (n: number): StockIntent => ({ action: 'receive', amount: n });
const count = (n: number): StockIntent => ({ action: 'count', amount: n });
const adjust = (n: number): StockIntent => ({ action: 'adjust', amount: n, reason: 'damaged' });

describe('StockMath.target', () => {
  it('receive adds, count sets, adjust/undo add signed', () => {
    expect(StockMath.target(receive(24), 14)).toBe(38);
    expect(StockMath.target(count(9), 14)).toBe(9);
    expect(StockMath.target(adjust(-3), 14)).toBe(11);
    expect(StockMath.target({ action: 'undo', amount: -24 }, 38)).toBe(14);
  });
});

describe('409 rebase rules (spec §4.4 step 4)', () => {
  it('Receive recomputes from the new base: +24 on 12 → 36', () => {
    expect(StockMath.rebase(receive(24), 12)).toEqual({ expected: 12, target: 36 });
  });
  it('Adjust recomputes from the new base', () => {
    expect(StockMath.rebase(adjust(-2), 12)).toEqual({ expected: 12, target: 10 });
  });
  it('Count keeps the absolute number', () => {
    expect(StockMath.rebase(count(20), 12)).toEqual({ expected: 12, target: 20 });
  });
  it('Undo applies the inverse delta on the new base', () => {
    expect(StockMath.rebase(StockMath.undoIntent({ before: 14, after: 38 }), 37)).toEqual({ expected: 37, target: 13 });
  });
});

describe('StockMath.isDestructive', () => {
  it.each([
    [14, 38, false],
    [14, 14, false],
    [14, 13, true],
    [14, 0, true],
    [0, 0, true],
    [-2, 0, true],
    [-2, 1, false],
  ])('%d → %d destructive=%p', (b, a, d) => {
    expect(StockMath.isDestructive(b, a)).toBe(d);
  });
});

describe('StockMath.summary / signed', () => {
  it('formats the confirmation text', () => {
    expect(StockMath.summary(receive(24), 14)).toBe('Current 14 → New 38 (+24, Receive)');
    expect(StockMath.summary(count(9), 14)).toBe('Current 14 → New 9 (−5, Count)');
    expect(StockMath.signed(0)).toBe('±0');
  });
});

describe('StockMath.validate', () => {
  it.each<[StockIntent, number, string | null]>([
    [receive(0), 5, 'Enter how many you received'],
    [receive(2.5), 5, 'Whole units only'],
    [receive(3), 5, null],
    [count(0), 5, null],
    [count(5), 5, null], // recounting the same number is a valid cycle count
    [count(-1), 5, 'Count cannot be negative'],
    [{ action: 'adjust', amount: -1 }, 5, 'Pick a reason'],
    [adjust(0), 5, 'No change'],
    [adjust(-6), 5, 'Would go below zero (-1)'],
    [{ action: 'undo', amount: -10 }, 5, 'Would go below zero (-5)'],
  ])('%j on %d → %p', (intent, base, expected) => {
    expect(StockMath.validate(intent, base)).toBe(expected);
  });
});

describe('undoIntent', () => {
  it('is the inverse delta of the applied change', () => {
    expect(StockMath.undoIntent({ before: 14, after: 38 })).toEqual({ action: 'undo', amount: -24 });
    expect(StockMath.undoIntent({ before: 10, after: 7 })).toEqual({ action: 'undo', amount: 3 });
  });
});

import { FtsQuery } from '../fts';

describe('FtsQuery.build', () => {
  it.each([
    ['', null],
    ['   ', null],
    ['--', null],
    ['rice', '"rice"*'],
    ['Jas  RICE', '"jas"* "rice"*'],
    ['RICE-JAS-20', '"rice"* "jas"* "20"*'],
    ['"; DROP TABLE items; --', '"drop"* "table"* "items"*'],
    ['crème', '"creme"*'],
    ['0744 NEAR/2 x OR y', '"0744"* "near"* "2"* "x"* "or"* "y"*'],
  ])('%p → %p', (input, expected) => {
    expect(FtsQuery.build(input)).toBe(expected);
  });

  it('caps the number of terms', () => {
    expect(FtsQuery.build('a b c d e f g h i j')?.split(' ')).toHaveLength(8);
  });
});

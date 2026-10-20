import { fireEvent, render, screen } from '@testing-library/react-native';

import type { ItemRow } from '../../../db/items';
import { FilterState } from '../FilterBar';
import { ThresholdInput } from '../ItemDetailScreen';
import { ItemFormat, ItemListRow } from '../ItemListRow';

const row: ItemRow = {
  id: 'A', name: 'Jasmine Rice 20lb', sku: 'RICE-JAS-20', code: '074410000123', price_cents: 2899, cost_cents: null,
  category_id: null, category_name: null, stock_qty: 3, low_stock_threshold: null, category_threshold: null,
  threshold: 5, modified_time: 1, synced_at: 1, last_counted_at: null,
};

describe('ItemListRow', () => {
  it('shows name, ids, price and stock; presses through', async () => {
    const onPress = jest.fn();
    await render(<ItemListRow item={row} onPress={onPress} />);
    expect(screen.getByText('Jasmine Rice 20lb')).toBeTruthy();
    expect(screen.getByText('RICE-JAS-20 · 074410000123 · $28.99')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Jasmine Rice 20lb, $28.99, stock 3' }));
    expect(onPress).toHaveBeenCalledWith('A');
  });
});

describe('helpers', () => {
  it('formats stock and identifiers', () => {
    expect(ItemFormat.stockLabel(null)).toBe('Not tracked');
    expect(ItemFormat.stockLabel(2.5)).toBe('2.50');
    expect(ItemFormat.identifiers({ sku: null, code: null })).toBe('No SKU / UPC');
  });

  it('toggles categories', () => {
    expect(FilterState.toggleCategory(['a'], 'b')).toEqual(['a', 'b']);
    expect(FilterState.toggleCategory(['a', 'b'], 'a')).toEqual(['b']);
  });

  it.each([
    ['', null],
    [' 7 ', 7],
    ['0', 0],
    ['-1', undefined],
    ['2.5', undefined],
    ['abc', undefined],
  ])('ThresholdInput.parse(%p) → %p', (text, expected) => {
    expect(ThresholdInput.parse(text)).toBe(expected);
  });
});

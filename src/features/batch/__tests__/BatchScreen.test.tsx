import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { RemoteItem } from '../../../api/schemas';
import { ItemRepo } from '../../../db/items';
import { WasmSqlDb } from '../../../db/testing/wasmDb';
import { ApiError } from '../../../lib/errors';

const mockDb: { current: WasmSqlDb | null } = { current: null };
const mockProxy = { item: jest.fn<Promise<RemoteItem>, [string]>(), writeStock: jest.fn() };

jest.mock('../../../db/ExpoSqlDb', () => ({ AppDatabase: { get: async () => mockDb.current } }));
jest.mock('../../../api/proxy', () => ({
  ProxyClient: {
    item: (id: string) => mockProxy.item(id),
    writeStock: (...a: unknown[]) => mockProxy.writeStock(...a),
  },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${Math.random()}` }));
jest.mock('expo-haptics', () => ({ notificationAsync: jest.fn(), NotificationFeedbackType: { Success: 's', Warning: 'w', Error: 'e' } }));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn() }) }));

// eslint-disable-next-line import/first
import { BatchScreen } from '../BatchScreen';
// eslint-disable-next-line import/first
import { TallyController, useTallyStore } from '../Tally';

const item = (id: string, qty: number): RemoteItem => ({
  id, name: id, sku: null, code: null, priceCents: 100, costCents: null, categoryId: null, stockQty: qty, modifiedTime: 1, deleted: false,
});

describe('BatchScreen', () => {
  beforeEach(async () => {
    mockDb.current = await WasmSqlDb.migrated();
    await ItemRepo.upsertItems(mockDb.current, [item('RICE', 14), item('RAMEN', 3)], 1);
    mockProxy.item.mockReset().mockImplementation(async (id) => item(id, id === 'RICE' ? 14 : 3));
    mockProxy.writeStock.mockReset();
    TallyController.clear();
    TallyController.add({ id: 'RICE', name: 'RICE' });
    TallyController.add({ id: 'RICE', name: 'RICE' });
    TallyController.add({ id: 'RAMEN', name: 'RAMEN' });
  });
  afterEach(() => mockDb.current?.close());

  const renderScreen = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <BatchScreen source="tally" />
      </QueryClientProvider>,
    );

  it('lists every row live before → after, writes nothing until Apply, then shows per-row results', async () => {
    mockProxy.writeStock
      .mockResolvedValueOnce({ itemId: 'RAMEN', previousQuantity: 3, newQuantity: 1, auditId: 1, replayed: false })
      .mockRejectedValueOnce(new ApiError('CONFLICT', 'changed', false, 409, 13));
    await renderScreen();
    // Count mode by default: RAMEN 3 → 1 (destructive), RICE 14 → 2.
    await waitFor(() => expect(screen.getByLabelText('RAMEN: 3 → 1, Ready')).toBeTruthy());
    expect(screen.getByLabelText('RICE: 14 → 2, Ready')).toBeTruthy();
    expect(mockProxy.writeStock).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('batch-apply'));
    await waitFor(() => expect(screen.getByLabelText('RICE: 13 → 2, Conflict')).toBeTruthy());
    expect(screen.getByLabelText('RAMEN: 3 → 1, ✓ Applied')).toBeTruthy();
    expect(mockProxy.writeStock).toHaveBeenCalledTimes(2);
    expect(mockProxy.writeStock.mock.calls[0]?.[1]).toMatchObject({ action: 'count', expectedQuantity: 3, newQuantity: 1 });
    // Applied tally rows are cleared; the conflicting one stays.
    expect(useTallyStore.getState().rows.map((r) => r.itemId)).toEqual(['RICE']);
    expect(screen.getByText('Re-confirm and apply 1')).toBeTruthy();
  });

  it('Receive mode and row removal', async () => {
    mockProxy.writeStock.mockResolvedValue({ itemId: 'RICE', previousQuantity: 14, newQuantity: 16, auditId: 1, replayed: false });
    await renderScreen();
    await waitFor(() => screen.getByLabelText('RICE: 14 → 2, Ready'));
    await fireEvent.press(screen.getByLabelText('Add tally to stock (Receive)'));
    await waitFor(() => expect(screen.getByLabelText('RICE: 14 → 16, Ready')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Remove RAMEN'));
    expect(screen.queryByLabelText(/^RAMEN:/)).toBeNull();
    await fireEvent.press(screen.getByTestId('batch-apply'));
    await waitFor(() => expect(mockProxy.writeStock).toHaveBeenCalledTimes(1));
    expect(mockProxy.writeStock.mock.calls[0]?.[0]).toBe('RICE');
  });

  it('offline: rows without live stock cannot be applied', async () => {
    mockProxy.item.mockRejectedValue(new ApiError('NETWORK', 'offline', true));
    await renderScreen();
    await waitFor(() => expect(screen.getByLabelText('RICE: ? → ?, Ready')).toBeTruthy());
    expect(screen.getByTestId('batch-apply').props.accessibilityState).toMatchObject({ disabled: true });
  });
});

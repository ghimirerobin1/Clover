import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { RemoteItem } from '../../../api/schemas';
import { ApiError } from '../../../lib/errors';
import { WasmSqlDb } from '../../../db/testing/wasmDb';
import { ItemRepo } from '../../../db/items';

const mockDb: { current: WasmSqlDb | null } = { current: null };
const mockProxy = {
  item: jest.fn<Promise<RemoteItem>, [string]>(),
  writeStock: jest.fn(),
};

jest.mock('../../../db/ExpoSqlDb', () => ({ AppDatabase: { get: async () => mockDb.current } }));
jest.mock('../../../api/proxy', () => ({
  ProxyClient: {
    item: (id: string) => mockProxy.item(id),
    writeStock: (...a: unknown[]) => mockProxy.writeStock(...a),
  },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${Math.random()}` }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 's', Warning: 'w', Error: 'e' },
}));

// eslint-disable-next-line import/first
import { ConfirmCard, StockSheetHost } from '../StockSheet';
// eslint-disable-next-line import/first
import { StockSheetController } from '../stockSheetStore';

const item = (qty: number | null): RemoteItem => ({
  id: 'RICE', name: 'Jasmine Rice', sku: null, code: null, priceCents: 2899, costCents: null,
  categoryId: null, stockQty: qty, modifiedTime: 1, deleted: false,
});

async function renderHost() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={qc}>
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
        <StockSheetHost />
      </SafeAreaProvider>
    </QueryClientProvider>,
  );
}

describe('StockSheet (read-verify-write UI)', () => {
  beforeEach(async () => {
    mockDb.current = await WasmSqlDb.migrated();
    await ItemRepo.upsertItems(mockDb.current, [item(14)], 1);
    mockProxy.item.mockReset();
    mockProxy.writeStock.mockReset();
  });
  afterEach(async () => {
    await act(async () => StockSheetController.close());
    mockDb.current?.close();
  });

  it('fetches fresh stock on open and writes ONLY after the Apply tap, with before → after', async () => {
    mockProxy.item.mockResolvedValue(item(14));
    mockProxy.writeStock.mockResolvedValue({ itemId: 'RICE', previousQuantity: 14, newQuantity: 16, auditId: 1, replayed: false });
    await renderHost();
    await act(async () => StockSheetController.open({ itemId: 'RICE', mode: 'edit', action: 'receive' }));
    await waitFor(() => expect(screen.getByText('Live from Clover')).toBeTruthy());
    expect(mockProxy.item).toHaveBeenCalledWith('RICE');

    await fireEvent.press(screen.getByRole('button', { name: 'Increase Quantity' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Increase Quantity' }));
    expect(screen.getByLabelText('Current 14 → New 16 (+2, Receive)')).toBeTruthy();
    expect(mockProxy.writeStock).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('apply'));
    await waitFor(() => expect(mockProxy.writeStock).toHaveBeenCalledTimes(1));
    expect(mockProxy.writeStock.mock.calls[0]?.[1]).toMatchObject({ expectedQuantity: 14, newQuantity: 16, action: 'receive' });
  });

  it('offline: shows cached value and disables Apply', async () => {
    mockProxy.item.mockRejectedValue(new ApiError('NETWORK', 'Network request failed', true));
    await renderHost();
    await act(async () => StockSheetController.open({ itemId: 'RICE', mode: 'edit', action: 'count' }));
    await waitFor(() => expect(screen.getByText('Cached, may be stale')).toBeTruthy());
    const apply = screen.getByTestId('apply');
    expect(apply.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(apply);
    expect(mockProxy.writeStock).not.toHaveBeenCalled();
  });

  it('409: shows the live value and requires a second tap to re-confirm', async () => {
    mockProxy.item.mockResolvedValue(item(14));
    mockProxy.writeStock
      .mockRejectedValueOnce(new ApiError('CONFLICT', 'changed', false, 409, 12))
      .mockResolvedValueOnce({ itemId: 'RICE', previousQuantity: 12, newQuantity: 13, auditId: 2, replayed: false });
    await renderHost();
    await act(async () => StockSheetController.open({ itemId: 'RICE', mode: 'edit', action: 'receive' }));
    await waitFor(() => screen.getByText('Live from Clover'));
    await fireEvent.press(screen.getByRole('button', { name: 'Increase Quantity' }));
    await fireEvent.press(screen.getByTestId('apply'));
    await waitFor(() => expect(screen.getByText(/Stock changed to 12 since you opened this/)).toBeTruthy());
    expect(screen.getByText(/Apply \+1 → 13\?/)).toBeTruthy();
    expect(mockProxy.writeStock).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Re-confirm and apply' }));
    await waitFor(() => expect(mockProxy.writeStock).toHaveBeenCalledTimes(2));
    expect(mockProxy.writeStock.mock.calls[1]?.[1]).toMatchObject({ expectedQuantity: 12, newQuantity: 13 });
    expect(mockProxy.writeStock.mock.calls[1]?.[1].clientMutationId).not.toBe(mockProxy.writeStock.mock.calls[0]?.[1].clientMutationId);
  });

  it('unknown outcome: marks Unconfirmed and does not retry', async () => {
    mockProxy.item.mockResolvedValueOnce(item(14)).mockResolvedValueOnce(item(15));
    mockProxy.writeStock.mockRejectedValue(new ApiError('NETWORK', 'Network request failed', true));
    await renderHost();
    await act(async () => StockSheetController.open({ itemId: 'RICE', mode: 'edit', action: 'receive' }));
    await waitFor(() => screen.getByText('Live from Clover'));
    await fireEvent.press(screen.getByRole('button', { name: 'Increase Quantity' }));
    await fireEvent.press(screen.getByTestId('apply'));
    await waitFor(() => expect(screen.getByText('Unconfirmed — the result is unknown')).toBeTruthy());
    expect(screen.getByText(/Live stock now: 15/)).toBeTruthy();
    expect(mockProxy.writeStock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('apply').props.accessibilityState).toMatchObject({ disabled: true });
  });
});

describe('StockSheet offline queue', () => {
  beforeEach(async () => {
    mockDb.current = await WasmSqlDb.migrated();
    await ItemRepo.upsertItems(mockDb.current, [item(14)], 1);
    mockProxy.item.mockReset().mockRejectedValue(new ApiError('NETWORK', 'Network request failed', true));
    mockProxy.writeStock.mockReset();
  });
  afterEach(async () => {
    await act(async () => StockSheetController.close());
    mockDb.current?.close();
  });

  it('queues a Receive as a delta (no write, no absolute value)', async () => {
    await renderHost();
    await act(async () => StockSheetController.open({ itemId: 'RICE', mode: 'edit', action: 'receive' }));
    await waitFor(() => screen.getByText('Cached, may be stale'));
    expect(screen.getByTestId('queue').props.accessibilityState).toMatchObject({ disabled: true }); // 0 → invalid
    await fireEvent.changeText(screen.getByLabelText('Type quantity'), '24');
    await fireEvent.press(screen.getByTestId('queue'));
    const rows = await mockDb.current!.all<Record<string, unknown>>('SELECT item_id, action, delta, status FROM queued_intents');
    expect(rows).toEqual([{ item_id: 'RICE', action: 'receive', delta: 24, status: 'queued' }]);
    expect(mockProxy.writeStock).not.toHaveBeenCalled();
  });

  it('Count cannot be queued offline', async () => {
    await renderHost();
    await act(async () => StockSheetController.open({ itemId: 'RICE', mode: 'edit', action: 'count' }));
    await waitFor(() => screen.getByText('Cached, may be stale'));
    expect(screen.queryByTestId('queue')).toBeNull();
    expect(screen.getByText(/Counts can’t be queued offline/)).toBeTruthy();
  });
});

describe('ConfirmCard', () => {
  it('uses destructive styling when lower or zero', async () => {
    await render(<ConfirmCard intent={{ action: 'count', amount: 0 }} before={4} />);
    expect(screen.getByTestId('confirm-card').props.className).toContain('border-danger');
    await render(<ConfirmCard intent={{ action: 'receive', amount: 3 }} before={4} />);
    expect(screen.getByTestId('confirm-card').props.className).not.toContain('border-danger');
  });
});

describe('write paths', () => {
  it('only StockWriter calls ProxyClient.writeStock, and only StockSheet calls StockWriter.apply', () => {
    const root = join(__dirname, '../../../..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === 'node_modules' || name === '__tests__') continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    walk(join(root, 'src'));
    walk(join(root, 'app'));
    const callers = (pattern: RegExp) =>
      files.filter((f) => pattern.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1)).sort();
    expect(callers(/\.writeStock\(/)).toEqual(['src/features/stock/StockWriter.ts']);
    // The single confirmed write path: the stock sheet's Apply tap and the batch confirmation screen (via BatchRunner).
    expect(callers(/StockWriter\.apply\(/)).toEqual(['src/features/batch/BatchRunner.ts', 'src/features/stock/StockSheet.tsx']);
  });
});

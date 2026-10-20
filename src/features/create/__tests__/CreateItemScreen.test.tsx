import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ItemRepo } from '../../../db/items';
import { SettingsRepo } from '../../../db/settings';
import { WasmSqlDb } from '../../../db/testing/wasmDb';

const mockDb: { current: WasmSqlDb | null } = { current: null };
const mockCreate = jest.fn();
const mockRouter = { back: jest.fn(), push: jest.fn(), replace: jest.fn() };

jest.mock('../../../db/ExpoSqlDb', () => ({ AppDatabase: { get: async () => mockDb.current } }));
jest.mock('../../../api/proxy', () => ({ ProxyClient: { createItem: (...a: unknown[]) => mockCreate(...a) } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${Math.random()}` }));
jest.mock('expo-haptics', () => ({ notificationAsync: jest.fn(), NotificationFeedbackType: { Success: 's', Warning: 'w', Error: 'e' } }));
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

// eslint-disable-next-line import/first
import { CreateItemScreen } from '../CreateItemScreen';

// gcTime: Infinity — the default 5-min GC timer would keep Jest alive after the run.
let client: QueryClient;
const renderScreen = () =>
  render(
    <QueryClientProvider client={(client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }))}>
      <CreateItemScreen code="012345678905" />
    </QueryClientProvider>,
  );

describe('CreateItemScreen', () => {
  beforeEach(async () => {
    mockDb.current = await WasmSqlDb.migrated();
    await ItemRepo.upsertCategories(mockDb.current, [{ id: 'CAT_BEV', name: 'Beverages', sortOrder: 1 }]);
    mockCreate.mockReset();
    mockRouter.replace.mockReset();
  });
  afterEach(() => {
    client.clear();
    mockDb.current?.close();
  });

  it('is off by default', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByText('Creating items is off')).toBeTruthy());
    expect(screen.queryByLabelText('Name')).toBeNull();
  });

  it('form → confirmation summary → one write → inserted and opened', async () => {
    await SettingsRepo.set(mockDb.current!, 'create_items_enabled', '1');
    await SettingsRepo.set(mockDb.current!, 'device_can_create', '1');
    mockCreate.mockImplementation(async (b: { name: string; priceCents: number; code: string }) => ({
      item: { id: 'NEW1', name: b.name, sku: null, code: b.code, priceCents: b.priceCents, costCents: null, categoryId: 'CAT_BEV', stockQty: 6, modifiedTime: 1, deleted: false },
      warnings: [], auditId: 3, replayed: false,
    }));
    await renderScreen();
    await waitFor(() => screen.getByLabelText('Name'));
    expect(screen.getByLabelText('UPC').props.value).toBe('012345678905'); // prefilled from scan

    await fireEvent.press(screen.getByTestId('create-review'));
    expect(screen.getByText('Name is required')).toBeTruthy(); // validation blocks the summary
    await fireEvent.changeText(screen.getByLabelText('Name'), 'Mango Lassi');
    await fireEvent.changeText(screen.getByLabelText('Price'), '$0.003499'); // typing 3,4,9 into "$0.00"
    expect(screen.getByLabelText('Price').props.value).toBe('$34.99');
    await fireEvent.changeText(screen.getByLabelText('Price'), '349');
    await fireEvent.press(screen.getByLabelText('Category Beverages'));
    await fireEvent.changeText(screen.getByLabelText('Initial stock'), '6');
    await fireEvent.press(screen.getByTestId('create-review'));

    expect(screen.getByText('Price: $3.49')).toBeTruthy();
    expect(screen.getByText('Category: Beverages')).toBeTruthy();
    expect(mockCreate).not.toHaveBeenCalled(); // nothing written before the confirmation tap

    await fireEvent.press(screen.getByTestId('create-confirm'));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/item/[id]', params: { id: 'NEW1' } }));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({ name: 'Mango Lassi', priceCents: 349, code: '012345678905', categoryId: 'CAT_BEV', initialStock: 6 });
    expect(await ItemRepo.byId(mockDb.current!, 'NEW1', 5)).toMatchObject({ name: 'Mango Lassi' });
  });

  it('unknown outcome is shown and not retried', async () => {
    const { ApiError } = jest.requireActual<typeof import('../../../lib/errors')>('../../../lib/errors');
    await SettingsRepo.set(mockDb.current!, 'create_items_enabled', '1');
    await SettingsRepo.set(mockDb.current!, 'device_can_create', '1');
    mockCreate.mockRejectedValue(new ApiError('NETWORK', 'Network request failed', true));
    await renderScreen();
    await waitFor(() => screen.getByLabelText('Name'));
    await fireEvent.changeText(screen.getByLabelText('Name'), 'Lassi');
    await fireEvent.press(screen.getByTestId('create-review'));
    await fireEvent.press(screen.getByTestId('create-confirm'));
    await waitFor(() => expect(screen.getByText('Unconfirmed — the item may or may not exist')).toBeTruthy());
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('create-confirm').props.accessibilityState).toMatchObject({ disabled: true });
  });
});

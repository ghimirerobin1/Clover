import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { Barcode } from '../../../lib/barcode';
import { Keypad, KeypadInput, MAX_MANUAL_LENGTH } from '../Keypad';
import { NotFound, WeightedNote } from '../ScanSheets';

jest.mock('../../../db/ExpoSqlDb', () => ({ AppDatabase: { get: jest.fn() } }));

const handlers = () => ({
  onSearch: jest.fn(),
  onLinked: jest.fn(),
  onCreate: jest.fn(),
  onScanNext: jest.fn(),
});

describe('NotFound sheet', () => {
  it('offers search and link; hides create unless enabled', async () => {
    const h = handlers();
    await render(<NotFound barcode={Barcode.normalize('96385074')} remoteError={null} canCreate={false} {...h} />);
    expect(screen.getByText('No item for 96385074')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Search manually' }));
    expect(h.onSearch).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Create in Clover' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Link to existing item' })).toBeTruthy();
  });

  it('shows create when enabled, and warnings', async () => {
    const h = handlers();
    await render(<NotFound barcode={Barcode.normalize('036000291453')} remoteError="offline" canCreate {...h} />);
    fireEvent.press(screen.getByRole('button', { name: 'Create in Clover' }));
    expect(h.onCreate).toHaveBeenCalled();
    expect(screen.getByText(/Check digit is invalid/)).toBeTruthy();
    expect(screen.getByText(/Couldn’t check Clover: offline/)).toBeTruthy();
  });

  it('switches to the link picker', async () => {
    await render(
      <QueryClientProvider client={new QueryClient()}>
        <NotFound barcode={Barcode.normalize('96385074')} remoteError={null} canCreate={false} {...handlers()} />
      </QueryClientProvider>,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Link to existing item' }));
    expect(screen.getByLabelText('Search item to link')).toBeTruthy();
  });
});

describe('WeightedNote', () => {
  it('renders only for variable-weight codes', async () => {
    await render(<WeightedNote barcode={Barcode.normalize(Barcode.withCheckDigit('20123401299'))} />);
    expect(screen.getByText('Weighted item — stock tracked by unit')).toBeTruthy();
    await render(<WeightedNote barcode={Barcode.normalize('036000291452')} />);
    expect(screen.queryByText('Weighted item — stock tracked by unit')).toBeNull();
  });
});

describe('Keypad', () => {
  it('edits the value', () => {
    expect(KeypadInput.press('12', '3')).toBe('123');
    expect(KeypadInput.press('123', 'back')).toBe('12');
    expect(KeypadInput.press('123', 'clear')).toBe('');
    expect(KeypadInput.press('', 'back')).toBe('');
    expect(KeypadInput.press('1'.repeat(MAX_MANUAL_LENGTH), '2')).toHaveLength(MAX_MANUAL_LENGTH);
  });

  it('emits presses', async () => {
    const onChange = jest.fn();
    await render(<Keypad value="4" onChange={onChange} />);
    fireEvent.press(screen.getByRole('button', { name: '7' }));
    expect(onChange).toHaveBeenLastCalledWith('47');
    fireEvent.press(screen.getByRole('button', { name: 'Delete digit' }));
    expect(onChange).toHaveBeenLastCalledWith('');
  });
});

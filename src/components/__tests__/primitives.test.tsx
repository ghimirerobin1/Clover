import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Badge, BadgeStyles, Button, ButtonStyles, EmptyState, Sheet, Skeleton, Stepper, StepperMath } from '..';

describe('Button', () => {
  it('fires onPress and exposes an accessible label', async () => {
    const onPress = jest.fn();
    await render(<Button label="Apply" onPress={onPress} />);
    fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not fire when disabled or loading', async () => {
    const onPress = jest.fn();
    await render(
      <>
        <Button label="A" onPress={onPress} disabled />
        <Button label="B" onPress={onPress} loading />
      </>,
    );
    fireEvent.press(screen.getByRole('button', { name: 'A' }));
    fireEvent.press(screen.getByRole('button', { name: 'B' }));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('uses 56pt height for lg and destructive tone', () => {
    expect(ButtonStyles.container('destructive', 'lg', false)).toContain('min-h-primary');
    expect(ButtonStyles.container('destructive', 'lg', false)).toContain('bg-danger');
    expect(ButtonStyles.container('primary', 'md', true)).toContain('opacity-50');
  });
});

describe('Badge', () => {
  it('renders its label', async () => {
    await render(<Badge label="14" tone="success" />);
    expect(screen.getByText('14')).toBeTruthy();
  });

  it.each([
    [-1, 5, 'danger'],
    [0, 5, 'danger'],
    [5, 5, 'warning'],
    [6, 5, 'success'],
  ] as const)('qty %d threshold %d -> %s', (qty, threshold, tone) => {
    expect(BadgeStyles.toneForStock(qty, threshold)).toBe(tone);
  });
});

describe('Stepper', () => {
  it('increments and decrements within bounds', async () => {
    const onChange = jest.fn();
    await render(<Stepper label="Quantity" value={0} min={0} max={10} onChange={onChange} testID="s" />);
    fireEvent.press(screen.getByRole('button', { name: 'Increase Quantity' }));
    expect(onChange).toHaveBeenLastCalledWith(1);
    fireEvent.press(screen.getByRole('button', { name: 'Decrease Quantity' }));
    // At min: decrement is disabled.
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('clamps and rounds', () => {
    expect(StepperMath.clamp(12.6, 0, 10)).toBe(10);
    expect(StepperMath.clamp(-3, 0, 10)).toBe(0);
    expect(StepperMath.next(4, 2.4, 0, 100)).toBe(6);
  });
});

describe('EmptyState', () => {
  it('shows a next action', async () => {
    const onAction = jest.fn();
    await render(<EmptyState title="No items" message="Sync to begin" actionLabel="Sync now" onAction={onAction} />);
    expect(screen.getByText('No items')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Sync now' }));
    expect(onAction).toHaveBeenCalled();
  });
});

describe('Skeleton', () => {
  it('renders N placeholder lines with a loading label', async () => {
    await render(<Skeleton lines={3} testID="sk" />);
    expect(screen.getByLabelText('Loading')).toBeTruthy();
  });
});

describe('Sheet', () => {
  it('renders children when visible and closes from backdrop', async () => {
    const onClose = jest.fn();
    await render(
      <SafeAreaProvider
        initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}
      >
        <Sheet visible onClose={onClose} title="Receive" testID="sheet">
          <Text>Body</Text>
        </Sheet>
      </SafeAreaProvider>,
    );
    expect(screen.getByText('Receive')).toBeTruthy();
    expect(screen.getByText('Body')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    // Backdrop is intentionally hidden from a11y (modal content); query it explicitly.
    fireEvent.press(screen.getByTestId('sheet-backdrop', { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

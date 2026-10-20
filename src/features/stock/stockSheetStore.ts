import { create } from 'zustand';

import type { StockAction } from '../../api/schemas';

export type StockSheetRequest =
  | { itemId: string; mode: 'edit'; action: Exclude<StockAction, 'undo'> }
  | { itemId: string; mode: 'undo'; change: { before: number; after: number; action: StockAction } };

interface StockSheetState {
  request: (StockSheetRequest & { key: number }) | null;
}

export const useStockSheetStore = create<StockSheetState>(() => ({ request: null }));
let key = 1;

/** Opens the single app-wide stock sheet (mounted by StockSheetHost at the root). */
export class StockSheetController {
  static open(req: StockSheetRequest): void {
    useStockSheetStore.setState({ request: { ...req, key: key++ } });
  }

  static close(): void {
    useStockSheetStore.setState({ request: null });
  }
}

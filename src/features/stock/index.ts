/** Public API of the stock feature. Other features import only from here (spec §2). */
export { StockSheetController, type StockSheetRequest } from './stockSheetStore';
export { ACTION_LABEL, REASON_LABEL, StockMath, type StockIntent } from './StockMath';
export { StockWriter, type StockApi, type WriteOutcome } from './StockWriter';

import { z } from 'zod';

/** zod schemas for every proxy response (spec §1: fail loudly on unexpected payloads). */
export const ItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  sku: z.string().nullable(),
  code: z.string().nullable(),
  priceCents: z.number().int(),
  costCents: z.number().int().nullable(),
  categoryId: z.string().nullable(),
  stockQty: z.number().nullable(),
  modifiedTime: z.number().int(),
  deleted: z.boolean(),
});
export type RemoteItem = z.infer<typeof ItemSchema>;

export const ItemPageSchema = z.object({
  items: z.array(ItemSchema),
  offset: z.number().int(),
  limit: z.number().int(),
  hasMore: z.boolean(),
});
export type ItemPage = z.infer<typeof ItemPageSchema>;

export const CategorySchema = z.object({ id: z.string(), name: z.string(), sortOrder: z.number().int().nullable() });
export type RemoteCategory = z.infer<typeof CategorySchema>;
export const CategoryListSchema = z.object({ categories: z.array(CategorySchema) });

export const DeviceSchema = z.object({ id: z.string(), name: z.string(), canCreateItems: z.boolean() });
export const PairResultSchema = z.object({ appKey: z.string().min(16), device: DeviceSchema });
export type PairResult = z.infer<typeof PairResultSchema>;

export const LookupResultSchema = z.object({ match: ItemSchema.nullable(), candidates: z.array(ItemSchema) });
export type LookupResult = z.infer<typeof LookupResultSchema>;

export const STOCK_ACTIONS = ['receive', 'count', 'adjust', 'undo'] as const;
export type StockAction = (typeof STOCK_ACTIONS)[number];
export const ADJUST_REASONS = ['damaged', 'expired', 'theft_loss', 'correction', 'other'] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number];

export interface StockWriteRequest {
  expectedQuantity: number;
  newQuantity: number;
  action: StockAction;
  reason?: AdjustReason;
  note?: string;
  clientMutationId: string;
}

export const StockWriteResultSchema = z.object({
  itemId: z.string(),
  previousQuantity: z.number(),
  newQuantity: z.number(),
  auditId: z.number().int(),
  replayed: z.boolean(),
});
export type StockWriteResult = z.infer<typeof StockWriteResultSchema>;

export const AuditEntrySchema = z.object({
  id: z.number().int(),
  itemId: z.string(),
  itemName: z.string().nullable(),
  action: z.string(),
  beforeQty: z.number().nullable(),
  afterQty: z.number().nullable(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  status: z.string(),
  deviceId: z.string(),
  deviceName: z.string().nullable(),
  clientMutationId: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export const AuditPageSchema = z.object({ entries: z.array(AuditEntrySchema), nextBefore: z.number().int().nullable() });
export type AuditPage = z.infer<typeof AuditPageSchema>;

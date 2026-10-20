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

import { z } from 'zod';

import { API_ERROR_CODES, ApiError } from '../lib/errors';
import { DeviceKey } from './deviceKey';
import {
  CategoryListSchema,
  ItemPageSchema,
  ItemSchema,
  LookupResultSchema,
  AuditPageSchema,
  StockWriteResultSchema,
  CreateItemResultSchema,
  DeviceSchema,
  ThresholdMapSchema,
  type CreateItemRequest,
  type CreateItemResult,
  type Device,
  type ThresholdMap,
  type ThresholdScope,
  type AuditPage,
  type StockWriteRequest,
  type StockWriteResult,
  PairResultSchema,
  type ItemPage,
  type LookupResult,
  type PairResult,
  type RemoteCategory,
  type RemoteItem,
} from './schemas';

/**
 * Typed client for the Stockroom proxy. This folder is the ONLY place the app talks HTTP.
 * The app never holds a Clover token or merchant id — only the proxy URL and a per-device key.
 */
const HealthSchema = z.object({
  status: z.literal('ok'),
  mock: z.boolean(),
  version: z.string(),
});
export type Health = z.infer<typeof HealthSchema>;

const ErrorBodySchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    retryable: z.boolean(),
    currentQuantity: z.number().optional(),
  }),
});

/** Single location for now; multi-location becomes a picker that changes this id. */
export const DEFAULT_LOCATION = 'default';

export interface RequestOptions {
  fetchImpl?: typeof fetch;
  /** Override the stored device key (tests). `null` = send no key. */
  appKey?: string | null;
}

export class ProxyClient {
  /** Proxy URL is not a secret; it is fine for it to live in the bundle. */
  static baseUrl(): string {
    return process.env.EXPO_PUBLIC_PROXY_URL ?? 'http://localhost:8000';
  }

  static async health(fetchImpl: typeof fetch = fetch): Promise<Health> {
    const body = await ProxyClient.request('GET', '/health', { fetchImpl, appKey: null });
    return HealthSchema.parse(body);
  }

  static async pair(code: string, deviceName: string, opts: RequestOptions = {}): Promise<PairResult> {
    const body = await ProxyClient.request('POST', '/pair', { ...opts, appKey: null }, { code, deviceName });
    return PairResultSchema.parse(body);
  }

  static async items(
    params: { limit: number; offset: number; modifiedSince?: number },
    opts: RequestOptions = {},
  ): Promise<ItemPage> {
    const q = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
    if (params.modifiedSince != null) q.set('modifiedSince', String(params.modifiedSince));
    const body = await ProxyClient.request('GET', `/locations/${DEFAULT_LOCATION}/items?${q.toString()}`, opts);
    return ItemPageSchema.parse(body);
  }

  /** Always fresh from Clover via the proxy (never cached server-side). */
  static async item(id: string, opts: RequestOptions = {}): Promise<RemoteItem> {
    const body = await ProxyClient.request('GET', `/locations/${DEFAULT_LOCATION}/items/${encodeURIComponent(id)}`, opts);
    return ItemSchema.parse(body);
  }

  /** Proxy-side lookup by code (UPC/EAN variants) then SKU. */
  static async lookup(code: string, opts: RequestOptions = {}): Promise<LookupResult> {
    const q = new URLSearchParams({ code });
    const body = await ProxyClient.request('GET', `/locations/${DEFAULT_LOCATION}/items/lookup?${q.toString()}`, opts);
    return LookupResultSchema.parse(body);
  }

  /**
   * Absolute stock write guarded by expectedQuantity. Single attempt — callers must never retry automatically.
   * Only StockWriter calls this, and only after the user taps a before → after confirmation.
   */
  static async writeStock(itemId: string, body: StockWriteRequest, opts: RequestOptions = {}): Promise<StockWriteResult> {
    const res = await ProxyClient.request(
      'POST',
      `/locations/${DEFAULT_LOCATION}/stock/${encodeURIComponent(itemId)}`,
      opts,
      body,
    );
    return StockWriteResultSchema.parse(res);
  }

  static async audit(
    params: { itemId?: string; action?: string; since?: string; before?: number; limit?: number } = {},
    opts: RequestOptions = {},
  ): Promise<AuditPage> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null) q.set(k, String(v));
    const body = await ProxyClient.request('GET', `/locations/${DEFAULT_LOCATION}/audit?${q.toString()}`, opts);
    return AuditPageSchema.parse(body);
  }

  /** This device's key and permissions (canCreateItems). */
  static async me(opts: RequestOptions = {}): Promise<Device> {
    return DeviceSchema.parse(await ProxyClient.request('GET', '/me', opts));
  }

  /**
   * Gated item creation. Single attempt with an idempotency key — never retried automatically.
   * Only CreateItemWriter calls this, after the user taps the confirmation summary.
   */
  static async createItem(body: CreateItemRequest, opts: RequestOptions = {}): Promise<CreateItemResult> {
    const res = await ProxyClient.request('POST', `/locations/${DEFAULT_LOCATION}/items`, opts, body);
    return CreateItemResultSchema.parse(res);
  }

  /** Shared low-stock thresholds (stored on the proxy, never in Clover). */
  static async thresholds(opts: RequestOptions = {}): Promise<ThresholdMap> {
    return ThresholdMapSchema.parse(await ProxyClient.request('GET', `/locations/${DEFAULT_LOCATION}/thresholds`, opts));
  }

  static async putThreshold(scope: ThresholdScope, id: string, threshold: number | null, opts: RequestOptions = {}): Promise<ThresholdMap> {
    const res = await ProxyClient.request(
      'PUT',
      `/locations/${DEFAULT_LOCATION}/thresholds/${scope}/${encodeURIComponent(id)}`,
      opts,
      { threshold },
    );
    return ThresholdMapSchema.parse(res);
  }

  static async categories(opts: RequestOptions = {}): Promise<RemoteCategory[]> {
    const body = await ProxyClient.request('GET', `/locations/${DEFAULT_LOCATION}/categories`, opts);
    return CategoryListSchema.parse(body).categories;
  }

  private static async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    opts: RequestOptions,
    json?: unknown,
  ): Promise<unknown> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const appKey = opts.appKey === undefined ? await DeviceKey.get() : opts.appKey;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (appKey) headers['X-App-Key'] = appKey;
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetchImpl(`${ProxyClient.baseUrl()}${path}`, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
      });
    } catch (e) {
      throw new ApiError('NETWORK', e instanceof Error ? e.message : 'Network request failed', true);
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const parsed = ErrorBodySchema.safeParse(body);
      if (parsed.success) {
        const { code, message, retryable, currentQuantity } = parsed.data.error;
        throw new ApiError(code, message, retryable, res.status, currentQuantity);
      }
      throw new ApiError('UPSTREAM', `Unexpected response (${res.status})`, res.status >= 500, res.status);
    }
    return body;
  }
}

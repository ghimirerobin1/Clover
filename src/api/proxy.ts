import { z } from 'zod';

import { API_ERROR_CODES, ApiError } from '../lib/errors';
import { DeviceKey } from './deviceKey';
import {
  CategoryListSchema,
  ItemPageSchema,
  ItemSchema,
  PairResultSchema,
  type ItemPage,
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

  static async categories(opts: RequestOptions = {}): Promise<RemoteCategory[]> {
    const body = await ProxyClient.request('GET', `/locations/${DEFAULT_LOCATION}/categories`, opts);
    return CategoryListSchema.parse(body).categories;
  }

  private static async request(
    method: 'GET' | 'POST',
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
        const { code, message, retryable } = parsed.data.error;
        throw new ApiError(code, message, retryable, res.status);
      }
      throw new ApiError('UPSTREAM', `Unexpected response (${res.status})`, res.status >= 500, res.status);
    }
    return body;
  }
}

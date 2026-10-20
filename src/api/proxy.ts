import { z } from 'zod';

import { API_ERROR_CODES, ApiError } from '../lib/errors';

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

export class ProxyClient {
  /** Proxy URL is not a secret; it is fine for it to live in the bundle. */
  static baseUrl(): string {
    return process.env.EXPO_PUBLIC_PROXY_URL ?? 'http://localhost:8000';
  }

  static async health(fetchImpl: typeof fetch = fetch): Promise<Health> {
    const body = await ProxyClient.request('/health', fetchImpl);
    return HealthSchema.parse(body);
  }

  private static async request(path: string, fetchImpl: typeof fetch): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${ProxyClient.baseUrl()}${path}`, { headers: { Accept: 'application/json' } });
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

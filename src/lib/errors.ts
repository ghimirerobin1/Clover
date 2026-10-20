/** Stable error shape shared with the proxy (spec §3). */
export const API_ERROR_CODES = ['NOT_FOUND', 'RATE_LIMITED', 'CONFLICT', 'AUTH', 'UPSTREAM', 'VALIDATION'] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode | 'NETWORK',
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    /** Present on stock-write 409s: the live Clover quantity the write was rejected against. */
    readonly currentQuantity?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

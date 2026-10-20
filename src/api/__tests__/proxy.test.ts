import { ApiError } from '../../lib/errors';
import { ProxyClient } from '../proxy';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return jest.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('ProxyClient.health', () => {
  it('parses a healthy response', async () => {
    await expect(ProxyClient.health(fakeFetch(200, { status: 'ok', mock: true, version: '0.1.0' }))).resolves.toEqual({
      status: 'ok',
      mock: true,
      version: '0.1.0',
    });
  });

  it('maps the stable error shape', async () => {
    const err = await ProxyClient.health(
      fakeFetch(401, { error: { code: 'AUTH', message: 'Bad key', retryable: false } }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'AUTH', retryable: false, status: 401 });
  });

  it('maps network failures to NETWORK', async () => {
    const failing = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    await expect(ProxyClient.health(failing)).rejects.toMatchObject({ code: 'NETWORK', retryable: true });
  });
});

describe('ProxyClient catalog calls', () => {
  const item = {
    id: 'A', name: 'Rice', sku: null, code: '0744', priceCents: 2899, costCents: null,
    categoryId: null, stockQty: 4, modifiedTime: 5, deleted: false,
  };

  it('sends X-App-Key and modifiedSince, parses the page', async () => {
    const f = fakeFetch(200, { items: [item], offset: 0, limit: 1000, hasMore: false });
    const page = await ProxyClient.items({ limit: 1000, offset: 0, modifiedSince: 42 }, { fetchImpl: f, appKey: 'k'.repeat(20) });
    expect(page.items[0]?.priceCents).toBe(2899);
    const [url, init] = (f as unknown as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/locations/default/items?limit=1000&offset=0&modifiedSince=42');
    expect((init.headers as Record<string, string>)['X-App-Key']).toBe('k'.repeat(20));
  });

  it('rejects float prices (money is integer cents)', async () => {
    const f = fakeFetch(200, { ...item, priceCents: 28.99 });
    await expect(ProxyClient.item('A', { fetchImpl: f, appKey: 'k' })).rejects.toThrow();
  });

  it('pair posts JSON without a key', async () => {
    const f = fakeFetch(200, { appKey: 'x'.repeat(43), device: { id: 'd', name: 'Front', canCreateItems: false } });
    await ProxyClient.pair('1234 5678', 'Front', { fetchImpl: f });
    const [, init] = (f as unknown as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ code: '1234 5678', deviceName: 'Front' });
    expect((init.headers as Record<string, string>)['X-App-Key']).toBeUndefined();
  });
});

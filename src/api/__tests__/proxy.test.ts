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

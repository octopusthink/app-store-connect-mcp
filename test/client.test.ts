import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { TokenProvider } from '../src/auth.ts';
import { API_ORIGIN, ApiError, AscClient } from '../src/client.ts';
import { json, makeClient, makeCredentials, mockFetch } from './helpers.ts';

describe('AscClient.buildUrl', () => {
  it('encodes query values and skips empty ones', () => {
    const url = AscClient.buildUrl('/v1/apps', {
      'filter[bundleId]': 'com.example.app',
      'fields[apps]': ['name', 'sku'],
      limit: 10,
      'exists[x]': false,
      skipped: undefined,
      alsoSkipped: null,
    });
    expect(url.origin).toBe(API_ORIGIN);
    expect(url.pathname).toBe('/v1/apps');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'filter[bundleId]': 'com.example.app',
      'fields[apps]': 'name,sku',
      limit: '10',
      'exists[x]': 'false',
    });
  });

  it('accepts full URLs on the API host, such as pagination links', () => {
    const url = AscClient.buildUrl(`${API_ORIGIN}/v1/apps?cursor=abc&limit=50`);
    expect(url.searchParams.get('cursor')).toBe('abc');
  });

  it.each([
    'https://example.com/v1/apps',
    '//example.com/v1/apps',
    'http://api.appstoreconnect.apple.com/v1/apps',
    'https://api.appstoreconnect.apple.com.evil.test/v1/apps',
  ])('refuses to send credentials to %s', (path) => {
    expect(() => AscClient.buildUrl(path)).toThrow(/Refusing/);
  });
});

describe('AscClient.request', () => {
  it('sends a bearer token and JSON body', async () => {
    const { fetch, requests } = mockFetch(() => json({ data: { type: 'apps', id: '1' } }, 201));
    const client = makeClient(fetch);
    const response = await client.request({
      method: 'POST',
      path: '/v1/things',
      body: { data: { type: 'x' } },
    });

    expect(response.status).toBe(201);
    expect(response.data).toEqual({ data: { type: 'apps', id: '1' } });
    const [request] = requests;
    expect(request?.method).toBe('POST');
    expect(request?.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.body).toEqual({ data: { type: 'x' } });
  });

  it('refreshes the token once after a 401', async () => {
    const tokens = new TokenProvider(makeCredentials());
    const invalidate = vi.spyOn(tokens, 'invalidate');
    const { fetch, requests } = mockFetch(
      () => json({ errors: [{ status: '401', code: 'NOT_AUTHORIZED' }] }, 401),
      () => json({ data: [] }),
    );
    const client = new AscClient({ tokens, fetch });

    await expect(client.get('/v1/apps')).resolves.toEqual({ data: [] });
    expect(requests).toHaveLength(2);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('gives up after a second 401 with a credentials hint', async () => {
    const { fetch } = mockFetch(
      () =>
        json(
          {
            errors: [
              {
                status: '401',
                code: 'NOT_AUTHORIZED',
                title: 'Authentication credentials are missing or invalid.',
              },
            ],
          },
          401,
        ),
      () =>
        json(
          {
            errors: [
              {
                status: '401',
                code: 'NOT_AUTHORIZED',
                title: 'Authentication credentials are missing or invalid.',
              },
            ],
          },
          401,
        ),
    );
    const error = await makeClient(fetch)
      .get('/v1/apps')
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(error.message).toContain('NOT_AUTHORIZED');
    expect(error.message).toContain('Issuer ID, Key ID and private key');
  });

  it('retries rate-limited requests, honoring Retry-After', async () => {
    const sleep = vi.fn(async () => {});
    const { fetch, requests } = mockFetch(
      () => json({ errors: [] }, 429, { 'retry-after': '2' }),
      () => json({ data: [] }),
    );
    const client = new AscClient({ tokens: new TokenProvider(makeCredentials()), fetch, sleep });

    await client.post('/v1/things', {});
    expect(requests).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('retries server errors on GET but not on POST', async () => {
    const getFetch = mockFetch(
      () => json({}, 503),
      () => json({ data: [] }),
    );
    await makeClient(getFetch.fetch).get('/v1/apps');
    expect(getFetch.requests).toHaveLength(2);

    const postFetch = mockFetch(() => json({ errors: [{ title: 'Oops' }] }, 500));
    await expect(makeClient(postFetch.fetch).post('/v1/things', {})).rejects.toThrow(
      'returned 500',
    );
    expect(postFetch.requests).toHaveLength(1);
  });

  it('stops retrying after maxRetries', async () => {
    const { fetch, requests } = mockFetch(
      ...Array.from(
        { length: 4 },
        () => () => json({}, 429, { 'x-rate-limit': 'user-hour-lim:3600;user-hour-rem:0;' }),
      ),
    );
    const error = await makeClient(fetch)
      .get('/v1/apps')
      .catch((caught) => caught);
    expect(requests).toHaveLength(4);
    expect(error.message).toContain('user-hour-rem:0');
  });

  it('formats JSON:API errors with codes and sources', async () => {
    const { fetch } = mockFetch(() =>
      json(
        {
          errors: [
            {
              status: '409',
              code: 'ENTITY_ERROR.ATTRIBUTE.INVALID',
              title: 'An attribute value is invalid.',
              detail: 'The version string must be greater than the previous version.',
              source: { pointer: '/data/attributes/versionString' },
            },
          ],
        },
        409,
      ),
    );
    await expect(makeClient(fetch).post('/v1/appStoreVersions', {})).rejects.toThrow(
      'An attribute value is invalid.: The version string must be greater than the previous version. (ENTITY_ERROR.ATTRIBUTE.INVALID) [at /data/attributes/versionString]',
    );
  });

  it('unzips gzip report downloads', async () => {
    const report = 'Provider\tSKU\tUnits\nAPPLE\tcom.example\t3\n';
    const { fetch, requests } = mockFetch(
      () => new Response(gzipSync(report), { headers: { 'content-type': 'application/a-gzip' } }),
    );
    const response = await makeClient(fetch).request({
      path: '/v1/salesReports',
      accept: 'application/a-gzip',
    });
    expect(response.data).toBe(report);
    expect(requests[0]?.headers.accept).toBe('application/a-gzip');
  });

  it('returns null data for 204 responses', async () => {
    const { fetch } = mockFetch(() => new Response(null, { status: 204 }));
    const response = await makeClient(fetch).request({ method: 'DELETE', path: '/v1/things/1' });
    expect(response).toMatchObject({ status: 204, data: null });
  });
});

describe('AscClient.paginate', () => {
  const page = (ids: string[], next?: string) =>
    json({
      data: ids.map((id) => ({ type: 'apps', id })),
      links: next ? { next } : {},
      meta: { paging: { total: 5 } },
    });

  it('follows next links up to maxItems', async () => {
    const { fetch, requests } = mockFetch(
      () => page(['1', '2'], `${API_ORIGIN}/v1/apps?cursor=2&limit=2`),
      () => page(['3', '4'], `${API_ORIGIN}/v1/apps?cursor=4&limit=2`),
    );
    const result = await makeClient(fetch).paginate('/v1/apps', { limit: 2 }, 4);

    expect(result.data.map((item) => item.id)).toEqual(['1', '2', '3', '4']);
    expect(result.next).toBe(`${API_ORIGIN}/v1/apps?cursor=4&limit=2`);
    expect(result.total).toBe(5);
    expect(requests[1]?.url.searchParams.get('cursor')).toBe('2');
  });

  it('stops when there are no more pages', async () => {
    const { fetch } = mockFetch(() => page(['1']));
    const result = await makeClient(fetch).paginate('/v1/apps', {}, 100);
    expect(result.data).toHaveLength(1);
    expect(result.next).toBeUndefined();
  });
});

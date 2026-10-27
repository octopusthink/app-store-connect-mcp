import { describe, expect, it } from 'vitest';
import { ApiSpec } from '../src/spec.ts';

const spec = new ApiSpec();

describe('ApiSpec', () => {
  it('loads the bundled specification', () => {
    expect(spec.version).toMatch(/^\d+\.\d+/);
  });

  it.each([
    ['customer reviews', 'GET', '/v1/apps/{id}/customerReviews'],
    ['respond to review', 'POST', '/v1/customerReviewResponses'],
    ['testflight testers', 'GET', '/v1/betaTesters'],
    ["what's new", 'PATCH', '/v1/appStoreVersionLocalizations/{id}'],
    ['phased release', 'POST', '/v1/appStoreVersionPhasedReleases'],
    ['sales report', 'GET', '/v1/salesReports'],
  ])('finds %s', (query, method, path) => {
    const results = spec.search(query, { limit: 20 });
    expect(results).toContainEqual(expect.objectContaining({ method, path }));
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'handles the query %s without hitting Object.prototype',
    (query) => {
      expect(() => spec.search(query)).not.toThrow();
    },
  );

  it('filters search results by method', () => {
    const results = spec.search('beta groups', { method: 'DELETE' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.method === 'DELETE')).toBe(true);
  });

  it('matches concrete paths to templates', () => {
    expect(spec.find('GET', '/v1/apps/6446/customerReviews?limit=5')?.path).toBe(
      '/v1/apps/{id}/customerReviews',
    );
    expect(spec.find('GET', 'https://api.appstoreconnect.apple.com/v1/apps/6446')?.path).toBe(
      '/v1/apps/{id}',
    );
    expect(spec.find('PUT' as never, '/v1/apps')).toBeUndefined();
  });

  it('describes request bodies with references resolved', () => {
    const description = spec.describe('POST', '/v1/customerReviewResponses');
    expect(description).toMatchObject({ operationId: 'customerReviewResponses_createInstance' });
    const body = JSON.stringify(description?.requestBody);
    expect(body).toContain('"responseBody"');
    expect(body).toContain('"customerReviews"');
    expect(body).not.toContain('$ref');
  });

  it('summarizes fields[...] parameters unless verbose', () => {
    const brief = spec.describe('GET', '/v1/apps');
    expect(brief?.sparseFieldsets).toContain('fields[apps]');
    expect(brief?.queryParameters.some((parameter) => parameter.name.startsWith('fields['))).toBe(
      false,
    );
    expect(brief?.queryParameters).toContainEqual(
      expect.objectContaining({ name: 'sort', values: expect.arrayContaining(['name', '-name']) }),
    );

    const verbose = spec.describe('GET', '/v1/apps', { verbose: true });
    expect(verbose?.sparseFieldsets).toBeUndefined();
    expect(verbose?.queryParameters).toContainEqual(
      expect.objectContaining({ name: 'fields[apps]' }),
    );
  });
});

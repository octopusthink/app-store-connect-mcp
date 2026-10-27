import { describe, expect, it } from 'vitest';
import { flattenResource, renderOutput, simplifyDocument } from '../src/format.ts';

describe('flattenResource', () => {
  it('lifts attributes and reduces relationships to IDs', () => {
    expect(
      flattenResource({
        type: 'builds',
        id: 'b1',
        attributes: { version: '42', expired: false },
        relationships: {
          app: { data: { type: 'apps', id: 'a1' }, links: { related: 'https://…' } },
          betaGroups: {
            data: [
              { type: 'betaGroups', id: 'g1' },
              { type: 'betaGroups', id: 'g2' },
            ],
          },
          appStoreVersion: { data: null },
          icons: { links: { related: 'https://…' } },
        },
        links: { self: 'https://…' },
      }),
    ).toEqual({
      id: 'b1',
      type: 'builds',
      version: '42',
      expired: false,
      app: 'a1',
      betaGroups: ['g1', 'g2'],
      appStoreVersion: null,
    });
  });
});

describe('simplifyDocument', () => {
  it('returns items, included resources grouped by type, total and next cursor', () => {
    expect(
      simplifyDocument({
        data: [{ type: 'apps', id: '1', attributes: { name: 'One' } }],
        included: [
          { type: 'appInfos', id: 'i1', attributes: { state: 'READY_FOR_DISTRIBUTION' } },
          { type: 'appInfos', id: 'i1', attributes: { state: 'READY_FOR_DISTRIBUTION' } },
        ],
        links: { self: 'x', next: 'https://api.appstoreconnect.apple.com/v1/apps?cursor=2' },
        meta: { paging: { total: 9 } },
      }),
    ).toEqual({
      items: [{ id: '1', type: 'apps', name: 'One' }],
      included: { appInfos: [{ id: 'i1', type: 'appInfos', state: 'READY_FOR_DISTRIBUTION' }] },
      total: 9,
      nextCursor: 'https://api.appstoreconnect.apple.com/v1/apps?cursor=2',
    });
  });

  it('handles single resources', () => {
    expect(simplifyDocument({ data: { type: 'apps', id: '1' } })).toEqual({
      item: { id: '1', type: 'apps' },
    });
  });
});

describe('renderOutput', () => {
  it('serializes values and passes strings through', () => {
    expect(renderOutput({ a: 1 })).toBe('{"a":1}');
    expect(renderOutput('a\tb')).toBe('a\tb');
  });

  it('truncates long output with a note', () => {
    const output = renderOutput('x'.repeat(150), 100);
    expect(output.startsWith('x'.repeat(100))).toBe(true);
    expect(output).toContain('50 more characters');
  });
});

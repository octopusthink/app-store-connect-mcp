import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ENV, loadConfig, parsePrivateKey } from '../src/config.ts';
import { ISSUER_ID, KEY_ID, makeKeyPair } from './helpers.ts';

describe('parsePrivateKey', () => {
  const { pem, publicKey } = makeKeyPair();
  const body = pem
    .split('\n')
    .filter((line) => line && !line.startsWith('-----'))
    .join('');
  const expectedPublic = publicKey.export({ type: 'spki', format: 'der' });

  it.each([
    ['a multi-line PEM', pem],
    ['a PEM with literal \\n escapes', pem.replace(/\n/g, '\\n')],
    ['a PEM collapsed onto one line', pem.replace(/\n/g, ' ')],
    ['the bare base64 body', body],
    ['a quoted PEM', `"${pem.replace(/\n/g, '\\n')}"`],
    ['a PEM with Windows line endings', pem.replace(/\n/g, '\r\n')],
  ])('accepts %s', (_, input) => {
    const key = parsePrivateKey(input);
    // The parsed key matches the original pair.
    expect(createPublicKey(key).export({ type: 'spki', format: 'der' })).toEqual(expectedPublic);
  });

  it('rejects text that is not a key', () => {
    expect(() => parsePrivateKey('not a key at all!')).toThrow(ENV.privateKey);
    expect(() => parsePrivateKey('QUJD')).toThrow(/could not be read/);
  });

  it('rejects keys that are not EC P-256', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsa = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => parsePrivateKey(rsa)).toThrow(/EC P-256/);
  });
});

describe('loadConfig', () => {
  const { pem } = makeKeyPair();
  const complete = { [ENV.issuerId]: ISSUER_ID, [ENV.keyId]: KEY_ID, [ENV.privateKey]: pem };

  it('loads complete credentials', () => {
    const config = loadConfig(complete);
    expect(config.error).toBeUndefined();
    expect(config.warnings).toEqual([]);
    expect(config.credentials).toMatchObject({ issuerId: ISSUER_ID, keyId: KEY_ID });
    expect(config.readOnly).toBe(false);
  });

  it('names every missing variable', () => {
    const config = loadConfig({ [ENV.keyId]: KEY_ID });
    expect(config.credentials).toBeUndefined();
    expect(config.error).toContain(ENV.issuerId);
    expect(config.error).toContain(ENV.privateKey);
    expect(config.error).not.toContain(ENV.keyId);
  });

  it('reports an unreadable key without echoing it', () => {
    const config = loadConfig({ ...complete, [ENV.privateKey]: 'secret-garbage-value' });
    expect(config.credentials).toBeUndefined();
    expect(config.error).toContain(ENV.privateKey);
    expect(config.error).not.toContain('secret-garbage-value');
  });

  it('warns when the Issuer ID and Key ID look swapped', () => {
    const config = loadConfig({ ...complete, [ENV.issuerId]: KEY_ID, [ENV.keyId]: ISSUER_ID });
    expect(config.credentials).toBeDefined();
    expect(config.warnings).toHaveLength(2);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['YES', true],
    ['false', false],
    ['', false],
    [undefined, false],
  ])('reads %s as read-only %s', (value, expected) => {
    expect(loadConfig({ ...complete, [ENV.readOnly]: value }).readOnly).toBe(expected);
  });
});

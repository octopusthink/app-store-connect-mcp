import { verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUDIENCE, signToken, TOKEN_LIFETIME_SECONDS, TokenProvider } from '../src/auth.ts';
import { ISSUER_ID, KEY_ID, makeCredentials } from './helpers.ts';

function decode(token: string) {
  const [header, payload, signature] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header ?? '', 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()),
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature ?? '', 'base64url'),
  };
}

describe('signToken', () => {
  it('creates an ES256 JWT with the claims Apple requires', () => {
    const credentials = makeCredentials();
    const token = decode(signToken(credentials, 1_700_000_000));

    expect(token.header).toEqual({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
    expect(token.payload).toEqual({
      iss: ISSUER_ID,
      iat: 1_700_000_000,
      exp: 1_700_000_000 + TOKEN_LIFETIME_SECONDS,
      aud: AUDIENCE,
    });
    expect(TOKEN_LIFETIME_SECONDS).toBeLessThanOrEqual(20 * 60);
  });

  it('signs with the private key in JOSE (r||s) format', () => {
    const credentials = makeCredentials();
    const token = decode(signToken(credentials, 1_700_000_000));

    expect(token.signature).toHaveLength(64);
    const valid = verify(
      'sha256',
      Buffer.from(token.signingInput),
      { key: credentials.publicKey, dsaEncoding: 'ieee-p1363' },
      token.signature,
    );
    expect(valid).toBe(true);
  });
});

describe('TokenProvider', () => {
  it('reuses a token until shortly before it expires', () => {
    let now = 1_700_000_000_000;
    const provider = new TokenProvider(makeCredentials(), () => now);
    const first = provider.getToken();

    now += (TOKEN_LIFETIME_SECONDS - 120) * 1000;
    expect(provider.getToken()).toBe(first);

    now += 90 * 1000;
    const second = provider.getToken();
    expect(second).not.toBe(first);
    expect(decode(second).payload.iat).toBe(Math.floor(now / 1000));
  });

  it('mints a new token after invalidate()', () => {
    const provider = new TokenProvider(makeCredentials());
    const first = provider.getToken();
    provider.invalidate();
    // ECDSA signatures are randomized, so a fresh token always differs.
    expect(provider.getToken()).not.toBe(first);
  });
});

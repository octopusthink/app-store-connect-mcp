import { sign } from 'node:crypto';
import type { Credentials } from './config.ts';

/** Apple rejects tokens that expire more than 20 minutes after they were issued. */
export const TOKEN_LIFETIME_SECONDS = 19 * 60;
/** Mint a new token when the cached one has less than this long left. */
const REFRESH_MARGIN_SECONDS = 60;

export const AUDIENCE = 'appstoreconnect-v1';

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Creates an ES256-signed JWT for a team API key. */
export function signToken(credentials: Credentials, issuedAt: number): string {
  const header = { alg: 'ES256', kid: credentials.keyId, typ: 'JWT' };
  const payload = {
    iss: credentials.issuerId,
    iat: issuedAt,
    exp: issuedAt + TOKEN_LIFETIME_SECONDS,
    aud: AUDIENCE,
  };
  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: credentials.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

/** Hands out cached tokens and replaces them shortly before they expire. */
export class TokenProvider {
  readonly #credentials: Credentials;
  readonly #now: () => number;
  #cached: { token: string; expiresAt: number } | undefined;

  constructor(credentials: Credentials, now: () => number = Date.now) {
    this.#credentials = credentials;
    this.#now = now;
  }

  getToken(): string {
    const now = Math.floor(this.#now() / 1000);
    if (this.#cached && this.#cached.expiresAt - REFRESH_MARGIN_SECONDS > now) {
      return this.#cached.token;
    }
    const token = signToken(this.#credentials, now);
    this.#cached = { token, expiresAt: now + TOKEN_LIFETIME_SECONDS };
    return token;
  }

  /** Forgets the cached token, for example after Apple rejects it. */
  invalidate(): void {
    this.#cached = undefined;
  }
}

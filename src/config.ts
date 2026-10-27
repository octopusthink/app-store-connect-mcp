import { createPrivateKey, type KeyObject } from 'node:crypto';

export const ENV = {
  issuerId: 'APP_STORE_CONNECT_ISSUER_ID',
  keyId: 'APP_STORE_CONNECT_KEY_ID',
  privateKey: 'APP_STORE_CONNECT_PRIVATE_KEY',
  readOnly: 'APP_STORE_CONNECT_READ_ONLY',
  vendorNumber: 'APP_STORE_CONNECT_VENDOR_NUMBER',
} as const;

export interface Credentials {
  issuerId: string;
  keyId: string;
  privateKey: KeyObject;
}

export interface Config {
  /** Present only when all three credentials were supplied and the key parsed. */
  credentials?: Credentials;
  /** Why credentials are unavailable, written so the user can fix their MCP config. */
  error?: string;
  /** Non-fatal problems worth logging, such as an unusual-looking Key ID. */
  warnings: string[];
  readOnly: boolean;
  /** Default vendor number for sales and finance reports. Optional; tools can also take one. */
  vendorNumber?: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID = /^[A-Z0-9]{10}$/;
const VENDOR_NUMBER = /^\d+$/;

/**
 * Parses the contents of an App Store Connect `.p8` file into a key object.
 *
 * MCP configs mangle multi-line values in different ways, so this accepts a
 * real multi-line PEM, a PEM with literal `\n` escapes, a PEM collapsed onto
 * one line, or just the base64 body without the BEGIN/END lines.
 */
export function parsePrivateKey(raw: string): KeyObject {
  let text = raw.trim();
  if (/^(["']).*\1$/s.test(text)) text = text.slice(1, -1);

  const body = text
    .replace(/\\r|\\n/g, '\n')
    .replace(/-----(BEGIN|END)[A-Z ]*-----/g, '')
    .replace(/\s+/g, '');

  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    throw new ConfigError(
      `${ENV.privateKey} is not a valid private key. Paste the full contents of your AuthKey_XXXXXXXXXX.p8 file, including the BEGIN and END lines.`,
    );
  }

  const der = Buffer.from(body, 'base64');
  let key: KeyObject | undefined;
  for (const type of ['pkcs8', 'sec1'] as const) {
    try {
      key = createPrivateKey({ key: der, format: 'der', type });
      break;
    } catch {
      // Try the next encoding.
    }
  }

  if (!key) {
    throw new ConfigError(
      `${ENV.privateKey} could not be read as a private key. Paste the full contents of your AuthKey_XXXXXXXXXX.p8 file.`,
    );
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new ConfigError(
      `${ENV.privateKey} is not an App Store Connect API key: expected an EC P-256 key, as found in AuthKey_XXXXXXXXXX.p8 files.`,
    );
  }
  return key;
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const warnings: string[] = [];
  const vendorNumber = env[ENV.vendorNumber]?.trim() || undefined;
  if (vendorNumber && !VENDOR_NUMBER.test(vendorNumber)) {
    warnings.push(
      `${ENV.vendorNumber} does not look like a vendor number (digits only, such as 85012345). Find it in App Store Connect under Payments and Financial Reports.`,
    );
  }
  // Settings that don't depend on the credentials, included whether or not they load.
  const base = { warnings, readOnly: isTruthy(env[ENV.readOnly]), vendorNumber };

  const issuerId = env[ENV.issuerId]?.trim();
  const keyId = env[ENV.keyId]?.trim();
  const rawKey = env[ENV.privateKey];

  const missing = [
    issuerId ? undefined : ENV.issuerId,
    keyId ? undefined : ENV.keyId,
    rawKey?.trim() ? undefined : ENV.privateKey,
  ].filter((name) => name !== undefined);

  if (!issuerId || !keyId || !rawKey?.trim()) {
    return {
      ...base,
      error: `App Store Connect credentials are not configured. Missing environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Add ${missing.length > 1 ? 'them' : 'it'} to this MCP server's configuration and restart it.`,
    };
  }

  if (!UUID.test(issuerId)) {
    warnings.push(
      `${ENV.issuerId} does not look like an Issuer ID (a UUID such as 57246542-96fe-1a63-e053-0824d011072a). Check it is not the Key ID.`,
    );
  }
  if (!KEY_ID.test(keyId)) {
    warnings.push(
      `${ENV.keyId} does not look like a Key ID (10 characters, such as 2X9R4HXF34). Check it is not the Issuer ID.`,
    );
  }

  try {
    return { ...base, credentials: { issuerId, keyId, privateKey: parsePrivateKey(rawKey) } };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

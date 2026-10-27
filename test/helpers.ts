import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { TokenProvider } from '../src/auth.ts';
import { AscClient } from '../src/client.ts';
import type { Credentials } from '../src/config.ts';
import { createServer } from '../src/server.ts';
import { ApiSpec } from '../src/spec.ts';

export function makeKeyPair(): { privateKey: KeyObject; publicKey: KeyObject; pem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { privateKey, publicKey, pem };
}

export const ISSUER_ID = '57246542-96fe-1a63-e053-0824d011072a';
export const KEY_ID = '2X9R4HXF34';

export function makeCredentials(): Credentials & { publicKey: KeyObject } {
  const { privateKey, publicKey } = makeKeyPair();
  return { issuerId: ISSUER_ID, keyId: KEY_ID, privateKey, publicKey };
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (request: RecordedRequest) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * A fake `fetch` that answers requests from a queue of responders, in order,
 * and records every request it receives.
 */
export function mockFetch(...responders: Responder[]) {
  const requests: RecordedRequest[] = [];
  const queue = [...responders];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const request: RecordedRequest = {
      method: init.method ?? 'GET',
      url: new URL(String(input)),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const responder = queue.shift();
    if (!responder) throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    return responder(request);
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

export function makeClient(
  fetch: typeof globalThis.fetch,
  credentials: Credentials = makeCredentials(),
) {
  return new AscClient({ tokens: new TokenProvider(credentials), fetch, sleep: async () => {} });
}

/** Connects an MCP client to a server instance over an in-memory transport. */
export async function connect(options: {
  fetch?: typeof globalThis.fetch;
  readOnly?: boolean;
  configError?: string;
}) {
  const client = options.fetch ? makeClient(options.fetch) : undefined;
  const server = createServer({
    client,
    configError: options.configError ?? (client ? undefined : 'Missing credentials for test.'),
    spec: new ApiSpec(),
    readOnly: options.readOnly ?? false,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  await mcp.connect(clientTransport);

  return {
    mcp,
    /** Calls a tool and returns its text output, parsed as JSON when possible. */
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await mcp.callTool({ name, arguments: args });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
      let value: unknown = text;
      try {
        value = JSON.parse(text);
      } catch {
        // Plain text output.
      }
      return { isError: result.isError === true, text, value };
    },
    close: () => mcp.close(),
  };
}

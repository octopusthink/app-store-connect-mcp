import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeKeyPair } from './helpers.ts';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

/** Starts the real server as a child process, the way Claude launches it. */
async function start(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { PATH: process.env.PATH ?? '', ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

describe('stdio server without credentials', () => {
  let server: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    server = await start({});
  });
  afterAll(() => server.client.close());

  it('negotiates a 2025-era protocol version and lists tools', async () => {
    expect(server.client.getServerVersion()?.name).toBe('app-store-connect');
    expect(server.client.getNegotiatedProtocolVersion()).toMatch(/^2025-/);
    const { tools } = await server.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['list_apps', 'submit_for_review', 'api_request']),
    );
  });

  it('explains missing credentials from tools and on stderr', async () => {
    const result = await server.client.callTool({ name: 'list_apps', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('APP_STORE_CONNECT_ISSUER_ID');
    expect(server.stderr()).toContain('APP_STORE_CONNECT_PRIVATE_KEY');
  });

  it('searches the bundled spec', async () => {
    const result = await server.client.callTool({
      name: 'search_endpoints',
      arguments: { query: 'customer reviews' },
    });
    expect(JSON.stringify(result.content)).toContain('/v1/apps/{id}/customerReviews');
  });
});

describe('stdio server in read-only mode', () => {
  let server: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    server = await start({
      APP_STORE_CONNECT_ISSUER_ID: '57246542-96fe-1a63-e053-0824d011072a',
      APP_STORE_CONNECT_KEY_ID: '2X9R4HXF34',
      // Escaped newlines, as they would appear in a JSON MCP config.
      APP_STORE_CONNECT_PRIVATE_KEY: makeKeyPair().pem.replace(/\n/g, '\\n'),
      APP_STORE_CONNECT_READ_ONLY: 'true',
    });
  });
  afterAll(() => server.client.close());

  it('accepts the key and hides write tools', async () => {
    const { tools } = await server.client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('list_apps');
    expect(names).not.toContain('submit_for_review');
    expect(server.stderr()).toContain('read-only');
    expect(server.stderr()).not.toContain('not configured');
  });
});

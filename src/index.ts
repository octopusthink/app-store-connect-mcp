#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { TokenProvider } from './auth.ts';
import { AscClient } from './client.ts';
import { loadConfig } from './config.ts';
import { createServer, SERVER_VERSION } from './server.ts';
import { ApiSpec } from './spec.ts';

// stdout carries the MCP protocol, so everything human-readable goes to stderr.
const log = (message: string) => console.error(`[app-store-connect-mcp] ${message}`);

const config = loadConfig();
for (const warning of config.warnings) log(`Warning: ${warning}`);
if (config.error) log(config.error);

const deps = {
  client: config.credentials
    ? new AscClient({ tokens: new TokenProvider(config.credentials) })
    : undefined,
  configError: config.error,
  spec: new ApiSpec(),
  readOnly: config.readOnly,
};

serveStdio(() => createServer(deps), { onerror: (error) => log(`Error: ${error.message}`) });

log(`v${SERVER_VERSION} running on stdio${config.readOnly ? ' (read-only)' : ''}.`);

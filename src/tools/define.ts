import type { CallToolResult, McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import type * as z from 'zod';
import type { AscClient } from '../client.ts';
import { ConfigError } from '../config.ts';
import { renderOutput } from '../format.ts';
import type { ApiSpec } from '../spec.ts';

export interface ToolDeps {
  /** Undefined when credentials are missing or invalid. */
  client: AscClient | undefined;
  /** Explains why `client` is undefined. */
  configError: string | undefined;
  spec: ApiSpec;
  readOnly: boolean;
  /** Default vendor number for reports, from APP_STORE_CONNECT_VENDOR_NUMBER. */
  vendorNumber?: string | undefined;
}

export interface ToolContext {
  readonly client: AscClient;
  readonly spec: ApiSpec;
  readonly vendorNumber: string | undefined;
  readonly signal: AbortSignal;
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Write tools change App Store Connect data and are hidden in read-only mode. */
  write?: boolean;
  /** For write tools: the change is hard to undo (deletions, submissions). */
  destructive?: boolean;
  /** For write tools: repeating the call with the same input has no further effect. */
  idempotent?: boolean;
  /** Tools that only read the bundled API spec work without credentials. */
  offline?: boolean;
  /** Returns a value to serialize as JSON, or a string to send as-is. */
  handler(args: z.output<S>, context: ToolContext): Promise<unknown>;
}

export function defineTool<S extends z.ZodObject>(
  definition: ToolDefinition<S>,
): ToolDefinition<S> {
  return definition;
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function registerTool(server: McpServer, tool: ToolDefinition, deps: ToolDeps): void {
  const annotations: ToolAnnotations = {
    title: tool.title,
    readOnlyHint: !tool.write,
    ...(tool.write
      ? { destructiveHint: tool.destructive ?? false, idempotentHint: tool.idempotent ?? false }
      : {}),
    openWorldHint: !tool.offline,
  };

  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.input, annotations },
    async (args, ctx): Promise<CallToolResult> => {
      const notConfigured = deps.configError ?? 'App Store Connect credentials are not configured.';
      if (!tool.offline && !deps.client) return errorResult(notConfigured);

      const context: ToolContext = {
        get client() {
          if (!deps.client) throw new ConfigError(notConfigured);
          return deps.client;
        },
        spec: deps.spec,
        vendorNumber: deps.vendorNumber,
        signal: ctx.mcpReq.signal,
      };
      try {
        const value = await tool.handler(args, context);
        return { content: [{ type: 'text', text: renderOutput(value) }] };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );
}

import * as z from 'zod';
import type { HttpMethod } from '../client.ts';
import { type JsonApiDocument, simplifyDocument } from '../format.ts';
import { SPEC_METHODS } from '../spec.ts';
import { defineTool } from './define.ts';

export const searchEndpoints = defineTool({
  name: 'search_endpoints',
  title: 'Search App Store Connect API',
  description:
    'Searches all App Store Connect API endpoints (from Apple\'s OpenAPI spec) by keyword, e.g. "phased release", "in-app purchase price", "screenshots". Use it to find endpoints the other tools don\'t cover, then describe_endpoint and api_request.',
  offline: true,
  input: z.object({
    query: z.string().min(1).describe('Keywords, e.g. "subscription offer codes" or "age rating".'),
    method: z.enum(SPEC_METHODS).optional().describe('Only endpoints with this HTTP method.'),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  handler: async ({ query, method, limit }, { spec }) => {
    const results = spec.search(query, { method, limit });
    return {
      specVersion: spec.version,
      results,
      ...(results.length === 0
        ? { hint: 'No matches. Try other words, e.g. the resource name in singular form.' }
        : {}),
    };
  },
});

export const describeEndpoint = defineTool({
  name: 'describe_endpoint',
  title: 'Describe API endpoint',
  description:
    'Shows how to call one App Store Connect API endpoint: path parameters, query parameters (filters, include, sort, limit) with allowed values, and the full request body schema.',
  offline: true,
  input: z.object({
    method: z.enum(SPEC_METHODS),
    path: z
      .string()
      .min(1)
      .describe(
        'Path template or concrete path, e.g. /v1/apps/{id}/appStoreVersions or /v1/apps/123.',
      ),
    verbose: z
      .boolean()
      .default(false)
      .describe('Also list every allowed value of the fields[...] parameters.'),
  }),
  handler: async ({ method, path, verbose }, { spec }) => {
    const description = spec.describe(method, path, { verbose });
    if (description) return description;
    const otherMethods = SPEC_METHODS.filter((other) => other !== method && spec.find(other, path));
    throw new Error(
      `No ${method} ${path} in App Store Connect API ${spec.version}.${
        otherMethods.length
          ? ` That path supports: ${otherMethods.join(', ')}.`
          : ' Use search_endpoints to find the right path.'
      }`,
    );
  },
});

const queryValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])),
]);

const REPORT_PATHS = /\/v1\/(salesReports|financeReports)\b/;

function isJsonApiDocument(value: unknown): value is JsonApiDocument {
  return typeof value === 'object' && value !== null && 'data' in value;
}

/** In read-only mode the tool is registered GET-only, as a read tool. */
export function apiRequest(readOnly: boolean) {
  const methods = readOnly ? (['GET'] as const) : SPEC_METHODS;
  return defineTool({
    name: 'api_request',
    title: 'App Store Connect API request',
    description: `Calls any App Store Connect API endpoint${readOnly ? ' (GET only: this server is in read-only mode)' : ''}. Prefer the dedicated tools when one fits. For anything else, find the endpoint with search_endpoints and check its parameters and body with describe_endpoint first. Responses are simplified: attributes are flattened and related resources become IDs, unless raw is true.${readOnly ? '' : ' POST, PATCH and DELETE change live App Store Connect data, so confirm with the user first.'}`,
    write: !readOnly,
    destructive: !readOnly,
    input: z.object({
      method: z.enum(methods).default('GET'),
      path: z
        .string()
        .min(1)
        .describe(
          'API path, e.g. /v1/apps/123/appStoreVersions, or a nextCursor URL from an earlier response.',
        ),
      query: z
        .record(z.string(), queryValue)
        .optional()
        .describe(
          'Query parameters, e.g. {"filter[platform]": "IOS", "include": "build", "limit": 50}. Arrays are joined with commas.',
        ),
      body: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'JSON:API request body for POST, PATCH or DELETE: {"data": {"type": ..., "id"?: ..., "attributes": {...}, "relationships": {...}}}.',
        ),
      allPages: z
        .boolean()
        .default(false)
        .describe('For GET lists: follow pagination and return up to maxItems items.'),
      maxItems: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(200)
        .describe('Item cap when allPages is true.'),
      raw: z.boolean().default(false).describe('Return the unmodified JSON:API response.'),
    }),
    handler: async (args, { client, signal }) => {
      const method: HttpMethod = args.method;
      if (readOnly && method !== 'GET') {
        throw new Error(
          'This server is in read-only mode (APP_STORE_CONNECT_READ_ONLY), so only GET requests are allowed.',
        );
      }

      if (args.allPages && method === 'GET') {
        const page = await client.paginate(args.path, args.query ?? {}, args.maxItems, signal);
        const document: JsonApiDocument = {
          data: page.data,
          included: page.included,
          ...(page.next ? { links: { next: page.next } } : {}),
          ...(page.total !== undefined ? { meta: { paging: { total: page.total } } } : {}),
        };
        return args.raw ? document : simplifyDocument(document);
      }

      const response = await client.request({
        method,
        path: args.path,
        query: args.query,
        body: args.body,
        accept: REPORT_PATHS.test(args.path) ? 'application/a-gzip' : undefined,
        signal,
      });
      if (response.data === null) return { status: response.status, ok: true };
      if (typeof response.data === 'string') return response.data;
      if (!args.raw && isJsonApiDocument(response.data)) return simplifyDocument(response.data);
      return response.data;
    },
  });
}

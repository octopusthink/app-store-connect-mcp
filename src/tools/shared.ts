import * as z from 'zod';
import type { Query } from '../client.ts';
import {
  type FlatResource,
  flattenResource,
  type JsonApiDocument,
  type Resource,
  type ResourceLinkage,
  simplifyDocument,
} from '../format.ts';
import type { ToolContext } from './define.ts';

export const PLATFORMS = ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'] as const;

export const limit = (fallback = 25) =>
  z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(fallback)
    .describe('Maximum number of items to return (1-200).');

export const cursor = z
  .string()
  .optional()
  .describe('The nextCursor value from a previous call of this tool, to fetch the next page.');

export const id = (what: string, from: string) =>
  z.string().min(1).describe(`${what} ID (from ${from}).`);

export const platform = z.enum(PLATFORMS).describe('Platform: IOS, MAC_OS, TV_OS or VISION_OS.');

/** Fetches one page of a list endpoint, or the page a cursor points at. */
export async function listPage(
  context: ToolContext,
  path: string,
  query: Query,
  page: { limit: number; cursor?: string | undefined },
): Promise<JsonApiDocument> {
  if (page.cursor) return context.client.get(page.cursor, undefined, context.signal);
  return context.client.get(path, { ...query, limit: page.limit }, context.signal);
}

/** Fetches a list endpoint and returns it in the compact `{ items, nextCursor }` form. */
export async function list(
  context: ToolContext,
  path: string,
  query: Query,
  page: { limit: number; cursor?: string | undefined },
): Promise<Record<string, unknown>> {
  return simplifyDocument(await listPage(context, path, query, page));
}

/** Builds a JSON:API request document. Undefined attributes are left out. */
export function jsonApiBody(
  type: string,
  options: {
    id?: string;
    attributes?: Record<string, unknown>;
    relationships?: Record<string, ResourceLinkage | ResourceLinkage[]>;
  },
) {
  const attributes = Object.fromEntries(
    Object.entries(options.attributes ?? {}).filter(([, value]) => value !== undefined),
  );
  return {
    data: {
      type,
      ...(options.id ? { id: options.id } : {}),
      ...(Object.keys(attributes).length ? { attributes } : {}),
      ...(options.relationships
        ? {
            relationships: Object.fromEntries(
              Object.entries(options.relationships).map(([name, data]) => [name, { data }]),
            ),
          }
        : {}),
    },
  };
}

export const linkage = (type: string, id: string): ResourceLinkage => ({ type, id });

/** Returns the flattened single resource from a document, throwing if there is none. */
export function single(document: JsonApiDocument): FlatResource {
  if (!document.data || Array.isArray(document.data)) {
    throw new Error('App Store Connect returned an unexpected response with no resource.');
  }
  return flattenResource(document.data);
}

export function resources(document: JsonApiDocument): Resource[] {
  if (Array.isArray(document.data)) return document.data;
  return document.data ? [document.data] : [];
}

/** Indexes included resources by `type/id` so they can be merged into their parents. */
export function includedIndex(document: JsonApiDocument): Map<string, FlatResource> {
  return new Map(
    (document.included ?? []).map((resource) => [
      `${resource.type}/${resource.id}`,
      flattenResource(resource),
    ]),
  );
}

/** Rejects updates that would send no changes. */
export function requireSomeFields(fields: Record<string, unknown>, names: string[]): void {
  if (Object.values(fields).every((value) => value === undefined)) {
    throw new Error(`Provide at least one field to change: ${names.join(', ')}.`);
  }
}

/** Formats a tab-separated report, keeping the header and up to `maxRows` rows. */
export function formatReport(text: string, maxRows: number): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const [header, ...rows] = lines;
  if (!header) return 'The report is empty.';
  const shown = rows.slice(0, maxRows);
  const note =
    rows.length > shown.length
      ? `\n\n[${rows.length - shown.length} more rows not shown; ${rows.length} rows in total. Raise maxRows to see more.]`
      : `\n\n[${rows.length} rows]`;
  return [header, ...shown].join('\n') + note;
}

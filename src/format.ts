export interface ResourceLinkage {
  type: string;
  id: string;
}

export interface Relationship {
  data?: ResourceLinkage | ResourceLinkage[] | null;
  links?: unknown;
  meta?: { paging?: { total?: number } };
}

export interface Resource {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, Relationship>;
  links?: unknown;
}

export interface JsonApiDocument {
  data?: Resource | Resource[] | null;
  included?: Resource[];
  links?: { self?: string; next?: string };
  meta?: { paging?: { total?: number; limit?: number } };
}

export type FlatResource = { id: string; type: string } & Record<string, unknown>;

/** Claude Code's default MCP output limit is about 25k tokens; stay comfortably under it. */
export const MAX_OUTPUT_CHARS = 60_000;

/**
 * Turns a JSON:API resource into a flat object: attributes are lifted to the
 * top level and relationships with data become IDs. Links are dropped.
 */
export function flattenResource(resource: Resource): FlatResource {
  const flat: FlatResource = { id: resource.id, type: resource.type, ...resource.attributes };
  for (const [name, relationship] of Object.entries(resource.relationships ?? {})) {
    if (relationship.data === undefined) continue;
    flat[name] = Array.isArray(relationship.data)
      ? relationship.data.map((linkage) => linkage.id)
      : (relationship.data?.id ?? null);
  }
  return flat;
}

/** Groups included resources by type, e.g. `{ builds: [...], preReleaseVersions: [...] }`. */
export function groupIncluded(
  included: Resource[] = [],
): Record<string, FlatResource[]> | undefined {
  if (included.length === 0) return undefined;
  const groups: Record<string, FlatResource[]> = {};
  const seen = new Set<string>();
  for (const resource of included) {
    const key = `${resource.type}/${resource.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    groups[resource.type] ??= [];
    groups[resource.type]?.push(flattenResource(resource));
  }
  return groups;
}

/** Makes a JSON:API document compact enough for a model to read. */
export function simplifyDocument(document: JsonApiDocument): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (Array.isArray(document.data)) {
    result.items = document.data.map(flattenResource);
  } else if (document.data) {
    result.item = flattenResource(document.data);
  } else if (document.data === null) {
    result.item = null;
  }
  const included = groupIncluded(document.included);
  if (included) result.included = included;
  if (document.meta?.paging?.total !== undefined) result.total = document.meta.paging.total;
  if (document.links?.next) result.nextCursor = document.links.next;
  return result;
}

/** Simplifies a single-resource document down to the flat resource itself. */
export function simplifyOne(document: JsonApiDocument): FlatResource | null {
  if (!document.data || Array.isArray(document.data)) return null;
  return flattenResource(document.data);
}

/** Serializes a tool result and trims it to the output budget. */
export function renderOutput(value: unknown, maxChars = MAX_OUTPUT_CHARS): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[Output truncated: ${text.length - maxChars} more characters. Narrow the request with filters or a smaller limit.]`;
}

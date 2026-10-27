import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

type JsonSchema = { [key: string]: unknown };

interface OpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

interface OpenApiOperation {
  operationId?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: OpenApiParameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
}

interface OpenApiDocument {
  info: { version: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, JsonSchema> };
}

export const SPEC_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
export type SpecMethod = (typeof SPEC_METHODS)[number];

export interface EndpointSummary {
  method: SpecMethod;
  path: string;
  operationId: string;
  tag?: string;
  deprecated?: true;
}

interface IndexedEndpoint extends EndpointSummary {
  operation: OpenApiOperation;
  pathText: string;
  lastSegment: string;
  idText: string;
  tagText: string;
  attributeText: string;
}

export interface QueryParameterDescription {
  name: string;
  required?: true;
  type?: string;
  values?: unknown[];
  description?: string;
}

export interface EndpointDescription extends EndpointSummary {
  pathParameters: string[];
  queryParameters: QueryParameterDescription[];
  /** Names of `fields[...]` parameters, listed without their values unless verbose. */
  sparseFieldsets?: string[];
  requestBody?: unknown;
  responseSchema?: string;
}

/**
 * Query words that appear nowhere in Apple's paths or operation IDs, mapped to
 * words that do. The spec has no summaries, so this bridges common phrasing.
 */
const ALIASES: Record<string, string[]> = {
  testflight: ['beta'],
  tester: ['betatester'],
  metadata: ['localization', 'appinfo'],
  description: ['appstoreversionlocalization'],
  keyword: ['appstoreversionlocalization', 'searchkeyword'],
  release: ['appstoreversion', 'phasedrelease'],
  note: ['whatsnew'],
  respond: ['customerreviewresponse'],
  reply: ['customerreviewresponse'],
  changelog: ['whatsnew'],
  start: ['createinstance'],
  trigger: ['createinstance'],
  create: ['createinstance'],
  rating: ['customerreview', 'ageratingdeclaration'],
  revenue: ['salesreport', 'financereport'],
  sale: ['salesreport'],
  finance: ['financereport'],
  report: ['analyticsreport', 'salesreport', 'financereport'],
  xcode: ['ci'],
  cloud: ['ci'],
  workflow: ['ciworkflow'],
  provisioning: ['profile', 'certificate', 'bundleid', 'device'],
  iap: ['inapppurchase'],
  purchase: ['inapppurchase'],
  subscription: ['subscription'],
  screenshot: ['appscreenshot'],
  preview: ['apppreview'],
  price: ['pricepoint', 'priceschedule'],
  pricing: ['pricepoint', 'priceschedule'],
  submit: ['reviewsubmission', 'betaappreviewsubmission'],
  submission: ['reviewsubmission', 'betaappreviewsubmission'],
  crash: ['diagnostic', 'betafeedbackcrash'],
  feedback: ['betafeedback'],
  team: ['user'],
  invite: ['userinvitation', 'betatesterinvitation'],
};

function aliasesFor(term: string): string[] {
  return Object.hasOwn(ALIASES, term) ? (ALIASES[term] ?? []) : [];
}

const METHOD_ORDER: Record<SpecMethod, number> = { GET: 0, POST: 1, PATCH: 2, DELETE: 3 };

function schemaName(ref: unknown): string | undefined {
  return typeof ref === 'string' ? ref.split('/').pop() : undefined;
}

function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/what'?s new/g, 'whatsnew')
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1)
    .map((term) =>
      term.length > 3 && term.endsWith('s') && !term.endsWith('ss') ? term.slice(0, -1) : term,
    );
}

export function loadBundledSpec(): OpenApiDocument {
  const file = new URL('../spec/openapi.json.gz', import.meta.url);
  return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as OpenApiDocument;
}

/** Search and describe operations from Apple's bundled OpenAPI spec. Loaded on first use. */
export class ApiSpec {
  readonly #load: () => OpenApiDocument;
  #document: OpenApiDocument | undefined;
  #endpoints: IndexedEndpoint[] | undefined;

  constructor(load: () => OpenApiDocument = loadBundledSpec) {
    this.#load = load;
  }

  get #doc(): OpenApiDocument {
    this.#document ??= this.#load();
    return this.#document;
  }

  get version(): string {
    return this.#doc.info.version;
  }

  #index(): IndexedEndpoint[] {
    if (this.#endpoints) return this.#endpoints;
    const endpoints: IndexedEndpoint[] = [];
    for (const [path, item] of Object.entries(this.#doc.paths)) {
      for (const method of SPEC_METHODS) {
        const operation = item[method.toLowerCase()] as OpenApiOperation | undefined;
        if (!operation) continue;
        const tag = operation.tags?.[0];
        endpoints.push({
          method,
          path,
          operationId: operation.operationId ?? `${method} ${path}`,
          ...(tag ? { tag } : {}),
          ...(operation.deprecated ? { deprecated: true as const } : {}),
          operation,
          pathText: path.toLowerCase(),
          lastSegment:
            path
              .split('/')
              .filter((segment) => !segment.startsWith('{'))
              .pop()
              ?.toLowerCase() ?? '',
          idText: (operation.operationId ?? '').toLowerCase(),
          tagText: (tag ?? '').toLowerCase(),
          attributeText: this.#attributeNames(operation).join(' ').toLowerCase(),
        });
      }
    }
    this.#endpoints = endpoints;
    return endpoints;
  }

  /** Attribute names of the resource an operation reads or writes, for matching words like "whatsNew". */
  #attributeNames(operation: OpenApiOperation): string[] {
    const body = operation.requestBody?.content?.['application/json']?.schema;
    const ok = operation.responses?.['200'] ?? operation.responses?.['201'];
    const response = ok?.content?.['application/json']?.schema;
    const document = this.#schema(body?.$ref ?? response?.$ref);
    const data = this.#deref((document?.properties as JsonSchema | undefined)?.data);
    const resource = this.#deref((data?.items as JsonSchema | undefined) ?? data);
    const attributes = this.#deref((resource?.properties as JsonSchema | undefined)?.attributes);
    return Object.keys((attributes?.properties as JsonSchema | undefined) ?? {});
  }

  #schema(ref: unknown): JsonSchema | undefined {
    const name = schemaName(ref);
    return name ? this.#doc.components.schemas[name] : undefined;
  }

  #deref(schema: unknown): JsonSchema | undefined {
    let current = schema as JsonSchema | undefined;
    for (let hops = 0; current?.$ref && hops < 10; hops++) current = this.#schema(current.$ref);
    return current;
  }

  search(query: string, options: { method?: SpecMethod; limit?: number } = {}): EndpointSummary[] {
    const terms = searchTerms(query);
    const limit = options.limit ?? 20;
    const candidates = this.#index().filter(
      (endpoint) => !options.method || endpoint.method === options.method,
    );
    if (terms.length === 0) return [];

    const scored = candidates.map((endpoint) => {
      let score = 0;
      let matched = 0;
      for (const term of terms) {
        // A direct hit anywhere outranks a hit through an alias.
        const termScore =
          scoreHit(endpoint, (text) => text.includes(term)) * 2 ||
          scoreHit(endpoint, (text) => aliasesFor(term).some((alias) => text.includes(alias)));
        if (termScore > 0) matched++;
        score += termScore;
      }
      return { endpoint, score, matched };
    });

    const allTerms = scored.filter((entry) => entry.matched === terms.length);
    const pool = allTerms.length > 0 ? allTerms : scored.filter((entry) => entry.matched > 0);

    return pool
      .sort(
        (a, b) =>
          b.matched - a.matched ||
          b.score - a.score ||
          Number(a.endpoint.deprecated ?? false) - Number(b.endpoint.deprecated ?? false) ||
          a.endpoint.path.split('/').length - b.endpoint.path.split('/').length ||
          a.endpoint.path.length - b.endpoint.path.length ||
          METHOD_ORDER[a.endpoint.method] - METHOD_ORDER[b.endpoint.method] ||
          a.endpoint.path.localeCompare(b.endpoint.path),
      )
      .slice(0, limit)
      .map(({ endpoint }) => summarize(endpoint));
  }

  /** Finds an operation by method and path. Concrete IDs (e.g. `/v1/apps/123`) match path templates. */
  find(method: SpecMethod, path: string): EndpointSummary | undefined {
    const endpoint = this.#find(method, path);
    return endpoint ? summarize(endpoint) : undefined;
  }

  #find(method: SpecMethod, rawPath: string): IndexedEndpoint | undefined {
    const path = normalizePath(rawPath);
    const endpoints = this.#index().filter((endpoint) => endpoint.method === method);
    const exact = endpoints.find((endpoint) => endpoint.path === path);
    if (exact) return exact;

    const segments = path.split('/');
    const matches = endpoints.filter((endpoint) => {
      const template = endpoint.path.split('/');
      return (
        template.length === segments.length &&
        template.every((part, index) => part.startsWith('{') || part === segments[index])
      );
    });
    // Prefer the template with the most literal segments.
    const literalCount = (endpoint: IndexedEndpoint) =>
      endpoint.path.split('/').filter((part) => !part.startsWith('{')).length;
    return matches.sort((a, b) => literalCount(b) - literalCount(a))[0];
  }

  describe(
    method: SpecMethod,
    path: string,
    options: { verbose?: boolean } = {},
  ): EndpointDescription | undefined {
    const endpoint = this.#find(method, path);
    if (!endpoint) return undefined;
    const { operation } = endpoint;

    const pathParameters: string[] = [];
    const queryParameters: QueryParameterDescription[] = [];
    const sparseFieldsets: string[] = [];

    for (const parameter of operation.parameters ?? []) {
      if (parameter.in === 'path') {
        pathParameters.push(parameter.name);
        continue;
      }
      if (parameter.in !== 'query') continue;
      if (parameter.name.startsWith('fields[') && !options.verbose) {
        sparseFieldsets.push(parameter.name);
        continue;
      }
      const schema = parameter.schema ?? {};
      const items = this.#deref(schema.items);
      const values = (schema.enum ?? items?.enum) as unknown[] | undefined;
      const type =
        schema.type === 'array'
          ? `array of ${items?.type ?? 'string'} (comma-separated)`
          : schema.type;
      queryParameters.push({
        name: parameter.name,
        ...(parameter.required ? { required: true as const } : {}),
        ...(typeof type === 'string' ? { type } : {}),
        ...(values ? { values } : {}),
        ...(parameter.description ? { description: parameter.description } : {}),
      });
    }

    const body = operation.requestBody?.content?.['application/json']?.schema;
    const ok = Object.entries(operation.responses ?? {}).find(([status]) => status.startsWith('2'));
    const responseRef = ok?.[1].content?.['application/json']?.schema?.$ref;

    return {
      ...summarize(endpoint),
      pathParameters,
      queryParameters,
      ...(sparseFieldsets.length ? { sparseFieldsets } : {}),
      ...(body ? { requestBody: this.resolveSchema(body) } : {}),
      ...(responseRef ? { responseSchema: schemaName(responseRef) } : {}),
    };
  }

  /** Inlines `$ref`s up to a depth limit so a model can see the full shape of a request body. */
  resolveSchema(schema: unknown, depth = 8, seen: ReadonlySet<string> = new Set()): unknown {
    if (!schema || typeof schema !== 'object') return schema;
    const source = schema as JsonSchema;

    if (source.$ref) {
      const name = schemaName(source.$ref) ?? '';
      if (depth <= 0 || seen.has(name)) return { $ref: name };
      return this.resolveSchema(
        this.#doc.components.schemas[name],
        depth - 1,
        new Set([...seen, name]),
      );
    }

    const out: JsonSchema = {};
    for (const key of [
      'type',
      'format',
      'enum',
      'const',
      'nullable',
      'deprecated',
      'required',
      'minimum',
      'maximum',
      'maxLength',
      'minItems',
      'maxItems',
      'description',
    ]) {
      if (source[key] !== undefined) out[key] = source[key];
    }
    if (source.properties && typeof source.properties === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(source.properties as JsonSchema).map(([key, value]) => [
          key,
          this.resolveSchema(value, depth, seen),
        ]),
      );
    }
    if (source.items) out.items = this.resolveSchema(source.items, depth, seen);
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      if (Array.isArray(source[key])) {
        out[key] = (source[key] as unknown[]).map((entry) =>
          this.resolveSchema(entry, depth, seen),
        );
      }
    }
    if (source.additionalProperties && typeof source.additionalProperties === 'object') {
      out.additionalProperties = this.resolveSchema(source.additionalProperties, depth, seen);
    }
    return out;
  }
}

function scoreHit(endpoint: IndexedEndpoint, hit: (text: string) => boolean): number {
  if (hit(endpoint.lastSegment)) return 4;
  if (hit(endpoint.pathText)) return 3;
  if (hit(endpoint.idText) || hit(endpoint.tagText)) return 2;
  if (hit(endpoint.attributeText)) return 1;
  return 0;
}

function summarize(endpoint: IndexedEndpoint): EndpointSummary {
  return {
    method: endpoint.method,
    path: endpoint.path,
    operationId: endpoint.operationId,
    ...(endpoint.tag ? { tag: endpoint.tag } : {}),
    ...(endpoint.deprecated ? { deprecated: true as const } : {}),
  };
}

function normalizePath(path: string): string {
  const withoutOrigin = path.replace(/^https?:\/\/[^/]+/i, '');
  const withoutQuery = withoutOrigin.split('?')[0] ?? '';
  const withSlash = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

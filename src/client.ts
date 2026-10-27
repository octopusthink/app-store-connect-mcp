import { gunzipSync } from 'node:zlib';
import type { TokenProvider } from './auth.ts';
import type { JsonApiDocument, Resource } from './format.ts';

export const API_ORIGIN = 'https://api.appstoreconnect.apple.com';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type QueryValue =
  | string
  | number
  | boolean
  | ReadonlyArray<string | number>
  | null
  | undefined;
export type Query = Record<string, QueryValue>;

export interface RequestOptions {
  method?: HttpMethod;
  /** An API path such as `/v1/apps`, or a full URL on the App Store Connect API host. */
  path: string;
  query?: Query;
  body?: unknown;
  accept?: string;
  signal?: AbortSignal;
}

export interface ApiResponse<T = unknown> {
  status: number;
  contentType: string;
  /** Parsed JSON, decoded text (gzip reports are unzipped), or null for empty responses. */
  data: T;
}

export interface JsonApiErrorObject {
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
  source?: { pointer?: string; parameter?: string };
}

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly errors: JsonApiErrorObject[];

  constructor(status: number, errors: JsonApiErrorObject[], rateLimit?: string | null) {
    super(ApiError.describe(status, errors, rateLimit));
    this.status = status;
    this.errors = errors;
  }

  static describe(status: number, errors: JsonApiErrorObject[], rateLimit?: string | null): string {
    const lines = errors.map((error) => {
      const code = error.code ? ` (${error.code})` : '';
      const text = [error.title, error.detail].filter(Boolean).join(': ');
      const source = error.source?.pointer ?? error.source?.parameter;
      return `- ${text || 'Unknown error'}${code}${source ? ` [at ${source}]` : ''}`;
    });
    const hint =
      status === 401
        ? '\nCheck the Issuer ID, Key ID and private key, and that the key has not been revoked.'
        : status === 403
          ? "\nThe API key's role may not allow this. Check its access in App Store Connect under Users and Access → Integrations."
          : status === 429
            ? `\nRate limit reached${rateLimit ? ` (${rateLimit})` : ''}. Wait before retrying.`
            : '';
    return `App Store Connect API returned ${status}.${lines.length ? `\n${lines.join('\n')}` : ''}${hint}`;
  }
}

export interface ClientOptions {
  tokens: TokenProvider;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries for rate limits (any method) and server errors (GET only). */
  maxRetries?: number;
}

export interface PaginatedResult {
  data: Resource[];
  included: Resource[];
  /** URL of the next page when items were left unread. */
  next?: string;
  total?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class AscClient {
  readonly #tokens: TokenProvider;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxRetries: number;

  constructor(options: ClientOptions) {
    this.#tokens = options.tokens;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#maxRetries = options.maxRetries ?? 3;
  }

  /** Builds a request URL, refusing anything that would send the token to another host. */
  static buildUrl(path: string, query: Query = {}): URL {
    const url = new URL(path, API_ORIGIN);
    if (url.origin !== API_ORIGIN) {
      throw new Error(
        `Refusing to send App Store Connect credentials to ${url.origin}. Only ${API_ORIGIN} is allowed.`,
      );
    }
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    return url;
  }

  async request<T = unknown>(options: RequestOptions): Promise<ApiResponse<T>> {
    const method = options.method ?? 'GET';
    const url = AscClient.buildUrl(options.path, options.query);
    let refreshedToken = false;

    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.#tokens.getToken()}`,
          Accept: options.accept ?? 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });

      if (response.status === 401 && !refreshedToken) {
        this.#tokens.invalidate();
        refreshedToken = true;
        continue;
      }

      const retryable = response.status === 429 || (response.status >= 500 && method === 'GET');
      if (retryable && attempt < this.#maxRetries) {
        await response.body?.cancel();
        await this.#sleep(retryDelay(response, attempt));
        continue;
      }

      if (!response.ok) {
        throw new ApiError(
          response.status,
          await readErrors(response),
          response.headers.get('x-rate-limit'),
        );
      }

      return (await readBody(response)) as ApiResponse<T>;
    }
  }

  get<T = JsonApiDocument>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
    return this.request<T>({ path, query, signal }).then((response) => response.data);
  }

  post<T = JsonApiDocument>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>({ method: 'POST', path, body, signal }).then(
      (response) => response.data,
    );
  }

  patch<T = JsonApiDocument>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>({ method: 'PATCH', path, body, signal }).then(
      (response) => response.data,
    );
  }

  delete(path: string, body?: unknown, signal?: AbortSignal): Promise<void> {
    return this.request({ method: 'DELETE', path, body, signal }).then(() => undefined);
  }

  /** Follows `links.next` until `maxItems` resources have been read or there are no more pages. */
  async paginate(
    path: string,
    query: Query,
    maxItems: number,
    signal?: AbortSignal,
  ): Promise<PaginatedResult> {
    const data: Resource[] = [];
    const included: Resource[] = [];
    let next: string | undefined = path;
    let nextQuery: Query | undefined = query;
    let total: number | undefined;

    while (next && data.length < maxItems) {
      const page: JsonApiDocument = await this.get(next, nextQuery, signal);
      const items = Array.isArray(page.data) ? page.data : page.data ? [page.data] : [];
      data.push(...items);
      included.push(...(page.included ?? []));
      total ??= page.meta?.paging?.total;
      next = page.links?.next;
      // The next link already carries the original query string.
      nextQuery = undefined;
    }

    // If we overshot within the last page, the remainder can't be resumed by cursor,
    // so only report `next` when we stopped exactly on a page boundary.
    const overshoot = data.length > maxItems;
    return {
      data: data.slice(0, maxItems),
      included,
      next: overshoot ? undefined : next,
      total,
    };
  }
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000);
  return Math.min(1000 * 2 ** attempt, 10_000) + Math.floor(Math.random() * 250);
}

async function readErrors(response: Response): Promise<JsonApiErrorObject[]> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { errors?: JsonApiErrorObject[] };
    if (Array.isArray(parsed.errors)) return parsed.errors;
  } catch {
    // Not JSON; fall through.
  }
  return text ? [{ detail: text.slice(0, 1000) }] : [];
}

async function readBody(response: Response): Promise<ApiResponse> {
  const contentType = response.headers.get('content-type') ?? '';
  const base = { status: response.status, contentType };

  if (response.status === 204) return { ...base, data: null };

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) return { ...base, data: null };

  // Sales and finance reports arrive as gzip files.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return { ...base, data: gunzipSync(bytes).toString('utf8') };
  }

  const text = bytes.toString('utf8');
  if (contentType.includes('json')) {
    return { ...base, data: JSON.parse(text) };
  }
  return { ...base, data: text };
}

/**
 * The typed API client (ADR-0011). Types come from `schema.d.ts`, generated from the backend's OpenAPI by
 * `make gen-api`. Use `api.get/post` (they throw `ApiError`); the raw `client` returns
 * `{ data, error, response }`, and `unwrap()` turns that into data or an `ApiError`.
 */
import createClient, { type FetchResponse, type MaybeOptionalInit, type Middleware } from 'openapi-fetch';

import { ApiError, toApiError } from './errors';
import type { paths } from './schema';

const UNAUTHENTICATED = 'auth:unauthenticated';
const events = new EventTarget();

/** The request that got a 401: a wrong password (`POST /api/auth/login`) is not a lost session. */
export interface UnauthenticatedRequest {
  method: string;
  /** The URL's path, without the query string. */
  path: string;
}

/** Calls `listener` after every 401 response (`AuthProvider` sends the user to the login page). Returns an unsubscribe. */
export function onUnauthenticated(listener: (request: UnauthenticatedRequest) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<UnauthenticatedRequest>).detail);
  events.addEventListener(UNAUTHENTICATED, handler);
  return () => events.removeEventListener(UNAUTHENTICATED, handler);
}

const middleware: Middleware = {
  onRequest({ request }) {
    // Marks the request as the SPA's own fetch (ADR-0003); P2-01's CSRF check relies on it.
    request.headers.set('X-Requested-With', 'fetch');
    return request;
  },
  async onResponse({ request, response, options }) {
    if (response.status === 401) {
      const detail: UnauthenticatedRequest = { method: request.method, path: new URL(request.url).pathname };
      events.dispatchEvent(new CustomEvent(UNAUTHENTICATED, { detail }));
    }
    // Only when the caller expects JSON (openapi-fetch's default); `parseAs: 'text' | 'blob' | …` is theirs.
    if (response.ok && (options.parseAs ?? 'json') === 'json') await assertJsonBody(response);
    return response;
  },
};

/**
 * A 2xx the caller parses as JSON must carry JSON (or nothing). An HTML page (an SPA fallback, a login page after a redirect) or a
 * truncated body would otherwise reach callers as a bare SyntaxError; it becomes an `ApiError` instead,
 * thrown by the raw client and the `api` wrappers alike.
 */
async function assertJsonBody(response: Response): Promise<void> {
  const text = await response.clone().text();
  if (!text) return;
  try {
    JSON.parse(text);
  } catch {
    throw new ApiError({
      status: response.status,
      code: 'http_error',
      title: 'Response is not JSON',
      requestId: response.headers.get('X-Request-ID'),
    });
  }
}

type Result<T> = { data?: T; error?: unknown; response: Response };

/**
 * The data of a successful result; throws `ApiError` for an error response, and for an empty 2xx other than
 * 204, which would otherwise resolve `undefined` under a non-nullable type.
 */
export function unwrap<T>(result: Result<T>): T {
  const { response } = result;
  if (!response.ok) throw toApiError(response, result.error);
  if (result.data === undefined && response.status !== 204) {
    throw new ApiError({
      status: response.status,
      code: 'http_error',
      title: 'Empty response',
      requestId: response.headers.get('X-Request-ID'),
    });
  }
  return result.data as T;
}

type PathsWith<M extends 'get' | 'post'> = {
  [P in keyof paths]: paths[P] extends Record<M, object> ? P : never;
}[keyof paths];
// The init argument is optional when the operation has no required parameters or body (as in openapi-fetch).
type InitArg<I> = undefined extends I ? [init?: I] : [init: I];
type Data<P extends keyof paths, M extends 'get' | 'post', I> = NonNullable<
  FetchResponse<paths[P][M] & object, I, `${string}/${string}`>['data']
>;

/**
 * A client and its throwing wrappers. The app uses the default instance below; tests pass an absolute
 * `baseUrl`, because Node's `Request` rejects relative URLs.
 */
export function createApiClient({ baseUrl = '' }: { baseUrl?: string } = {}) {
  // OpenAPI paths already start with /api, so the base is the page's own origin (same-origin, ADR-0003).
  // fetch is looked up per call, so tests can stub the global.
  const client = createClient<paths>({ baseUrl, fetch: (request) => globalThis.fetch(request) });
  client.use(middleware);
  const api = {
    async get<P extends PathsWith<'get'>, I extends MaybeOptionalInit<paths[P], 'get'>>(
      url: P,
      ...init: InitArg<I>
    ): Promise<Data<P, 'get', I>> {
      // openapi-fetch's own generics can't be re-expressed outside it; the signature above carries the types.
      const call = client.GET as (url: P, init?: I) => Promise<Result<Data<P, 'get', I>>>;
      return unwrap(await call(url, ...init));
    },
    async post<P extends PathsWith<'post'>, I extends MaybeOptionalInit<paths[P], 'post'>>(
      url: P,
      ...init: InitArg<I>
    ): Promise<Data<P, 'post', I>> {
      const call = client.POST as (url: P, init?: I) => Promise<Result<Data<P, 'post', I>>>;
      return unwrap(await call(url, ...init));
    },
  };
  return { client, api };
}

export const { client, api } = createApiClient();

import type { components } from './schema';

type Problem = components['schemas']['Problem'];
export type ProblemFieldError = components['schemas']['ProblemError'];

/** Every failed API call throws this. `code` is the backend's stable error code: branch on it, not on text. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string | null;
  readonly errors: ProblemFieldError[] | null;
  /** The backend's request id (the body's `request_id`, else the `X-Request-ID` header), for support. */
  readonly requestId: string | null;
  /** Whole seconds from a `Retry-After` header (a 429 `rate_limited`, a 503), or null if absent or not seconds. */
  readonly retryAfter: number | null;

  constructor(fields: {
    status: number;
    code: string;
    title: string;
    detail?: string | null;
    errors?: ProblemFieldError[] | null;
    requestId?: string | null;
    retryAfter?: number | null;
  }) {
    super(`${fields.status} ${fields.code}: ${fields.detail ?? fields.title}`);
    this.name = 'ApiError';
    this.status = fields.status;
    this.code = fields.code;
    this.title = fields.title;
    this.detail = fields.detail ?? null;
    this.errors = fields.errors ?? null;
    this.requestId = fields.requestId ?? null;
    this.retryAfter = fields.retryAfter ?? null;
  }
}

function isProblem(body: unknown): body is Problem {
  if (typeof body !== 'object' || body === null) return false;
  const { code, title } = body as Record<string, unknown>;
  return typeof code === 'string' && typeof title === 'string';
}

/**
 * The `ApiError` for a failed response and its parsed body. A body that isn't a problem (an HTML 502 from
 * a proxy, an empty 500) still becomes an `ApiError`, with `code: "http_error"`.
 */
/** `Retry-After` as delta-seconds; the HTTP-date form (the backend never sends it) and junk give null. */
function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,9}$/.test(value.trim())) return null;
  return Number(value.trim());
}

export function toApiError(response: Response, body: unknown): ApiError {
  const headerRequestId = response.headers.get('X-Request-ID');
  const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
  if (isProblem(body)) {
    return new ApiError({
      status: response.status,
      code: body.code,
      title: body.title,
      detail: body.detail,
      errors: body.errors,
      requestId: body.request_id || headerRequestId,
      retryAfter,
    });
  }
  return new ApiError({
    status: response.status,
    code: 'http_error',
    title: response.statusText || `HTTP ${response.status}`,
    requestId: headerRequestId,
    retryAfter,
  });
}

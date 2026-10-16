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

  constructor(fields: {
    status: number;
    code: string;
    title: string;
    detail?: string | null;
    errors?: ProblemFieldError[] | null;
    requestId?: string | null;
  }) {
    super(`${fields.status} ${fields.code}: ${fields.detail ?? fields.title}`);
    this.name = 'ApiError';
    this.status = fields.status;
    this.code = fields.code;
    this.title = fields.title;
    this.detail = fields.detail ?? null;
    this.errors = fields.errors ?? null;
    this.requestId = fields.requestId ?? null;
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
export function toApiError(response: Response, body: unknown): ApiError {
  const headerRequestId = response.headers.get('X-Request-ID');
  if (isProblem(body)) {
    return new ApiError({
      status: response.status,
      code: body.code,
      title: body.title,
      detail: body.detail,
      errors: body.errors,
      requestId: body.request_id || headerRequestId,
    });
  }
  return new ApiError({
    status: response.status,
    code: 'http_error',
    title: response.statusText || `HTTP ${response.status}`,
    requestId: headerRequestId,
  });
}

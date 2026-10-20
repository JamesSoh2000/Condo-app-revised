import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { createApiClient, onUnauthenticated } from './client';
import { ApiError } from './errors';
import type { components } from './schema';

// Node's Request needs an absolute URL; in the browser the default baseUrl "" is same-origin.
const { client, api } = createApiClient({ baseUrl: 'http://app.test' });

const fetchMock = vi.fn<(request: Request) => Promise<Response>>();

function problem(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/problem+json', ...headers },
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const VERSION = {
  service: 'condo-management-api',
  environment: 'test',
  git_sha: 'abc123',
  image_tag: 'local',
  build_time: 'local',
  server_time: '2026-10-16T00:00:00+00:00',
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastRequest(): Request {
  return fetchMock.mock.lastCall![0];
}

describe('X-Requested-With header (criterion 4)', () => {
  it('is sent on a GET through the api wrapper', async () => {
    fetchMock.mockResolvedValue(json(VERSION));

    await api.get('/api/version');

    expect(lastRequest().method).toBe('GET');
    expect(lastRequest().headers.get('X-Requested-With')).toBe('fetch');
  });

  it('is sent on a POST through the raw client', async () => {
    fetchMock.mockResolvedValue(json(VERSION));

    // No POST route exists yet; the header must not depend on the path or method.
    await client.request('post' as never, '/api/version' as never);

    expect(lastRequest().method).toBe('POST');
    expect(lastRequest().headers.get('X-Requested-With')).toBe('fetch');
  });

  it('is sent on a POST through the api wrapper', async () => {
    fetchMock.mockResolvedValue(json(VERSION));

    await api.post('/api/version' as never);

    expect(lastRequest().method).toBe('POST');
    expect(lastRequest().headers.get('X-Requested-With')).toBe('fetch');
  });
});

describe('typed success', () => {
  it('returns the parsed body', async () => {
    fetchMock.mockResolvedValue(json(VERSION));

    const version = await api.get('/api/version');

    expectTypeOf(version).toEqualTypeOf<components['schemas']['VersionOut']>();
    expect(version.git_sha).toBe('abc123');
    expect(new URL(lastRequest().url).pathname).toBe('/api/version');
  });
});

describe('generated types (criterion 1)', () => {
  it('rejects a path the backend does not have', () => {
    // Compile-time only (tsc checks test files): a renamed or removed backend path fails typecheck.
    expectTypeOf<typeof api.get>()
      .parameter(0)
      .toEqualTypeOf<
        | '/api/auth/me'
        | '/api/auth/sessions'
        | '/api/buildings/{building_id}'
        | '/api/buildings/{building_id}/files/{file_id}/download-url'
        | '/api/buildings/{building_id}/invitations'
        | '/api/buildings/{building_id}/notifications'
        | '/api/buildings/{building_id}/notifications/summary'
        | '/api/buildings/{building_id}/onboarding/me'
        | '/api/buildings/{building_id}/units'
        | '/api/health'
        | '/api/invitations/{token}'
        | '/api/join/{join_code}'
        | '/api/join/{join_code}/units'
        | '/api/ready'
        | '/api/version'
      >();
    // @ts-expect-error: not a backend path
    void (() => api.get('/api/versions'));
  });
});

describe('problem+json becomes ApiError (criterion 3)', () => {
  it('maps a 409 with every member', async () => {
    fetchMock.mockResolvedValue(
      problem(409, {
        type: '/problems/invalid-transition',
        title: 'Conflict',
        status: 409,
        code: 'invalid_transition',
        detail: 'The package was already picked up.',
        request_id: 'req-409',
      }),
    );

    const error = await api.get('/api/version').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'invalid_transition',
      title: 'Conflict',
      detail: 'The package was already picked up.',
      errors: null,
      requestId: 'req-409',
    });
  });

  it('keeps the field errors of a 422', async () => {
    const errors = [{ loc: ['body', 'name'], msg: 'Field required', type: 'missing' }];
    fetchMock.mockResolvedValue(
      problem(422, {
        type: '/problems/validation-error',
        title: 'Unprocessable Content',
        status: 422,
        code: 'validation_error',
        request_id: 'req-422',
        errors,
      }),
    );

    const error = await api.get('/api/version').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 422, code: 'validation_error', errors, requestId: 'req-422' });
  });

  it('throws from unwrap for a raw client result too', async () => {
    const { unwrap } = await import('./client');
    fetchMock.mockResolvedValue(problem(404, { title: 'Not Found', status: 404, code: 'not_found', request_id: 'r' }));

    const result = await client.GET('/api/version');

    expect(() => unwrap(result)).toThrow(ApiError);
  });
});

describe('error bodies that are not problem+json (criterion 8)', () => {
  it('takes requestId from X-Request-ID when a problem body has none', async () => {
    fetchMock.mockResolvedValue(
      problem(409, { title: 'Conflict', status: 409, code: 'conflict' }, { 'X-Request-ID': 'req-header' }),
    );

    const error = await api.get('/api/version').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 409, code: 'conflict', requestId: 'req-header' });
  });

  it('turns a 2xx that is not JSON (an SPA fallback page) into an ApiError', async () => {
    fetchMock.mockResolvedValue(
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html', 'X-Request-ID': 'req-html' },
      }),
    );

    const error = await api.get('/api/version').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 200, code: 'http_error', requestId: 'req-html' });
  });

  it('turns a 2xx with malformed JSON into an ApiError', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"git_sha": ', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const error = await api.get('/api/version').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 200, code: 'http_error' });
  });

  it('throws the same ApiError from the raw client for a non-JSON 2xx', async () => {
    fetchMock.mockResolvedValue(new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));

    await expect(client.GET('/api/version')).rejects.toMatchObject({ status: 200, code: 'http_error' });
  });

  it.each([
    ['text', 'text/csv', 'a,b\n1,2'],
    ['blob', 'application/pdf', '%PDF-1.7'],
  ] as const)('leaves a 2xx alone when the caller asked for parseAs %s', async (parseAs, type, body) => {
    fetchMock.mockResolvedValue(new Response(body, { status: 200, headers: { 'Content-Type': type } }));

    const result = await client.GET('/api/version', { parseAs });

    expect(result.response.ok).toBe(true);
    expect(result.data).toBeDefined();
  });

  it('still checks the body when the caller asks for parseAs json explicitly', async () => {
    fetchMock.mockResolvedValue(new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));

    await expect(client.GET('/api/version', { parseAs: 'json' })).rejects.toMatchObject({ code: 'http_error' });
  });

  it('still accepts an empty 204', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(api.get('/api/version')).resolves.toBeUndefined();
  });

  it('maps an HTML 502 to http_error with the X-Request-ID header', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>Bad Gateway</html>', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'Content-Type': 'text/html', 'X-Request-ID': 'req-502' },
      }),
    );

    const error = await api.get('/api/version').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 502,
      code: 'http_error',
      title: 'Bad Gateway',
      detail: null,
      errors: null,
      requestId: 'req-502',
    });
  });

  it('uses a null requestId when there is neither body nor header', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));

    const error = await api.get('/api/version').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 500, code: 'http_error', requestId: null });
  });

  it('ignores a JSON error body that is not a problem', async () => {
    fetchMock.mockResolvedValue(json({ code: 42, message: 'nope' }, 400));

    const error = await api.get('/api/version').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 400, code: 'http_error' });
  });
});

describe('401 emits auth:unauthenticated (criterion 7)', () => {
  it('emits once per 401 and still throws', async () => {
    const listener = vi.fn();
    const unsubscribe = onUnauthenticated(listener);
    fetchMock.mockResolvedValue(
      problem(401, { title: 'Unauthorized', status: 401, code: 'unauthorized', request_id: 'req-401' }),
    );

    const error = await api.get('/api/version').catch((e: unknown) => e);
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it.each([200, 403, 404, 409, 500])('does not emit on %i', async (status) => {
    const listener = vi.fn();
    const unsubscribe = onUnauthenticated(listener);
    fetchMock.mockResolvedValue(
      status === 200 ? json(VERSION) : problem(status, { title: 't', status, code: 'c', request_id: 'r' }),
    );

    await api.get('/api/version').catch(() => undefined);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops calling a listener after unsubscribe', async () => {
    const listener = vi.fn();
    onUnauthenticated(listener)();
    fetchMock.mockResolvedValue(problem(401, { title: 't', status: 401, code: 'unauthorized', request_id: 'r' }));

    await api.get('/api/version').catch(() => undefined);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('the 401 event names the request (P2-06a criteria 2 and 6)', () => {
  it('passes the method and path of the request that got the 401', async () => {
    const listener = vi.fn();
    const unsubscribe = onUnauthenticated(listener);
    fetchMock.mockResolvedValue(problem(401, { title: 't', status: 401, code: 'invalid_credentials', request_id: 'r' }));

    await api.post('/api/auth/login', { body: { email: 'a@example.test', password: 'x' } }).catch(() => undefined);
    unsubscribe();

    expect(listener).toHaveBeenCalledExactlyOnceWith({ method: 'POST', path: '/api/auth/login' });
  });

  it('gives the path without the query string', async () => {
    const listener = vi.fn();
    const unsubscribe = onUnauthenticated(listener);
    fetchMock.mockResolvedValue(problem(401, { title: 't', status: 401, code: 'unauthorized', request_id: 'r' }));

    await api.get('/api/auth/sessions', { params: { query: { limit: 5 } } } as never).catch(() => undefined);
    unsubscribe();

    expect(listener).toHaveBeenCalledExactlyOnceWith({ method: 'GET', path: '/api/auth/sessions' });
  });
});

describe('an empty 2xx other than 204 (P2-06a criterion 10)', () => {
  it.each([
    ['with Content-Length: 0', { 'Content-Length': '0' }],
    ['without Content-Length', {}],
  ])('throws http_error from api.get for an empty 200 %s', async (_label, headers) => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200, headers: { 'X-Request-ID': 'req-empty', ...headers } }));

    const error = await api.get('/api/auth/me').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 200, code: 'http_error', requestId: 'req-empty' });
  });

  it('throws http_error from api.post for an empty 201', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));

    await expect(api.post('/api/auth/logout')).rejects.toMatchObject({ status: 201, code: 'http_error' });
  });

  it('throws from unwrap for an empty raw-client 200', async () => {
    const { unwrap } = await import('./client');
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const result = await client.GET('/api/auth/me');

    expect(() => unwrap(result)).toThrow(ApiError);
  });

  it('still resolves undefined for a 204 through api.post', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(api.post('/api/auth/logout')).resolves.toBeUndefined();
  });
});

describe('ApiError.retryAfter (P2-06a criterion 3)', () => {
  function limited(retryAfter?: string) {
    return problem(
      429,
      { title: 'Too Many Requests', status: 429, code: 'rate_limited', request_id: 'r', retry_after: 7 },
      retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
    );
  }

  it('reads whole seconds from the Retry-After header', async () => {
    fetchMock.mockResolvedValue(limited('42'));

    const error = await api.post('/api/auth/logout').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 42 });
  });

  it.each([undefined, '', 'soon', '-3', '1.5', '1e3', 'Wed, 21 Oct 2026 07:28:00 GMT', '99999999999999999999'])(
    'is null for Retry-After %j',
    async (header) => {
      fetchMock.mockResolvedValue(limited(header));

      const error = await api.post('/api/auth/logout').catch((e: unknown) => e);

      expect(error).toMatchObject({ status: 429, retryAfter: null });
    },
  );

  it('accepts 0', async () => {
    fetchMock.mockResolvedValue(limited('0'));

    await expect(api.post('/api/auth/logout')).rejects.toMatchObject({ retryAfter: 0 });
  });

  it('is null on an error without the header', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));

    await expect(api.get('/api/version')).rejects.toMatchObject({ retryAfter: null });
  });
});

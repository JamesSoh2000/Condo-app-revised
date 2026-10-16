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
    expectTypeOf(api.get).parameter(0).toEqualTypeOf<'/api/health' | '/api/ready' | '/api/version'>();
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

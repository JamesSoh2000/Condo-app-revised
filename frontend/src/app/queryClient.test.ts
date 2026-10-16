import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiClient } from '@/api/client';
import { ApiError } from '@/api/errors';

import { createQueryClient, queryClient, shouldRetry } from './queryClient';

const { api } = createApiClient({ baseUrl: 'http://app.test' });
const fetchMock = vi.fn<(request: Request) => Promise<Response>>();

function respond(status: number) {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ title: 't', status, code: 'c', request_id: 'r' }), {
        status,
        headers: { 'Content-Type': 'application/problem+json' },
      }),
    );
}

/** Runs one query through a client with the app's options (no backoff delay) and counts requests. */
async function requestsFor(): Promise<number> {
  const client: QueryClient = createQueryClient({ retryDelay: 0 });
  await client.fetchQuery({ queryKey: ['version'], queryFn: () => api.get('/api/version') }).catch(() => undefined);
  return fetchMock.mock.calls.length;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('retry policy (criterion 5)', () => {
  it('does not retry a 404', async () => {
    fetchMock.mockImplementation(respond(404));

    expect(await requestsFor()).toBe(1);
  });

  it('retries a 503 at most twice', async () => {
    fetchMock.mockImplementation(respond(503));

    expect(await requestsFor()).toBe(3);
  });

  it('retries a network error at most twice', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    expect(await requestsFor()).toBe(3);
  });

  it.each([400, 401, 403, 409, 422])('does not retry a %i', async (status) => {
    fetchMock.mockImplementation(respond(status));

    expect(await requestsFor()).toBe(1);
  });

  it('stops retrying once a 503 turns into a success', async () => {
    fetchMock.mockImplementationOnce(respond(503)).mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    expect(await requestsFor()).toBe(2);
  });

  it('does not retry other errors', () => {
    expect(shouldRetry(0, new Error('a bug in a queryFn'))).toBe(false);
    expect(shouldRetry(0, new ApiError({ status: 500, code: 'c', title: 't' }))).toBe(true);
    expect(shouldRetry(2, new ApiError({ status: 500, code: 'c', title: 't' }))).toBe(false);
  });
});

describe('defaults (criterion 10)', () => {
  it('uses a 30 s stale time and refetches on window focus', () => {
    const queries = queryClient.getDefaultOptions().queries;

    expect(queries?.staleTime).toBe(30_000);
    expect(queries?.refetchOnWindowFocus).toBe(true);
    expect(queries?.retry).toBe(shouldRetry);
  });
});

import { QueryClient, type DefaultOptions } from '@tanstack/react-query';

import { ApiError } from '@/api/errors';

const MAX_RETRIES = 2;

/**
 * Retry a failed query at most twice, and only when trying again can help: a network error (`fetch`
 * rejects with a `TypeError`) or a 5xx. A 4xx is the same answer next time, so it is never retried.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  if (error instanceof ApiError) return error.status >= 500;
  return error instanceof TypeError;
}

/** A client with the app's query defaults; `overrides` exist for tests (`retryDelay: 0`). */
export function createQueryClient(overrides: DefaultOptions['queries'] = {}): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: shouldRetry,
        ...overrides,
      },
    },
  });
}

export const queryClient = createQueryClient();

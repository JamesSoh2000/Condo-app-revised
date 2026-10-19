import { MutationCache, QueryCache, QueryClient, type DefaultOptions, type QueryKey } from '@tanstack/react-query';

import { ApiError } from '@/api/errors';
import { recordBuildingDenial } from '@/app/buildingDenial';

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
  // The caches' own onError runs for every failed query and mutation, for the client's lifetime, and before a
  // mutation's own callbacks (inbox B-5; review round 4).
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => recordBuildingDenial(client, query.queryKey, error),
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        const key: QueryKey | undefined = mutation.options.mutationKey;
        recordBuildingDenial(client, key, error);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: shouldRetry,
        ...overrides,
      },
    },
  });
  return client;
}

export const queryClient = createQueryClient();

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { api, onUnauthenticated } from '@/api/client';
import type { components } from '@/api/schema';
import { runAuthCall } from '@/app/authQueue';
import { clearSelectedBuilding } from '@/app/buildingStorage';
import { isLoginPath, loginPath } from '@/app/safeNext';

export type Me = components['schemas']['MeOut'];

/** The signed-in user and their memberships (P2-02). A 401 means there is no session. */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    // The signal aborts the request when the query is cancelled or superseded.
    queryFn: ({ signal }) => api.get('/api/auth/me', { signal }),
  });
}

/**
 * Logs out on the server first: if that fails, the session is still live, so the user stays signed in and
 * sees `error`. On success the cache is emptied, so nothing of this user is left for the next one.
 */
export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState(false);
  const mutation = useMutation({
    // Navigating and clearing happen inside the queued call, so a login queued after it runs after them.
    mutationFn: () =>
      runAuthCall(async () => {
        await api.post('/api/auth/logout');
        navigate('/login', { replace: true });
        queryClient.clear();
        clearSelectedBuilding();
      }),
    onMutate: () => setError(false),
    onError: () => setError(true),
  });
  return { logout: () => mutation.mutate(), pending: mutation.isPending, error };
}

/**
 * A 401 from any call means the session is gone (expired, revoked, logged out in another tab): drop all
 * cached data and go to the login page, returning here afterwards. The login call's own 401 is a wrong
 * password, not a lost session, so it is left to the login page.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // The listener reads the location at the time of the 401, not the one it was subscribed with.
  const location = useLocation();
  const locationRef = useRef(location);
  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  // `/me` answering for another user than before means another tab logged in on the shared cookie: drop
  // everything cached for the previous user, and their building selection (review round 1, Claude M1).
  useEffect(() => {
    let userId = queryClient.getQueryData<Me>(['me'])?.user.id;
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.query.queryHash !== '["me"]') return;
      const next = (event.query.state.data as Me | undefined)?.user.id;
      if (next === undefined) return;
      if (userId !== undefined && next !== userId) {
        queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
        clearSelectedBuilding();
      }
      userId = next;
    });
  }, [queryClient]);

  useEffect(
    () =>
      onUnauthenticated(({ method, path }) => {
        if (method === 'POST' && path === '/api/auth/login') return;
        queryClient.clear();
        clearSelectedBuilding();
        const current = locationRef.current;
        if (!isLoginPath(current.pathname)) navigate(loginPath(current), { replace: true });
      }),
    [queryClient, navigate],
  );

  return children;
}

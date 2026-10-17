import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { api, onUnauthenticated } from '@/api/client';
import type { components } from '@/api/schema';
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

// Settles when the latest logout call has finished, whatever its outcome (review round 2, Codex M1).
let logoutSettled: Promise<void> = Promise.resolve();

/**
 * The login page waits on this before logging in. A logout response deletes the session cookie, and the
 * server may revoke the session (so a refetch sends the user to login) before that response arrives: a
 * login that finished first would have its new cookie deleted and its user sent back to /login.
 */
export function whenLogoutSettled(): Promise<void> {
  return logoutSettled;
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
    mutationFn: () => {
      // Navigating and clearing happen inside the settled promise, so a waiting login runs after them.
      const run = api.post('/api/auth/logout').then(() => {
        navigate('/login', { replace: true });
        queryClient.clear();
      });
      logoutSettled = run.catch(() => undefined);
      return run;
    },
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

  useEffect(
    () =>
      onUnauthenticated(({ method, path }) => {
        if (method === 'POST' && path === '/api/auth/login') return;
        queryClient.clear();
        const current = locationRef.current;
        if (!isLoginPath(current.pathname)) navigate(loginPath(current), { replace: true });
      }),
    [queryClient, navigate],
  );

  return children;
}

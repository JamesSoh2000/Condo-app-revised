import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { ApiError } from '@/api/errors';
import { useMe } from '@/app/AuthProvider';
import { loginPath } from '@/app/safeNext';
import { FullPageMessage, LoadingScreen } from '@/app/screens';

/**
 * Renders `children` only for a signed-in user. Like every guard here it is UX only: the server checks the
 * session on every request, so a guard that let someone through would show them nothing but errors.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();

  // Cached data stays shown during a background refetch; a 401 there is handled by AuthProvider.
  if (me.data) return children;
  if (me.isPending) return <LoadingScreen />;
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to={loginPath(location)} replace />;
  }
  return (
    <FullPageMessage title="Something went wrong">
      <p>We could not load your account. Check your connection and try again.</p>
      <button type="button" className="mt-4 rounded bg-slate-900 px-4 py-2 text-white" onClick={() => void me.refetch()}>
        Try again
      </button>
    </FullPageMessage>
  );
}

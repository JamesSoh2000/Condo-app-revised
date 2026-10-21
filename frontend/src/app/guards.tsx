import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { ApiError } from '@/api/errors';
import type { components } from '@/api/schema';
import { useMe } from '@/app/AuthProvider';
import { useBuilding, useBuildingContext, useBuildingDenied } from '@/app/BuildingProvider';
import { hasFeature, hasRole, type PageAccess } from '@/app/pages';
import { loginPath } from '@/app/safeNext';
import { FullPageMessage, LoadingScreen } from '@/app/screens';
import { BuildingPicker, LostAccessScreen, MembershipStatusScreen } from '@/features/membership/MembershipScreens';

type Role = components['schemas']['Role'];
type Feature = components['schemas']['Feature'];

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

/**
 * Renders `children` only once the tab has an active building, its `GET /api/buildings/{id}` loaded. Without
 * an active membership it explains why, and requests under `/api/buildings/` only the caller's own `onboarding/me`
 * (P4-08a), which needs no active membership.
 */
export function RequireActiveMembership({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  const { buildingId, active, select } = useBuildingContext();

  if (active.length === 0) return <MembershipStatusScreen memberships={me?.memberships ?? []} />;
  if (buildingId === null) return <BuildingPicker memberships={active} onPick={select} />;
  return <BuildingLoaded>{children}</BuildingLoaded>;
}

function BuildingLoaded({ children }: { children: ReactNode }) {
  const building = useBuilding();
  const denied = useBuildingDenied();
  const { reset } = useBuildingContext();
  const queryClient = useQueryClient();

  // Checked before the cached data: a refetch that fails keeps the old `data`, and a 401 or 404 means it
  // must not be shown any more (review round 1). Other errors (5xx, network) keep the page on cached data.
  const status = building.error instanceof ApiError ? building.error.status : null;
  // A 401 is AuthProvider's (it goes to the login page); until then, nothing to show.
  if (status === 401) return <LoadingScreen />;
  // A 404, or a denial seen on another of the building's requests that a later 5xx must not undo (inbox B-5).
  if (denied) {
    const chooseAgain = () => {
      reset();
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    };
    return <LostAccessScreen onChooseAgain={chooseAgain} />;
  }
  if (building.data) return children;
  if (building.isPending) return <LoadingScreen />;
  return (
    <section className="py-12 text-center">
      <h1 className="mb-2 text-2xl font-semibold">Something went wrong</h1>
      <p>We could not load your building. Check your connection and try again.</p>
      <button type="button" className="mt-4 rounded bg-slate-900 px-4 py-2 text-white" onClick={() => void building.refetch()}>
        Try again
      </button>
    </section>
  );
}

/** `/403` unless the caller holds one of `roles` in the selected building (from the building endpoint). */
export function RequireRole({ roles, children }: { roles: readonly Role[]; children: ReactNode }) {
  const { data } = useBuilding();
  if (!data) return null;
  return hasRole(data, roles) ? children : <Navigate to="/403" replace />;
}

/** `/403` unless the selected building has `feature` enabled. */
export function RequireFeature({ feature, children }: { feature: Feature; children: ReactNode }) {
  const { data } = useBuilding();
  if (!data) return null;
  return hasFeature(data, feature) ? children : <Navigate to="/403" replace />;
}

/** A page's `PAGE_ACCESS` row as guards. */
export function RequirePageAccess({ access, children }: { access: PageAccess; children: ReactNode }) {
  let guarded = children;
  if (access.feature) guarded = <RequireFeature feature={access.feature}>{guarded}</RequireFeature>;
  if (access.roles) guarded = <RequireRole roles={access.roles}>{guarded}</RequireRole>;
  return guarded;
}

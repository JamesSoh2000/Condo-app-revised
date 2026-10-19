import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, Outlet } from 'react-router-dom';

import { ApiError } from '@/api/errors';
import { AccountMenu } from '@/app/AccountMenu';
import { useLogout } from '@/app/AuthProvider';
import { useBuilding, useBuildingContext } from '@/app/BuildingProvider';
import { MainNav } from '@/app/MainNav';
import { NotificationBell } from '@/features/notifications/NotificationBell';

/**
 * The signed-in frame: header with the notification bell (P3-05) and the account menu, the navigation
 * (P2-06c), then the page.
 */
export function AppShell() {
  const { logout, pending, error } = useLogout();
  const { buildingId } = useBuildingContext();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex items-center justify-between gap-4 border-b bg-white px-4 py-3">
        <Link to="/" className="font-semibold">
          Condo Management
        </Link>
        <div className="flex items-center gap-3">
          {buildingId !== null && <LoadedBuildingBell />}
          <AccountMenu onLogout={logout} loggingOut={pending} />
        </div>
      </header>
      <MainNav />
      {error && (
        <p role="alert" className="bg-red-50 px-4 py-2 text-sm text-red-800">
          Could not log out, try again.
        </p>
      )}
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * The bell, once the guards have loaded the selected building: it reads their answer and never asks for the
 * building itself, so a session-only page (`/403`, onboarding) or a building the user lost sends no
 * notification request (P2-06b, P2-06c).
 */
function LoadedBuildingBell() {
  const building = useBuilding({ passive: true });
  const queryClient = useQueryClient();
  // Like BuildingNav: a 401 or 404 on a refetch means the cached building, and so its notifications, must not
  // be shown any more (review round 1, Codex F1). The denial lasts until a building answer newer than it
  // succeeds, so a later 5xx (which replaces the 404 as the query's error) doesn't bring the bell back, and the
  // building's notifications are dropped from the cache (review round 2, Codex R2-F1).
  const status = building.error instanceof ApiError ? building.error.status : null;
  const deniedNow = status === 401 || status === 404;
  const [deniedAt, setDeniedAt] = useState(0);
  const { errorUpdatedAt, dataUpdatedAt } = building;
  const buildingId = building.data?.id;
  useEffect(() => {
    if (!deniedNow || buildingId === undefined) return;
    setDeniedAt(errorUpdatedAt);
    queryClient.removeQueries({ queryKey: ['b', buildingId, 'notifications'] });
  }, [deniedNow, errorUpdatedAt, buildingId, queryClient]);

  if (!building.data || deniedNow || deniedAt > dataUpdatedAt) return null;
  // Keyed by building, so nothing of one building's panel (an open state, a failed mark-read) shows in the next.
  return <NotificationBell key={building.data.id} />;
}

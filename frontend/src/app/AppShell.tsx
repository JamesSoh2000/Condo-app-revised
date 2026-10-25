import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, type RefObject } from 'react';
import { Link, Outlet } from 'react-router-dom';

import { AccountMenu } from '@/app/AccountMenu';
import { useLogout } from '@/app/AuthProvider';
import { useBuilding, useBuildingContext, useBuildingDenied } from '@/app/BuildingProvider';
import { MainNav } from '@/app/MainNav';
import { hasFeature } from '@/app/pages';
import { UrgentBanner } from '@/features/notices/UrgentBanner';
import { NotificationBell } from '@/features/notifications/NotificationBell';

/**
 * The signed-in frame: header with the notification bell (P3-05) and the account menu, the navigation
 * (P2-06c), then the page. Below 640 px the header is what their panels are placed against (P4-08h).
 */
export function AppShell() {
  const { logout, pending, error } = useLogout();
  const { buildingId } = useBuildingContext();
  const bannerSlot = useRef<HTMLDivElement>(null);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="relative flex items-center justify-between gap-4 border-b bg-white px-4 py-3">
        <Link to="/" className="font-semibold">
          Condo Management
        </Link>
        <div className="flex items-center gap-3">
          {buildingId !== null && <LoadedBuildingBell />}
          <AccountMenu onLogout={logout} loggingOut={pending} />
        </div>
      </header>
      <MainNav />
      {/* Mounted before the banner's content arrives, so a screen reader announces it, without moving focus (P6-02b).
          Focusable from script only: an acknowledged row hands focus here (review round 2). */}
      <div ref={bannerSlot} aria-live="polite" tabIndex={-1} className="outline-none">
        {buildingId !== null && <LoadedBuildingBanner slotRef={bannerSlot} />}
      </div>
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
  const denied = useBuildingDenied();
  const queryClient = useQueryClient();
  const buildingId = building.data?.id;
  // A denied building's notifications are private data the tab may no longer hold: drop them once the bell is
  // gone (review rounds 1–3, Codex F1, R2-F1, R3-F1; the denial itself is shared, inbox B-5).
  useEffect(() => {
    if (denied && buildingId !== undefined) queryClient.removeQueries({ queryKey: ['b', buildingId, 'notifications'] });
  }, [denied, buildingId, queryClient]);

  if (!building.data || denied) return null;
  // Keyed by building, so nothing of one building's panel (an open state, a failed mark-read) shows in the next.
  return <NotificationBell key={building.data.id} />;
}

/**
 * The urgent banner (P6-02b), as the bell: only once the guards have loaded the selected building, never for a denied
 * one or one with notices off, so none of those asks for the notices summary.
 */
function LoadedBuildingBanner({ slotRef }: { slotRef: RefObject<HTMLDivElement> }) {
  const building = useBuilding({ passive: true });
  const denied = useBuildingDenied();
  if (!building.data || denied || !hasFeature(building.data, 'notices')) return null;
  // Keyed by building, so nothing of one building's banner shows in the next.
  return <UrgentBanner key={building.data.id} buildingId={building.data.id} slotRef={slotRef} />;
}

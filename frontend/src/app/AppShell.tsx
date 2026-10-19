import { Link, Outlet } from 'react-router-dom';

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
  const { data: building } = useBuilding({ passive: true });
  return building ? <NotificationBell /> : null;
}

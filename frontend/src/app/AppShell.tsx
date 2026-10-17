import { Link, Outlet } from 'react-router-dom';

import { useLogout, useMe } from '@/app/AuthProvider';
import { useBuildingContext } from '@/app/BuildingProvider';

/** The signed-in frame: header with the building, the user and "Log out", then the page. P2-06c adds the navigation. */
export function AppShell() {
  const { data: me } = useMe();
  const { logout, pending, error } = useLogout();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex items-center justify-between gap-4 border-b bg-white px-4 py-3">
        <Link to="/" className="font-semibold">
          Condo Management
        </Link>
        <div className="flex items-center gap-3">
          <BuildingSwitcher />
          <span className="text-sm text-slate-700">{me?.user.full_name}</span>
          <button
            type="button"
            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
            onClick={logout}
            disabled={pending}
          >
            Log out
          </button>
        </div>
      </header>
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

/** The tab's building: its name, or a switcher with several active memberships (P2-06c moves it into a menu). */
function BuildingSwitcher() {
  const { buildingId, active, select } = useBuildingContext();
  if (buildingId === null) return null;
  if (active.length === 1) return <span className="text-sm font-medium">{active[0].building.name}</span>;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Building</span>
      <select className="rounded border px-2 py-1" value={buildingId} onChange={(event) => select(event.target.value)}>
        {active.map((m) => (
          <option key={m.building.id} value={m.building.id}>
            {m.building.name}
          </option>
        ))}
      </select>
    </label>
  );
}

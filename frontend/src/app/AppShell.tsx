import { Link, Outlet } from 'react-router-dom';

import { useLogout, useMe } from '@/app/AuthProvider';

/** The signed-in frame: header with the user and "Log out", then the page. P2-06b adds the navigation. */
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

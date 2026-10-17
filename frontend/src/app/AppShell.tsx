import { Link, Outlet } from 'react-router-dom';

import { AccountMenu } from '@/app/AccountMenu';
import { useLogout } from '@/app/AuthProvider';
import { MainNav } from '@/app/MainNav';

/** The signed-in frame: header with the account menu, the navigation (P2-06c), then the page. */
export function AppShell() {
  const { logout, pending, error } = useLogout();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex items-center justify-between gap-4 border-b bg-white px-4 py-3">
        <Link to="/" className="font-semibold">
          Condo Management
        </Link>
        <AccountMenu onLogout={logout} loggingOut={pending} />
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

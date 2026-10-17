import { Route, Routes } from 'react-router-dom';

import { AppShell } from '@/app/AppShell';
import { RequireAuth } from '@/app/guards';
import { DEMO_PAGES } from '@/app/routeScope';
import { BeingMigrated, HomePlaceholder, NotFoundPage } from '@/app/screens';
import { LoginPage } from '@/features/auth/pages/LoginPage';

/**
 * The app's routes. Legacy demo pages keep their old paths but render a placeholder until their slice
 * migrates them, so the shell imports no Base44 page (P2-06a). Other legacy pages are 404, as before.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<HomePlaceholder />} />
        {DEMO_PAGES.map((page) => (
          <Route key={page} path={`/${page}`} element={<BeingMigrated page={page} />} />
        ))}
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

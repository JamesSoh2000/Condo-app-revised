import { Outlet, Route, Routes } from 'react-router-dom';

import { AppShell } from '@/app/AppShell';
import { BuildingProvider } from '@/app/BuildingProvider';
import { RequireActiveMembership, RequireAuth, RequirePageAccess } from '@/app/guards';
import { PAGE_ACCESS } from '@/app/pages';
import { DEMO_PAGES } from '@/app/routeScope';
import { BeingMigrated, ForbiddenPage, HomePlaceholder, NotFoundPage } from '@/app/screens';
import { ForgotPasswordPage } from '@/features/auth/pages/ForgotPasswordPage';
import { LoginPage } from '@/features/auth/pages/LoginPage';
import { ResetPasswordPage } from '@/features/auth/pages/ResetPasswordPage';

const onboardingPages = DEMO_PAGES.filter((page) => PAGE_ACCESS[page].onboarding);
const buildingPages = DEMO_PAGES.filter((page) => !PAGE_ACCESS[page].onboarding);

/**
 * The app's routes. Legacy demo pages keep their old paths but render a placeholder until their slice
 * migrates them, so the shell imports no Base44 page (P2-06a). Other legacy pages are 404, as before.
 * Building pages need an active building and their `PAGE_ACCESS` row (P2-06b); `/403` and the onboarding
 * pages need only a session. The login and password-reset pages need none.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
      <Route
        element={
          <RequireAuth>
            <BuildingProvider>
              <AppShell />
            </BuildingProvider>
          </RequireAuth>
        }
      >
        <Route path="/403" element={<ForbiddenPage />} />
        {onboardingPages.map((page) => (
          <Route key={page} path={`/${page}`} element={<BeingMigrated page={page} />} />
        ))}
        <Route
          element={
            <RequireActiveMembership>
              <Outlet />
            </RequireActiveMembership>
          }
        >
          <Route index element={<HomePlaceholder />} />
          {buildingPages.map((page) => (
            <Route
              key={page}
              path={`/${page}`}
              element={
                <RequirePageAccess access={PAGE_ACCESS[page]}>
                  <BeingMigrated page={page} />
                </RequirePageAccess>
              }
            />
          ))}
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

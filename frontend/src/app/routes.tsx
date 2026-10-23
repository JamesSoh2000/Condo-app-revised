import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import { AppShell } from '@/app/AppShell';
import { useSessionEpoch } from '@/app/AuthProvider';
import { BuildingProvider } from '@/app/BuildingProvider';
import { RequireActiveMembership, RequireAuth, RequirePageAccess } from '@/app/guards';
import { PAGE_ACCESS, pagePath } from '@/app/pages';
import { DEMO_PAGES, type DemoPage } from '@/app/routeScope';
import { BeingMigrated, ForbiddenPage, HomePlaceholder, NotFoundPage } from '@/app/screens';
import { ForgotPasswordPage } from '@/features/auth/pages/ForgotPasswordPage';
import { AcceptInvitePage, InviteInvalid } from '@/features/auth/pages/AcceptInvitePage';
import { LoginPage } from '@/features/auth/pages/LoginPage';
import { ResetLinkInvalid, ResetPasswordPage } from '@/features/auth/pages/ResetPasswordPage';
import { JoinInvalid, JoinPage } from '@/features/onboarding/JoinPage';
import { MyPackagesPage } from '@/features/packages/pages/MyPackagesPage';
import { SecurityPackagesPage } from '@/features/packages/pages/SecurityPackagesPage';
import { ResidentsPage } from '@/features/residents/ResidentsPage';

/**
 * The app's routes. Legacy demo pages keep their old paths but render a placeholder until their slice
 * migrates them, so the shell imports no Base44 page (P2-06a); a migrated page takes its own path (P4-08b), and its
 * legacy path redirects there (P5-03b), unless it differs only in case (P5-04). Other legacy pages are 404, as before.
 * Building pages need an active building and their `PAGE_ACCESS` row (P2-06b); `/403` needs only a session. The
 * login, password-reset, invitation and join pages need none; their paths without a token or code show the page's
 * invalid-link screen, not "Page not found".
 */
export function AppRoutes() {
  // A new user in the tab rebuilds the signed-in tree (P4-07b review round 3).
  const epoch = useSessionEpoch();
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
      <Route path="/reset-password/*" element={<ResetLinkInvalid />} />
      <Route path="/invite/:token" element={<AcceptInvitePage />} />
      <Route path="/invite/*" element={<InviteInvalid />} />
      <Route path="/join/:code" element={<JoinPage />} />
      <Route path="/join/*" element={<JoinInvalid />} />
      <Route
        element={
          <RequireAuth key={epoch}>
            <BuildingProvider>
              <AppShell />
            </BuildingProvider>
          </RequireAuth>
        }
      >
        <Route path="/403" element={<ForbiddenPage />} />
        <Route
          element={
            <RequireActiveMembership>
              <Outlet />
            </RequireActiveMembership>
          }
        >
          <Route index element={<HomePlaceholder />} />
          <Route
            path={PAGE_ACCESS.Residents.path}
            element={
              <RequirePageAccess access={PAGE_ACCESS.Residents}>
                <ResidentsPage />
              </RequirePageAccess>
            }
          />
          <Route
            path={PAGE_ACCESS.SecurityPackages.path}
            element={
              <RequirePageAccess access={PAGE_ACCESS.SecurityPackages}>
                <SecurityPackagesPage />
              </RequirePageAccess>
            }
          />
          {/* One route for the list and a package, so the page stays mounted between them (P5-04 D2). */}
          <Route
            path={`${PAGE_ACCESS.Packages.path}/:packageId?`}
            element={
              <RequirePageAccess access={PAGE_ACCESS.Packages}>
                <MyPackagesPage />
              </RequirePageAccess>
            }
          />
          {DEMO_PAGES.filter((page) => !sameLegacyPath(page)).map((page) => (
            <Route
              key={page}
              path={`/${page}`}
              element={
                PAGE_ACCESS[page].path ? (
                  <LegacyRedirect to={pagePath(page)} />
                ) : (
                  <RequirePageAccess access={PAGE_ACCESS[page]}>
                    <BeingMigrated page={page} />
                  </RequirePageAccess>
                )
              }
            />
          ))}
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

/**
 * True if a migrated page's own path is its legacy `/<Name>` in another case (`/packages`): the router matches paths
 * case-insensitively, so the page's route already answers the legacy path, and a redirect there would loop (P5-04 D2).
 */
function sameLegacyPath(page: DemoPage): boolean {
  return pagePath(page).toLowerCase() === `/${page}`.toLowerCase() && pagePath(page) !== `/${page}`;
}

/** A migrated page's legacy `/<Name>` path: to its own path, with the query and hash, so old links keep working. */
function LegacyRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate replace to={{ pathname: to, search, hash }} />;
}

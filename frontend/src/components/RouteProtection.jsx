import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { createPageUrl } from '@/utils';

export function useRouteProtection(user, activeViewRole) {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!user) return;

    // If user hasn't completed onboarding, redirect to onboarding
    if (!user.account_type) {
      if (location.pathname !== createPageUrl('Onboarding').replace(/^\//, '')) {
        navigate(createPageUrl('Onboarding'));
      }
      return;
    }

    // Pending-approval residents: only allow the Profile page; redirect everything else there
    if (user.account_type === 'resident' && user.residentApprovalStatus === 'pending_approval') {
      const currentPath = location.pathname.toLowerCase();
      const isOnProfile = currentPath.includes('/profile');
      if (!isOnProfile) {
        navigate(createPageUrl('Profile'));
        return;
      }
    }

    const currentPath = location.pathname.toLowerCase();
    const isAdmin = user.isAdmin || user.management_role === 'board' || user.app_role === 'board';

    // For board members, determine effective access based on activeViewRole
    const effectiveAccountType = isAdmin && activeViewRole
      ? (activeViewRole === 'resident' ? 'resident' : 'management')
      : user.account_type;
    const effectiveRole = isAdmin && activeViewRole ? activeViewRole : (user.management_role || user.app_role);

    const accountType = effectiveAccountType;
    const role = effectiveRole;

    // Define protected routes
    // '/visitoraccess' is intentionally kept here to block direct URL access (feature temporarily disabled)
    const residentOnlyRoutes = ['/packages', '/visitoraccess', '/gameroom', '/speakeasy', '/maintenance', '/securityreport', '/concierge'];
    const disabledRoutes = ['/visitoraccess'];
    const securityRoutes = ['/securitypackages', '/visitorverification', '/securitygameroom', '/securityspeakeasy', '/securityreports', '/securityreportslist', '/securityshiftreports', '/managementnotices'];
    const managementRoutes = ['/managementmaintenance', '/managementspeakeasy', '/managementnotices'];
    const boardRoutes = ['/boardoverview'];

    // Block disabled routes for all users
    if (disabledRoutes.some(route => currentPath.includes(route.toLowerCase()))) {
      navigate(createPageUrl('Dashboard'));
      return;
    }

    // Residents trying to access management routes (except board members accessing board routes)
    if (accountType === 'resident') {
      const isAccessingBoardRoute = boardRoutes.some(route => currentPath.includes(route.toLowerCase()));

      // Allow board members to access board routes even in resident view
      if (isAccessingBoardRoute && isAdmin) {
        return;
      }

      const isAccessingManagement =
        securityRoutes.some(route => currentPath.includes(route.toLowerCase())) ||
        managementRoutes.some(route => currentPath.includes(route.toLowerCase())) ||
        isAccessingBoardRoute;

      if (isAccessingManagement) {
        console.log('[ROUTE GUARD] REDIRECTED_TO_DASHBOARD reason=resident_accessing_management from=' + currentPath + ' role=' + role);
        navigate(createPageUrl('Dashboard'));
        return;
      }
    }

    // Management users trying to access resident-specific routes (unless they're board members)
    if (accountType === 'management' && !isAdmin) {
      const isAccessingResidentOnly = residentOnlyRoutes.some(route =>
        currentPath.includes(route.toLowerCase())
      );

      if (isAccessingResidentOnly) {
        console.log('[ROUTE GUARD] REDIRECTED_TO_DASHBOARD reason=management_accessing_resident_only from=' + currentPath + ' role=' + role);
        navigate(createPageUrl('Dashboard'));
        return;
      }

      // Role-specific restrictions within management (skip for admins)
      if (!isAdmin) {
        if (role === 'security') {
          const isAccessingUnauthorized =
            managementRoutes.some(route => currentPath.includes(route.toLowerCase()) && route !== '/managementnotices') ||
            boardRoutes.some(route => currentPath.includes(route.toLowerCase()));

          if (isAccessingUnauthorized) {
            console.log('[ROUTE GUARD] REDIRECTED_TO_DASHBOARD reason=security_accessing_unauthorized from=' + currentPath + ' role=' + role);
            navigate(createPageUrl('Dashboard'));
            return;
          }
        }

        if (role === 'property_management') {
          const isAccessingUnauthorized =
            securityRoutes.some(route => currentPath.includes(route.toLowerCase()) && route !== '/managementnotices') ||
            boardRoutes.some(route => currentPath.includes(route.toLowerCase()));

          if (isAccessingUnauthorized) {
            console.log('[ROUTE GUARD] REDIRECTED_TO_DASHBOARD reason=property_management_accessing_unauthorized from=' + currentPath + ' role=' + role);
            navigate(createPageUrl('Dashboard'));
            return;
          }
        }
      }
    }
  }, [user, activeViewRole, location.pathname, navigate]);
}

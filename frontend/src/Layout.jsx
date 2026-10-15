import React, { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import BottomTabs from '@/components/BottomTabs';
import { base44 } from '@/api/base44Client';
import { motion, AnimatePresence } from 'framer-motion';
import { 
              LayoutDashboard, 
              Package, 
              ShieldAlert, 
              Wrench, 
              Gamepad2, 
              Wine, 
              CalendarDays, 
              LogOut, 
              User,
              MessageSquare,
              Menu,
              X,
              UserCheck,
              Truck,
              Camera,
              CheckCircle2,
              BookUser,
              ChevronLeft
            } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createPageUrl } from '@/utils';
import { isDemoPath, isDemoViewRole } from '@/app/routeScope';
import { useRouteProtection } from '@/components/RouteProtection';
import RoleSwitcher from '@/components/RoleSwitcher';
import EmergencyListener from '@/components/EmergencyListener';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import { useLanguage } from '@/lib/LanguageContext';

export default function Layout({ children }) {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [unreadGameroomCount, setUnreadGameroomCount] = useState(0);
  const [unreadBoardReportsCount, setUnreadBoardReportsCount] = useState(0);
  const [packageBadgeCount, setPackageBadgeCount] = useState(0);
  const [unviewedMoveRequestsCount, setUnviewedMoveRequestsCount] = useState(0);
  const [pendingResidentsCount, setPendingResidentsCount] = useState(0);
  const [activeViewRole, setActiveViewRole] = useState(null);
  const [displayUser, setDisplayUser] = useState(null);
  const [justApproved, setJustApproved] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useLanguage();

  // Routes where back button should NOT appear (top-level pages)
  const TOP_LEVEL_PATHS = ['/', '/Dashboard', '/packages', '/Profile', '/gameroom', '/speakeasy', '/concierge', '/MoveRequest', '/BoardOverview'];
  const showBackButton = !TOP_LEVEL_PATHS.includes(location.pathname);

  // Body scroll lock when mobile menu is open
  useEffect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileMenuOpen]);

  // Real-time approval watcher: only active while resident is pending
  useEffect(() => {
    if (!user || user.account_type !== 'resident' || user.residentApprovalStatus !== 'pending_approval') return;

    const checkApproval = async () => {
      try {
        const profiles = await base44.entities.ResidentProfile.filter({ user_id: user.id });
        if (profiles.length === 0) return;
        const rp = profiles[0];
        if (rp.status === 'approved') {
          // Approval detected — trigger smooth transition
          setJustApproved(true);
          setTimeout(async () => {
            // Re-run full auth/profile resolution to update user state
            const updatedUser = await base44.auth.me();
            if (updatedUser.management_role === 'board' || updatedUser.app_role === 'board') {
              updatedUser.isAdmin = true;
            }
            updatedUser.residentApprovalStatus = 'approved';
            setUser(updatedUser);
            setDisplayUser({
              ...updatedUser,
              full_name: rp.full_name || updatedUser.full_name,
              unit_number: rp.unit_number || updatedUser.unit_number,
              residentApprovalStatus: 'approved'
            });
            setJustApproved(false);
            navigate(createPageUrl('Dashboard'), { replace: true });
          }, 2500);
        }
      } catch (_) {}
    };

    // Subscribe to real-time changes on ResidentProfile
    const unsubscribe = base44.entities.ResidentProfile.subscribe((event) => {
      if (event.data?.user_id === user.id && event.data?.status === 'approved') {
        checkApproval();
      }
    });

    // Polling fallback every 5 seconds
    const poll = setInterval(checkApproval, 5000);

    return () => {
      unsubscribe();
      clearInterval(poll);
    };
  }, [user?.id, user?.residentApprovalStatus]);

  useEffect(() => {
    const checkUser = async () => {
      try {
        const currentUser = await base44.auth.me();
        
        // Set isAdmin for board members
        if (currentUser.management_role === 'board' || currentUser.app_role === 'board') {
          currentUser.isAdmin = true;
        }
        
        // Define protected paths
        const onboardingPath = '/Onboarding';
        const setupPath = '/ResidentSetup';
        const currentPath = location.pathname;
        
        // Skip redirects if on onboarding or setup pages
        if (currentPath === onboardingPath || currentPath === setupPath) {
          setUser(currentUser);
          setDisplayUser(currentUser);
          setAuthReady(true);
          return;
        }
        
        // Redirect to onboarding if account_type is not set
        if (!currentUser.account_type) {
          navigate(createPageUrl('Onboarding'));
          return;
        }
        
        // Fetch profile data and check approval status - ONLY FOR RESIDENTS
        let profiles = [];
        let residentProfiles = [];
        
        if (currentUser.account_type === 'resident') {
          profiles = await base44.entities.Profile.filter({ userId: currentUser.id });
          residentProfiles = await base44.entities.ResidentProfile.filter({ user_id: currentUser.id });
          
          // Redirect residents without any profile to setup
          if (profiles.length === 0 && residentProfiles.length === 0) {
            navigate(createPageUrl('ResidentSetup'));
            return;
          }
        }
        
        if (profiles.length > 0) {
          // If Profile exists, user is already approved (existing resident)
          const profile = profiles[0];
          currentUser.residentApprovalStatus = 'approved';
          setDisplayUser({
            ...currentUser,
            full_name: profile.full_name || currentUser.full_name,
            unit_number: profile.unit_number || currentUser.unit_number,
            residentApprovalStatus: currentUser.residentApprovalStatus
          });
        } else if (residentProfiles.length > 0) {
          // ResidentProfile exists - check its status
          const residentProfile = residentProfiles[0];
          currentUser.residentApprovalStatus = residentProfile.status;
          setDisplayUser({
            ...currentUser,
            full_name: residentProfile.full_name || currentUser.full_name,
            unit_number: residentProfile.unit_number || currentUser.unit_number,
            residentApprovalStatus: currentUser.residentApprovalStatus
          });
        } else {
          // Shouldn't reach here, but default to pending
          currentUser.residentApprovalStatus = 'pending_approval';
          setDisplayUser(currentUser);
        }
        
        setUser(currentUser);
        setAuthReady(true);
        
        // Load saved view role for board members and property management (for financials switcher)
        const isPropertyMgmt = currentUser.management_role === 'property_management' || currentUser.app_role === 'property_management';
        if (currentUser.isAdmin || isPropertyMgmt) {
          const saved = localStorage.getItem('boardActiveViewRole');
          // Property management defaults to their own role, not 'resident'
          const defaultRole = isPropertyMgmt && !currentUser.isAdmin ? 'property_management' : 'resident';
          // A saved view outside the demo scope (e.g. financials) falls back to the default.
          setActiveViewRole(saved && isDemoViewRole(saved) ? saved : defaultRole);
        }
      } catch (error) {
        setAuthReady(true);
      }
    };
    checkUser();
  }, [location.pathname, navigate]);

  // Fetch initial counts and poll for updates - only after auth is ready
  useEffect(() => {
    if (!authReady || !user) return;
    
    const effectiveRole = user.isAdmin ? activeViewRole : (user.management_role || user.app_role);
    const effectiveAccountType = user.isAdmin ? (activeViewRole === 'resident' ? 'resident' : 'management') : accountType;
    
    // Initial fetch for security users
    if (effectiveRole === 'security') {
      fetchUnreadGameroomNotifications(user.id);
      fetchUnviewedMoveRequests('security');
    }

    // Initial fetch for property management
    if (effectiveRole === 'property_management') {
      fetchUnviewedMoveRequests('property_management');
      fetchPendingResidentsCount();
    }

    // Initial fetch for board members
    const isBoard = user.isAdmin || user.management_role === 'board' || user.app_role === 'board';
    if (isBoard) {
      fetchUnreadBoardReports(user.id);
    }

    // Initial fetch for residents (including board viewing as resident)
    if (effectiveAccountType === 'resident') {
      fetchPackageBadgeCount(user.id);
    }

    // Poll for updates
    const interval = setInterval(() => {
      if (effectiveRole === 'security') {
        fetchUnreadGameroomNotifications(user.id);
        fetchUnviewedMoveRequests('security');
      }
      if (effectiveRole === 'property_management') {
        fetchUnviewedMoveRequests('property_management');
        fetchPendingResidentsCount();
      }
      if (isBoard) {
        fetchUnreadBoardReports(user.id);
      }
      if (effectiveAccountType === 'resident') {
        fetchPackageBadgeCount(user.id);
      }
    }, 5000);
    
    return () => clearInterval(interval);
  }, [authReady, user, activeViewRole]);

  const fetchUnreadGameroomNotifications = async (userId) => {
    if (!userId) return;
    try {
      const all = await base44.entities.GameroomRental.list('-created_date', 100);
      const openRequests = all.filter(r => ['requested', 'accepted', 'active'].includes(r.status));
      setUnreadGameroomCount(openRequests.length);
    } catch (error) {
      console.error('Failed to fetch open gameroom requests:', error);
      setUnreadGameroomCount(0);
    }
  };

  const fetchUnreadBoardReports = async (userId) => {
    if (!userId) return;
    try {
      console.log('====== BOARD BADGE QUERY DEBUG ======');
      console.log('currentUserId (board):', userId);

      const allReports = await base44.entities.Report.list('-created_date', 200);
      const activeReports = allReports.filter(r => !r.isDeleted);

      const readRecords = await base44.entities.ReportRead.filter({ userId });
      const readReportIds = new Set(readRecords.map(r => r.reportId));

      const unreadReports = activeReports.filter(r => !readReportIds.has(r.id));

      console.log('Total active reports:', activeReports.length);
      console.log('Read reports:', readReportIds.size);
      console.log('Unread reports:', unreadReports.length);
      console.log('Badge source: reports without ReportRead record for userId');
      console.log('=====================================');

      setUnreadBoardReportsCount(unreadReports.length);
    } catch (error) {
      console.error('Failed to fetch unread board reports:', error);
      setUnreadBoardReportsCount(0);
    }
  };

  const fetchPendingResidentsCount = async () => {
    try {
      const all = await base44.entities.ResidentProfile.list('-created_date', 200);
      const count = all.filter(r => r.status === 'pending_approval' && !r.is_deleted).length;
      setPendingResidentsCount(count);
    } catch {
      setPendingResidentsCount(0);
    }
  };

  const fetchUnviewedMoveRequests = async (role) => {
    if (!role) return;
    try {
      const allRequests = await base44.entities.MoveRequest.filter({ status: 'pending' });
      let unviewedCount = 0;

      if (role === 'security') {
        unviewedCount = allRequests.filter(r => !r.viewed_by_security).length;
      } else if (role === 'property_management') {
        unviewedCount = allRequests.filter(r => !r.viewed_by_management).length;
      }

      setUnviewedMoveRequestsCount(unviewedCount);
    } catch (error) {
      console.error('Failed to fetch unviewed move requests:', error);
      setUnviewedMoveRequestsCount(0);
    }
  };

  const fetchPackageBadgeCount = async (userId) => {
    if (!userId) return;
    try {
      // Get user's profile to find their unit
      const profiles = await base44.entities.Profile.filter({ userId });
      let profile = profiles.length > 0 ? profiles[0] : null;
      
      // Fallback to ResidentProfile if no Profile
      if (!profile) {
        const residentProfiles = await base44.entities.ResidentProfile.filter({ user_id: userId });
        if (residentProfiles.length > 0 && residentProfiles[0].status === 'approved') {
          profile = {
            id: residentProfiles[0].id,
            unit_id: residentProfiles[0].unit_id
          };
        }
      }
      
      if (!profile || !profile.unit_id) {
        setPackageBadgeCount(0);
        return;
      }
      
      // Fetch packages for this unit
      const allPackages = await base44.entities.Package.filter({ unit_id: profile.unit_id });
      
      // Count ready packages for this resident
      const readyPackages = allPackages.filter(pkg => 
        pkg.status === 'ready_for_pickup' && 
        (pkg.recipient_profile_id === profile.id || !pkg.recipient_profile_id)
      );
      
      setPackageBadgeCount(readyPackages.length);
    } catch (error) {
      console.error('Failed to fetch package badge count:', error);
      setPackageBadgeCount(0);
    }
  };

  // Apply route protection with active view role
  useRouteProtection(user, activeViewRole);

  const handleLogout = async () => {
    await base44.auth.logout();
  };

  // Guard against uninitialized state
  if (!authReady) {
    return (
      <div className="h-screen flex items-center justify-center bg-zinc-50">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-zinc-200 border-t-zinc-900 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-zinc-500">Loading...</p>
        </div>
      </div>
    );
  }

  // These must be defined before ANY early returns so useEffect closures always see them
  const accountType = user?.account_type;
  const appRole = user?.management_role || user?.app_role || 'resident';
  const canSwitchRoles = user?.isAdmin || appRole === 'property_management';
  const effectiveRole = canSwitchRoles ? (activeViewRole || appRole) : appRole;
  const effectiveAccountType = canSwitchRoles ? (activeViewRole === 'resident' ? 'resident' : 'management') : accountType;

  // Setup / Onboarding pages render without any layout shell (they have their own full-screen design)
  if (location.pathname === '/ResidentSetup' || location.pathname === '/Onboarding') {
    return <>{children}</>;
  }

  // Pending-approval residents: render a stripped header-only shell — NO sidebar, NO nav tabs
  const isPendingApprovalResident =
    user?.account_type === 'resident' && user?.residentApprovalStatus === 'pending_approval';

  if (isPendingApprovalResident) {
    if (justApproved) {
      return (
        <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center px-6"
          >
            <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <CheckCircle2 className="w-10 h-10 text-green-600" />
            </div>
            <h2 className="text-2xl font-bold text-zinc-900 mb-2">Account Approved!</h2>
            <p className="text-zinc-500 mb-6">Your account has been approved. Loading your resident portal…</p>
            <div className="w-8 h-8 border-4 border-zinc-200 border-t-zinc-900 rounded-full animate-spin mx-auto" />
          </motion.div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-zinc-50 flex flex-col">
        <header className="flex items-center justify-between px-6 py-4 bg-white border-b border-zinc-100 shadow-sm">
          <img
            src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/6931cd960917c204b2b4808b/9780cdd25_logo-footer-estwest-r.png"
            alt="EstWest Condominiums"
            className="h-9 w-auto object-contain"
          />
          <Button
            variant="ghost"
            className="text-zinc-500 hover:text-red-500 hover:bg-red-50"
            onClick={handleLogout}
          >
            <LogOut className="w-4 h-4 mr-2" />
            Sign Out
          </Button>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto p-4 lg:p-8">
            {children}
          </div>
        </main>
      </div>
    );
  }

  const handleRoleChange = (newRole) => {
    // Allow financials for property_management even if not board admin
    setActiveViewRole(newRole);
    localStorage.setItem('boardActiveViewRole', newRole);
    // If already on dashboard, force re-mount by navigating away then back
    if (location.pathname === '/Dashboard' || location.pathname === '/') {
      navigate(createPageUrl('Dashboard') + '?role=' + newRole + '&t=' + Date.now(), { replace: true });
    } else {
      navigate(createPageUrl('Dashboard'));
    }
  };

  const getNavItems = () => {
    const items = [
      { name: effectiveAccountType === 'resident' ? t('Dashboard') : 'Dashboard', icon: LayoutDashboard, path: '/Dashboard' },
    ];

    // Resident navigation (for actual residents or board viewing as resident)
    if (effectiveAccountType === 'resident') {
      const isPending = user?.residentApprovalStatus === 'pending_approval';
      
      items.push({ name: t('My Profile'), icon: User, path: '/Profile' });
      items.push({ name: t('Move In/Out'), icon: Truck, path: '/MoveRequest' });

      // Hide other features if pending approval
      if (!isPending) {
        items.push({ name: t('My Packages'), icon: Package, path: '/packages', badgeCount: packageBadgeCount });
        // Visitor Access disabled (feature temporarily hidden)
        items.push({ name: t('Gameroom'), icon: Gamepad2, path: '/gameroom' });
        items.push({ name: t('Speakeasy'), icon: Wine, path: '/speakeasy' });
        items.push({ name: t('AI Concierge'), icon: MessageSquare, path: '/concierge' });
      }

      // Board Oversight - only for board members in resident view
      if (user?.isAdmin) {
        items.push({ name: t('Board Oversight'), icon: CalendarDays, path: '/BoardOverview', badgeCount: unreadBoardReportsCount });
      }

      return items;
    }

    // Management navigation based on effective role
    if (effectiveAccountType === 'management') {
      if (effectiveRole === 'security') {
        items.push({ name: 'Package Log', icon: Package, path: '/SecurityPackages' });
        items.push({ name: 'Visitor Verification', icon: UserCheck, path: '/VisitorVerification' });
        items.push({ name: 'Move Requests', icon: Truck, path: '/SecurityMoveRequests', badgeCount: unviewedMoveRequestsCount });
        items.push({ name: 'Move Inspection', icon: Camera, path: '/MoveInspection' });
        items.push({ name: 'Create Reports', icon: ShieldAlert, path: '/security-reports' });
        items.push({ name: 'Reports Inbox', icon: ShieldAlert, path: '/ManagementReports' });
        items.push({ name: 'Gameroom Ops', icon: Gamepad2, path: '/SecurityGameroom' });
        items.push({ name: 'Speakeasy Ops', icon: Wine, path: '/SecuritySpeakeasy' });
        items.push({ name: 'Daily Notices', icon: CalendarDays, path: '/ManagementNotices' });
        items.push({ name: 'Contacts', icon: BookUser, path: '/Contacts' });
      }

      if (effectiveRole === 'property_management') {
        items.push({ name: 'Residents', icon: UserCheck, path: '/Residents', badgeCount: pendingResidentsCount });
        items.push({ name: 'Contacts', icon: BookUser, path: '/Contacts' });
        items.push({ name: 'Reports Inbox', icon: ShieldAlert, path: '/ManagementReports' });
        items.push({ name: 'Move Requests', icon: Truck, path: '/SecurityMoveRequests', badgeCount: unviewedMoveRequestsCount });
        items.push({ name: 'Move Inspection', icon: Camera, path: '/MoveInspection' });
        items.push({ name: 'Maintenance', icon: Wrench, path: '/ManagementMaintenance' });
        items.push({ name: 'Speakeasy Approvals', icon: Wine, path: '/ManagementSpeakeasy' });
        items.push({ name: 'Daily Notices', icon: CalendarDays, path: '/ManagementNotices' });
      }

      if (effectiveRole === 'board') {
        items.push({ name: 'Board Overview', icon: CalendarDays, path: '/BoardOverview', badgeCount: unreadBoardReportsCount });
        items.push({ name: 'Move Inspection', icon: Camera, path: '/MoveInspection' });
      }

      if (effectiveRole === 'financials') {
        // Financials is rendered inline on Dashboard — no extra nav pages needed
        // Just a link back to dashboard is sufficient
      }
    }

    return items;
  };

  // Only demo-scope pages appear in navigation (src/app/routeScope.ts).
  const navItems = getNavItems().filter((item) => isDemoPath(item.path));

  const getBgImage = () => {
    if (location.pathname === '/Dashboard' || location.pathname === '/') return "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/6931cd960917c204b2b4808b/4a7987b35_image-02.jpg";
    if (location.pathname === '/packages') return "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/6931cd960917c204b2b4808b/658eb9b30_image-07.jpg";
    if (location.pathname === '/gameroom') return "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/6931cd960917c204b2b4808b/d973a9327_image-08.jpg";
    if (location.pathname === '/speakeasy') return "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/6931cd960917c204b2b4808b/d4389b612_image-04.jpg";
    if (location.pathname === '/concierge') return "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/6931cd960917c204b2b4808b/27d77d752_image-01.jpg";
    if (location.pathname === '/Profile') return "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/6931cd960917c204b2b4808b/21ae8a2d7_cover-photo.jpg";
    if (location.pathname === '/MoveRequest') return "https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/6931cd960917c204b2b4808b/eecc54ebd_stylish-1-bedroom-condo-in-prime-downtown-montreal-fully-v0-yh786zqlmfie1.png";
    return null;
  };
  const bgImage = getBgImage();

  const DEBUG_MODE = false;

  // Luxury background gradient
  return (
    <div className="h-screen flex flex-col bg-zinc-50 text-zinc-900 font-sans selection:bg-zinc-200 overflow-hidden">
      <EmergencyListener user={user} />
      {/* Debug Banner */}
      {DEBUG_MODE && (
        <div className="fixed top-0 left-0 right-0 bg-yellow-400 text-black p-2 text-xs font-mono z-[9999] flex gap-4 justify-center">
          <span>CURRENT_ROUTE = {location.pathname}</span>
          <span>USER_ROLE = {user?.management_role || user?.app_role || 'none'}</span>
          <span>NAV_SET = {effectiveAccountType === 'resident' ? 'resident' : effectiveRole}</span>
          <span>ACCOUNT_TYPE = {user?.account_type}</span>
        </div>
      )}

      {/* Mobile Header */}
      <div
        className="lg:hidden flex-none flex items-center justify-between px-4 pb-3 bg-white/80 dark:bg-zinc-900/90 backdrop-blur-md border-b border-zinc-100 dark:border-zinc-800 relative z-50"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 12px)' }}
      >
        <div className="flex items-center gap-2">
          {showBackButton ? (
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="text-zinc-500">
              <ChevronLeft className="w-5 h-5" />
            </Button>
          ) : null}
          <img 
            src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/6931cd960917c204b2b4808b/9780cdd25_logo-footer-estwest-r.png" 
            alt="EstWest Condominiums" 
            className="h-8 w-auto object-contain" 
          />
        </div>
        <Button variant="ghost" size="icon" onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}>
          {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </Button>
      </div>

      <div className="flex-1 flex overflow-hidden relative">
        {/* Mobile Menu Overlay - Must be before sidebar for proper stacking */}
        <AnimatePresence>
          {isMobileMenuOpen && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ 
                duration: 0.26,
                ease: [0.34, 1.45, 0.64, 1]
              }}
              className="fixed inset-0 bg-black/50 z-30 lg:hidden motion-reduce:transition-none"
              style={{ willChange: 'opacity' }}
              onClick={() => setIsMobileMenuOpen(false)}
            />
          )}
        </AnimatePresence>

        {/* Sidebar - Desktop & Mobile */}
        <aside 
          className={`
            fixed inset-y-0 left-0 z-40 w-[80%] max-w-[320px] lg:w-56 
            bg-white dark:bg-zinc-900 border-r border-zinc-100 dark:border-zinc-800 shadow-xl
            lg:static lg:inset-0 lg:max-w-none lg:shadow-none
            motion-reduce:transition-none
          `}
          style={{
            willChange: isMobileMenuOpen ? 'transform' : 'auto',
            transition: window.matchMedia('(prefers-reduced-motion: reduce)').matches
              ? 'none'
              : isMobileMenuOpen 
                ? 'transform 260ms cubic-bezier(0.34, 1.45, 0.64, 1)' 
                : 'transform 200ms cubic-bezier(0.4, 0, 0.2, 1)',
            transform: isMobileMenuOpen ? 'translate3d(0, 0, 0)' : 'translate3d(-100%, 0, 0)',
          }}
          onTransitionEnd={() => {
            if (!isMobileMenuOpen) {
              document.querySelector('aside').style.willChange = 'auto';
            }
          }}
        >
          <style jsx>{`
            @media (min-width: 1024px) {
              aside {
                transform: none !important;
              }
            }
          `}</style>
          <div className="flex flex-col h-full">
            {/* Mobile Close Button */}
            <div className="lg:hidden flex items-center justify-between p-4 border-b border-zinc-100 dark:border-zinc-800">
              <img 
                src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/6931cd960917c204b2b4808b/9780cdd25_logo-footer-estwest-r.png" 
                alt="EstWest Condominiums" 
                className="h-8 w-auto object-contain [filter:brightness(0)] dark:[filter:brightness(0)_invert(1)]" 
              />
              <Button 
                variant="ghost" 
                size="icon" 
                onClick={() => setIsMobileMenuOpen(false)}
                className="text-zinc-500"
              >
                <X className="w-5 h-5" />
              </Button>
            </div>

            {/* Desktop Header */}
            <div className="p-6 hidden lg:block">
              <img 
                src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/6931cd960917c204b2b4808b/9780cdd25_logo-footer-estwest-r.png" 
                alt="EstWest Condominiums" 
                className="h-12 w-auto object-contain mb-2 [filter:brightness(0)] dark:[filter:brightness(0)_invert(1)]"
              />
              {user && accountType && (
                <div className="mt-2 text-xs text-zinc-400 dark:text-zinc-500 uppercase tracking-widest font-medium">
                  {user.isAdmin ? 'Board Admin' : (accountType === 'resident' ? 'Resident' : appRole.replace('_', ' '))}
                </div>
              )}
            </div>

            {(user?.isAdmin || appRole === 'property_management') && activeViewRole && (
              <div className="px-3 pt-2">
                <RoleSwitcher activeRole={activeViewRole} onRoleChange={handleRoleChange} userRole={appRole} />
              </div>
            )}

            <nav className="flex-1 px-3 space-y-1 overflow-y-auto py-4">
              {navItems.map((item) => {
                const isActive = location.pathname === item.path;
                return (
                  <Link 
                    key={item.path} 
                    to={createPageUrl(item.path.substring(1) || 'Dashboard')}
                    onClick={() => setIsMobileMenuOpen(false)}
                  >
                    <div className={`
                      flex items-center gap-2.5 px-3 py-2.5 rounded-xl transition-all duration-200 group relative
                      ${isActive 
                        ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 shadow-lg shadow-zinc-200 dark:shadow-zinc-800' 
                        : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100'}
                    `}>
                      <item.icon className={`w-5 h-5 ${isActive ? 'text-white dark:text-zinc-900' : 'text-zinc-400 dark:text-zinc-500 group-hover:text-zinc-900 dark:group-hover:text-zinc-100'}`} />
                      <span className="font-medium text-sm">{item.name}</span>
                      {item.name === 'Gameroom Ops' && unreadGameroomCount > 0 && (
                        <span className="ml-auto w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center font-bold">
                          {unreadGameroomCount}
                        </span>
                      )}
                      {item.badgeCount > 0 && (
                        <span className="ml-auto w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center font-bold">
                          {item.badgeCount >= 99 ? '99+' : item.badgeCount}
                        </span>
                      )}
                      {isActive && !((item.name === 'Gameroom Ops' && unreadGameroomCount > 0) || item.badgeCount > 0) && (
                        <motion.div layoutId="activeTab" className="ml-auto w-1.5 h-1.5 rounded-full bg-white" />
                      )}
                    </div>
                  </Link>
                );
              })}
            </nav>

            {/* Language Switcher - residents only */}
            {accountType === 'resident' && (
              <div className="border-t border-zinc-100 dark:border-zinc-800 pt-2">
                <LanguageSwitcher />
              </div>
            )}

            <div className="p-4 border-t border-zinc-100 dark:border-zinc-800">
              <div className="bg-zinc-50 dark:bg-zinc-800 rounded-xl p-4 mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center text-zinc-500 dark:text-zinc-400">
                    <User className="w-5 h-5" />
                  </div>
                  <div className="overflow-hidden">
                    <p className="text-sm font-semibold truncate dark:text-zinc-100">{displayUser?.full_name || 'Guest'}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      {displayUser?.unit_number ? (
                        <>
                          #{displayUser.unit_number} <span className="ml-1 px-1.5 py-0.5 bg-zinc-200 dark:bg-zinc-600 text-zinc-700 dark:text-zinc-200 rounded font-bold">{displayUser.unit_number.toString().startsWith('1') ? 'E' : 'W'}</span>
                        </>
                      ) : 'No Unit'}
                    </p>
                  </div>
                </div>
              </div>
              <Button 
                variant="ghost" 
                className="w-full justify-start text-zinc-500 hover:text-red-500 hover:bg-red-50"
                onClick={handleLogout}
              >
                <LogOut className="w-4 h-4 mr-2" />
                {t('Sign Out')}
              </Button>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto bg-zinc-50/50 relative">
           {/* Cinematic background elements */}
           {bgImage ? (
             <div className="fixed inset-0 z-0 overflow-hidden">
                <img 
                  src={bgImage} 
                  alt="Background" 
                  className="w-full h-full object-cover opacity-100 scale-110"
                />
                <div className="absolute inset-0 bg-white/60 backdrop-blur-[2px]" />
             </div>
           ) : (
             <div className="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-zinc-100 to-transparent -z-10" />
           )}
          
          <div className="max-w-5xl mx-auto p-4 lg:p-8 min-h-full relative z-10 pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:pb-8">
             <AnimatePresence mode="wait">
                <motion.div
                  key={location.pathname + '|' + (activeViewRole || '')}
                  initial={{ opacity: 0, y: 10, filter: 'blur(10px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, y: -10, filter: 'blur(10px)' }}
                  transition={{ duration: 0.3, ease: "easeOut" }}
                >
                  {children}
                </motion.div>
             </AnimatePresence>
          </div>
        </main>
      </div>

      {/* Mobile Bottom Tabs - residents only, not management */}
      {effectiveAccountType === 'resident' && !isPendingApprovalResident && (
        <BottomTabs />
      )}
    </div>
  );
}
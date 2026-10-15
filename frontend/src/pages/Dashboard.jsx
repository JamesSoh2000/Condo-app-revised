import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Package, ShieldAlert, Wrench, Bell, Gamepad2, Wine, CalendarDays, Send, Megaphone, AlertCircle, UserCheck, ChevronDown } from 'lucide-react';
import { useLanguage } from '@/lib/LanguageContext';
import Financials from './Financials';
import NoticeAttachmentUpload from '@/components/NoticeAttachmentUpload';
import { motion } from 'framer-motion';
import { createPageUrl } from '@/utils';
import { Link } from 'react-router-dom';
import BuildingUpdatesFeed from '@/components/BuildingUpdatesFeed';
import PullToRefresh from '@/components/PullToRefresh';
import { toast } from 'sonner';

export default function Dashboard() {
  const { t } = useLanguage();
  const [user, setUser] = React.useState(null);
  const [displayUser, setDisplayUser] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [profileLoading, setProfileLoading] = React.useState(true);
  const [announcement, setAnnouncement] = useState({ title: '', message: '', noticeType: '' });
  const [noticeAttachment, setNoticeAttachment] = useState(null);
  const [unreadBoardReportsCount, setUnreadBoardReportsCount] = React.useState(0);
  const [mobileAlertsCount, setMobileAlertsCount] = React.useState(0);
  const alertsFeedRef = React.useRef(null);
  const queryClient = useQueryClient();

  // mobileAlertsCount is now driven by BuildingUpdatesFeed via onCountChange callback
  // (removed the stale independent fetch that didn't account for archiving)

  React.useEffect(() => {
    // Clear stale localStorage cache to prevent cross-account name/unit contamination
    try { localStorage.removeItem('resident_display_cache'); } catch (_) {}

    const load = async () => {
      const u = await base44.auth.me();
      // Set isAdmin for board members
      if (u.management_role === 'board' || u.app_role === 'board') {
        u.isAdmin = true;
      }
      console.log('[Dashboard] Logged in userId:', u.id, '| email:', u.email);
      setUser(u);
      setLoading(false);
      
      // Always pull from Profile/ResidentProfile as source of truth
      // Sequential (not parallel) to avoid rate limiting when many components load at once
      setProfileLoading(true);
      let profiles = [];
      let residentProfiles = [];
      try {
        profiles = await base44.entities.Profile.filter({ userId: u.id });
      } catch (_) {}
      try {
        residentProfiles = await base44.entities.ResidentProfile.filter({ user_id: u.id });
      } catch (_) {}
      
      // Source of truth priority: Profile (approved) > ResidentProfile (approved)
      let unitNumber = null;
      let parkingSpot = null;
      let fullName = u.full_name || u.email;

      if (profiles.length > 0) {
        const p = profiles[0];
        fullName = p.full_name || fullName;
        unitNumber = p.unit_number || null;
        // Check vehicles array first, then top-level parking_spot
        const vehicleParking = p.vehicles?.find(v => v.parking_spot)?.parking_spot;
        parkingSpot = vehicleParking || p.parking_spot || null;

        // If unit_number missing but unit_id exists, look it up
        if (!unitNumber && p.unit_id) {
          try {
            const units = await base44.entities.Unit.filter({ id: p.unit_id });
            if (units.length > 0) unitNumber = units[0].unit_number;
          } catch (_) {}
        }
      } else if (residentProfiles.length > 0) {
        const rp = residentProfiles[0];
        fullName = rp.full_name || fullName;
        unitNumber = rp.unit_number || null;
        parkingSpot = rp.parking_spot || rp.vehicles?.find(v => v.parking_spot)?.parking_spot || null;

        if (!unitNumber && rp.unit_id) {
          try {
            const units = await base44.entities.Unit.filter({ id: rp.unit_id });
            if (units.length > 0) unitNumber = units[0].unit_number;
          } catch (_) {}
        }
      }

      const resolvedDisplay = {
        ...u,
        full_name: fullName,
        unit_number: unitNumber || u.unit_number || null,
        parking_spot: parkingSpot || 'None'
      };
      console.log('[Dashboard] Resolved display — userId:', u.id, '| name:', resolvedDisplay.full_name, '| unit:', resolvedDisplay.unit_number);
      setDisplayUser(resolvedDisplay);
      setProfileLoading(false);
      
      // Debug: Check unread notifications for board members
      if (u.isAdmin || u.management_role === 'board' || u.app_role === 'board') {
        const debugNotifications = await base44.entities.Notification.filter({
          target_user_id: u.id,
          type: 'security_report',
          is_read: false
        });
        console.log(`[DEBUG BOARD DASHBOARD] UNREAD_SECURITY_REPORT_NOTIFS for ${u.email}:`, debugNotifications.length);
        setUnreadBoardReportsCount(debugNotifications.length);
      }
    };
    load().catch(e => {
      console.error('[Dashboard] load error:', e);
      setLoading(false);
      setProfileLoading(false);
    });
  }, []);

  const handleSendAnnouncement = async () => {
    if (!announcement.title || !announcement.message) return;
    if (!announcement.noticeType) {
      toast.error("Please select a notice type (Update or Emergency)");
      return;
    }
    try {
        // Create ONLY a new record — never touch or re-activate old ones
        await base44.entities.BuildingUpdate.create({
            title: announcement.title,
            message: announcement.message,
            type: announcement.noticeType,
            priority: announcement.noticeType === 'emergency' ? 'important' : 'normal',
            isActive: true,
            is_deleted: false,
            postedByUserId: user?.id,
            postedByName: user?.full_name,
            ...(noticeAttachment || {})
        });
        // Invalidate the active-only query key so feed refetches fresh
        queryClient.invalidateQueries({ queryKey: ['building-updates', 'active'] });
        toast.success("Notice sent to all residents");
        setAnnouncement({ title: '', message: '', noticeType: '' });
        setNoticeAttachment(null);
    } catch (e) {
        toast.error("Failed to send notice");
    }
  };

  if (loading) return null;

  const isAdmin = user?.isAdmin || user?.management_role === 'board' || user?.app_role === 'board';
  // Read from URL param first (set by RoleSwitcher for instant updates), then fall back to localStorage
  const urlParams = new URLSearchParams(window.location.search);
  const activeViewRole = isAdmin ? (urlParams.get('role') || localStorage.getItem('boardActiveViewRole') || 'resident') : null;
  
  // Determine effective account type and role based on active view
  const effectiveAccountType = (isAdmin || user?.management_role === 'property_management' || user?.app_role === 'property_management') && activeViewRole
    ? (activeViewRole === 'resident' ? 'resident' : 'management')
    : user?.account_type;
  // For non-board management users, allow them to access financials mode too
  const rawRole = user?.management_role || user?.app_role || 'resident';
  const canAccessFinancials = isAdmin || rawRole === 'property_management';
  const effectiveRole = (isAdmin && activeViewRole)
    ? activeViewRole
    : (canAccessFinancials && urlParams.get('role') === 'financials' ? 'financials' : rawRole);

  const accountType = effectiveAccountType;
  const role = effectiveRole;

  // Resident Dashboard (for actual residents or board viewing as resident)
  const scrollToAlerts = () => {
    alertsFeedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handlePullRefresh = async () => {
    await queryClient.invalidateQueries();
  };

  if (accountType === 'resident') {
    return (
      <PullToRefresh onRefresh={handlePullRefresh}>
      <div key={`dashboard-resident-${user?.id}`} className="flex flex-col lg:flex-row gap-6">
        {/* Left Column - Main Content */}
        <div className="flex-1 space-y-8">
          <div>
            <h2 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-900">{t('Good Morning')}, {displayUser?.full_name?.split(' ')[0]}</h2>
            <p className="text-zinc-500 dark:text-zinc-400 mt-2 flex items-center gap-1.5">
              {profileLoading && !displayUser?.unit_number ? (
                <span className="inline-block h-4 w-20 bg-zinc-200 rounded animate-pulse" />
              ) : (
                <>
                  {t('Unit')} {displayUser?.unit_number || 'N/A'}
                  {displayUser?.unit_number && (
                    <span className="px-1.5 py-0.5 bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 rounded text-xs font-bold">
                      {displayUser.unit_number.toString().startsWith('1') ? 'E' : 'W'}
                    </span>
                  )}
                  {' '}• {t('Parking')} {displayUser?.parking_spot ? displayUser.parking_spot : t('None')}
                </>
              )}
            </p>

            {/* Mobile-only Updates & Alerts shortcut */}
            <motion.button
              className="lg:hidden mt-4 w-full flex items-center gap-3 px-4 py-3 rounded-2xl bg-white/80 dark:bg-zinc-800/80 backdrop-blur-sm border border-zinc-200 dark:border-zinc-700 shadow-sm active:scale-[0.98] transition-transform"
              onClick={scrollToAlerts}
              whileTap={{ scale: 0.97 }}
            >
              <div className="relative flex-shrink-0">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${mobileAlertsCount > 0 ? 'bg-red-50' : 'bg-zinc-100'}`}>
                  <Bell className={`w-5 h-5 ${mobileAlertsCount > 0 ? 'text-red-500' : 'text-zinc-400'}`} />
                </div>
                {mobileAlertsCount > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center px-1 shadow">
                    {mobileAlertsCount > 9 ? '9+' : mobileAlertsCount}
                  </span>
                )}
              </div>
              <div className="flex-1 text-left">
                <p className={`text-sm font-semibold ${mobileAlertsCount > 0 ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-400'}`}>{t('Updates & Alerts')}</p>
                <p className="text-xs text-zinc-400 dark:text-zinc-500">
                  {mobileAlertsCount > 0 ? `${mobileAlertsCount} ${t('new notice')}${mobileAlertsCount !== 1 ? 's' : ''}` : t('No new alerts')}
                </p>
              </div>
              <ChevronDown className="w-4 h-4 text-zinc-400 flex-shrink-0" />
            </motion.button>
          </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Link to={createPageUrl('packages')}>
            <Card className="group hover:shadow-lg transition-all duration-300 border-zinc-200/60 dark:border-zinc-700 bg-white/50 dark:bg-zinc-800/80 backdrop-blur-sm cursor-pointer">
              <CardContent className="p-6 flex flex-col items-center text-center space-y-4">
                <div className="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <Package className="w-6 h-6" />
                </div>
                <div>
                 <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{t('Packages')}</h3>
                 <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">{t('Check deliveries')}</p>
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link to={createPageUrl('gameroom')}>
            <Card className="group hover:shadow-lg transition-all duration-300 border-zinc-200/60 dark:border-zinc-700 bg-white/50 dark:bg-zinc-800/80 backdrop-blur-sm cursor-pointer">
              <CardContent className="p-6 flex flex-col items-center text-center space-y-4">
                <div className="w-12 h-12 rounded-2xl bg-amber-50 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <Gamepad2 className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{t('Gameroom')}</h3>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">{t('Rent items now')}</p>
                </div>
              </CardContent>
            </Card>
          </Link>

           <Link to={createPageUrl('speakeasy')}>
            <Card className="group hover:shadow-lg transition-all duration-300 border-zinc-200/60 dark:border-zinc-700 bg-white/50 dark:bg-zinc-800/80 backdrop-blur-sm cursor-pointer">
              <CardContent className="p-6 flex flex-col items-center text-center space-y-4">
                <div className="w-12 h-12 rounded-2xl bg-purple-50 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <Wine className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{t('Speakeasy')}</h3>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">{t('Reserve a lounge')}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
           <Card className="group hover:shadow-lg hover:shadow-red-500/10 hover:border-red-200/50 dark:hover:border-red-900/50 transition-all duration-300 border-zinc-200/60 dark:border-zinc-700 bg-white/50 dark:bg-zinc-800/80 backdrop-blur-sm">
               <CardContent className="p-6">
                   <h3 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-4 flex items-center gap-2">
                       <div className="p-1.5 rounded-md bg-zinc-50 dark:bg-zinc-700 group-hover:bg-red-50 dark:group-hover:bg-red-900/30 group-hover:text-red-600 group-hover:scale-110 transition-all duration-300">
                           <Wrench className="w-4 h-4" />
                       </div>
                       {t('Request Maintenance')}
                        </h3>
                        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">{t('Report issues in your unit or common areas.')}</p>
                        <Link to={createPageUrl('maintenance')}>
                            <Button className="w-full bg-zinc-900 dark:bg-transparent dark:border dark:border-zinc-600 dark:text-zinc-300 hover:bg-red-600 dark:hover:bg-red-900/30 dark:hover:border-red-300 dark:hover:text-red-400 hover:shadow-[0_0_15px_rgba(220,38,38,0.5)] transition-all duration-300">{t('New Request')}</Button>
                   </Link>
               </CardContent>
           </Card>
            <Card className="group hover:shadow-lg hover:shadow-red-500/10 hover:border-red-200/50 dark:hover:border-red-900/50 transition-all duration-300 border-zinc-200/60 dark:border-zinc-700 bg-white/50 dark:bg-zinc-800/80 backdrop-blur-sm">
               <CardContent className="p-6">
                   <h3 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-4 flex items-center gap-2">
                        <div className="p-1.5 rounded-md bg-zinc-50 dark:bg-zinc-700 group-hover:bg-red-50 dark:group-hover:bg-red-900/30 group-hover:text-red-600 group-hover:scale-110 transition-all duration-300">
                           <ShieldAlert className="w-4 h-4" />
                       </div>
                       {t('Security Report')}
                        </h3>
                        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">{t('Report parking violations or noise complaints.')}</p>
                        <Link to={createPageUrl('SecurityReport')}>
                             <Button variant="outline" className="w-full text-zinc-900 dark:border-zinc-600 dark:text-zinc-300 hover:bg-red-50 dark:hover:bg-red-900/30 hover:border-red-200 hover:text-red-600 hover:shadow-[0_0_15px_rgba(220,38,38,0.25)] transition-all duration-300">{t('File Report')}</Button>
                   </Link>
               </CardContent>
           </Card>
        </div>

        {/* Board Oversight - only for board members in resident view */}
        {isAdmin && (
         <Card className="group hover:shadow-lg hover:shadow-indigo-500/10 hover:border-indigo-200/50 transition-all duration-300 border-zinc-200/60 bg-white/50 backdrop-blur-sm">
           <CardContent className="p-6">
             <h3 className="font-semibold mb-4 flex items-center gap-2">
               <div className="p-1.5 rounded-md bg-zinc-50 group-hover:bg-indigo-50 group-hover:text-indigo-600 group-hover:scale-110 transition-all duration-300">
                 <CalendarDays className="w-4 h-4" />
               </div>
               Board Oversight
               {unreadBoardReportsCount > 0 && (
                 <span className="ml-auto px-2 py-0.5 bg-red-500 text-white text-xs rounded-full font-bold">
                   {unreadBoardReportsCount >= 99 ? '99+' : unreadBoardReportsCount}
                 </span>
               )}
             </h3>
             <p className="text-sm text-zinc-500 mb-2">Access full operations overview and management tools.</p>
             {unreadBoardReportsCount > 0 && (
               <p className="text-xs text-amber-600 mb-4 flex items-center gap-1">
                 <AlertCircle className="w-3 h-3" />
                 {unreadBoardReportsCount} unread report{unreadBoardReportsCount !== 1 ? 's' : ''} (source: notifications type=security_report)
               </p>
             )}
             <Link to={createPageUrl('BoardOverview')}>
               <Button className="w-full bg-indigo-600 hover:bg-indigo-700 hover:shadow-[0_0_15px_rgba(99,102,241,0.5)] transition-all duration-300">{t('View Operations')}</Button>
             </Link>
           </CardContent>
         </Card>
        )}

        {/* Updates & Alerts Feed — mobile only, below main content */}
         <div className="lg:hidden" ref={alertsFeedRef}>
           <BuildingUpdatesFeed onCountChange={setMobileAlertsCount} />
         </div>
        </div>

        {/* Right Column - Building Updates Feed (desktop only) */}
        <div className="hidden lg:block w-80 flex-shrink-0">
         <BuildingUpdatesFeed onCountChange={setMobileAlertsCount} />
        </div>
        </div>
      </PullToRefresh>
        );
        }

  // Security Dashboard
  if (accountType === 'management' && role === 'security') {
    return (
      <div key="dashboard-security" className="flex flex-col lg:flex-row gap-6">
        {/* Left column: quick links + send notice */}
        <div className="flex-1 space-y-6">
          <h2 className="text-3xl font-bold tracking-tight">Security Operations</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <Link to={createPageUrl('SecurityPackages')}>
              <Button variant="outline" className="w-full h-24 flex flex-col gap-2 bg-white hover:bg-zinc-50">
                <Package className="w-6 h-6 text-blue-600" />
                Package Log
              </Button>
            </Link>
            <Link to={createPageUrl('VisitorVerification')}>
              <Button variant="outline" className="w-full h-24 flex flex-col gap-2 bg-white hover:bg-zinc-50">
                <UserCheck className="w-6 h-6 text-green-600" />
                Visitor Verification
              </Button>
            </Link>
            <Link to={createPageUrl('security-reports')}>
              <Button variant="outline" className="w-full h-24 flex flex-col gap-2 bg-white hover:bg-zinc-50">
                <ShieldAlert className="w-6 h-6 text-red-600" />
                Reports
              </Button>
            </Link>
            <Link to={createPageUrl('SecurityGameroom')}>
              <Button variant="outline" className="w-full h-24 flex flex-col gap-2 bg-white hover:bg-zinc-50">
                <Gamepad2 className="w-6 h-6 text-amber-600" />
                Gameroom
              </Button>
            </Link>
            <Link to={createPageUrl('SecuritySpeakeasy')}>
              <Button variant="outline" className="w-full h-24 flex flex-col gap-2 bg-white hover:bg-zinc-50">
                <Wine className="w-6 h-6 text-purple-600" />
                Speakeasy
              </Button>
            </Link>
          </div>

          <Card className="bg-white">
            <CardContent className="p-6 space-y-4">
              <h3 className="font-semibold flex items-center gap-2">
                <Megaphone className="w-4 h-4" /> Send Notice
              </h3>
              <div className="flex gap-2">
                <button
                  onClick={() => setAnnouncement({...announcement, noticeType: 'update'})}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border-2 text-sm font-medium transition-all ${announcement.noticeType === 'update' ? 'border-zinc-800 bg-zinc-800 text-white' : 'border-zinc-200 text-zinc-600 hover:border-zinc-400'}`}
                >
                  <picture><source srcSet="https://fonts.gstatic.com/s/e/notoemoji/latest/270f_fe0f/512.webp" type="image/webp" /><img src="https://fonts.gstatic.com/s/e/notoemoji/latest/270f_fe0f/512.gif" alt="✏" width="22" height="22" className="inline-block flex-shrink-0" /></picture> Update
                </button>
                <button
                  onClick={() => setAnnouncement({...announcement, noticeType: 'emergency'})}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border-2 text-sm font-medium transition-all ${announcement.noticeType === 'emergency' ? 'border-red-600 bg-red-600 text-white' : 'border-zinc-200 text-zinc-600 hover:border-red-300'}`}
                >
                  <picture><source srcSet="https://fonts.gstatic.com/s/e/notoemoji/latest/1f6a8/512.webp" type="image/webp" /><img src="https://fonts.gstatic.com/s/e/notoemoji/latest/1f6a8/512.gif" alt="🚨" width="22" height="22" className="inline-block flex-shrink-0" /></picture> Emergency
                </button>
              </div>
              {!announcement.noticeType && (
                <p className="text-xs text-amber-600">⚠ Notice type is required</p>
              )}
              <Input
                placeholder="Title"
                value={announcement.title}
                onChange={(e) => setAnnouncement({...announcement, title: e.target.value})}
              />
              <Textarea
                placeholder="Message to all residents..."
                className="resize-none"
                value={announcement.message}
                onChange={(e) => setAnnouncement({...announcement, message: e.target.value})}
              />
              <NoticeAttachmentUpload attachment={noticeAttachment} onChange={setNoticeAttachment} />
              <Button
                className="w-full"
                onClick={handleSendAnnouncement}
                disabled={!announcement.title || !announcement.message || !announcement.noticeType}
              >
                <Send className="w-4 h-4 mr-2" /> Send Notice
              </Button>
            </CardContent>
          </Card>

          {/* Updates & Alerts — mobile only (below send notice) */}
          <div className="lg:hidden">
            <BuildingUpdatesFeed />
          </div>
        </div>

        {/* Right column: Updates & Alerts feed (desktop) */}
        <div className="hidden lg:block w-80 flex-shrink-0">
          <BuildingUpdatesFeed />
        </div>
      </div>
    );
  }

  // Property Management
  if (accountType === 'management' && role === 'property_management') {
    return (
      <div key="dashboard-property-management" className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 space-y-6">
          <h2 className="text-3xl font-bold tracking-tight">Management HQ</h2>

          {/* ── Operations ── */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-3">Operations</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <Link to={createPageUrl('ManagementMaintenance')}>
                <Card className="group hover:shadow-lg transition-all duration-300 border-zinc-200/60 bg-white cursor-pointer h-full">
                  <CardContent className="p-5 flex flex-col items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                      <Wrench className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="font-semibold text-sm">Maintenance Tickets</p>
                      <p className="text-xs text-zinc-500 mt-0.5">Review & manage requests</p>
                    </div>
                  </CardContent>
                </Card>
              </Link>
              <Link to={createPageUrl('ManagementSpeakeasy')}>
                <Card className="group hover:shadow-lg transition-all duration-300 border-zinc-200/60 bg-white cursor-pointer h-full">
                  <CardContent className="p-5 flex flex-col items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-purple-50 text-purple-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                      <Wine className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="font-semibold text-sm">Speakeasy Approvals</p>
                      <p className="text-xs text-zinc-500 mt-0.5">Approve reservations</p>
                    </div>
                  </CardContent>
                </Card>
              </Link>
              <Link to={createPageUrl('ManagementNotices')}>
                <Card className="group hover:shadow-lg transition-all duration-300 border-zinc-200/60 bg-white cursor-pointer h-full">
                  <CardContent className="p-5 flex flex-col items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                      <CalendarDays className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="font-semibold text-sm">Daily Notices</p>
                      <p className="text-xs text-zinc-500 mt-0.5">Calendar & agenda</p>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </div>
          </div>

          {/* ── Updates & Alerts (mobile only) ── */}
          <div className="lg:hidden">
            <BuildingUpdatesFeed />
          </div>

          {/* ── Communications ── */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-3">Communications</p>
            <Card className="bg-white border-zinc-200/60">
              <CardContent className="p-6">
                <h3 className="font-semibold flex items-center gap-2 mb-4">
                  <Megaphone className="w-4 h-4" /> Send Notice
                </h3>
                <div className="flex gap-2 mb-3">
                  <button
                    onClick={() => setAnnouncement({...announcement, noticeType: 'update'})}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border-2 text-sm font-medium transition-all ${announcement.noticeType === 'update' ? 'border-zinc-800 bg-zinc-800 text-white' : 'border-zinc-200 text-zinc-600 hover:border-zinc-400'}`}
                  >
                    <picture><source srcSet="https://fonts.gstatic.com/s/e/notoemoji/latest/270f_fe0f/512.webp" type="image/webp" /><img src="https://fonts.gstatic.com/s/e/notoemoji/latest/270f_fe0f/512.gif" alt="✏" width="22" height="22" className="inline-block flex-shrink-0" /></picture> Update
                  </button>
                  <button
                    onClick={() => setAnnouncement({...announcement, noticeType: 'emergency'})}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border-2 text-sm font-medium transition-all ${announcement.noticeType === 'emergency' ? 'border-red-600 bg-red-600 text-white' : 'border-zinc-200 text-zinc-600 hover:border-red-300'}`}
                  >
                    <picture><source srcSet="https://fonts.gstatic.com/s/e/notoemoji/latest/1f6a8/512.webp" type="image/webp" /><img src="https://fonts.gstatic.com/s/e/notoemoji/latest/1f6a8/512.gif" alt="🚨" width="22" height="22" className="inline-block flex-shrink-0" /></picture> Emergency
                  </button>
                </div>
                {!announcement.noticeType && (
                  <p className="text-xs text-amber-600 mb-3">⚠ Notice type is required</p>
                )}
                <div className="space-y-3">
                  <Input
                    placeholder="Title"
                    value={announcement.title}
                    onChange={(e) => setAnnouncement({...announcement, title: e.target.value})}
                  />
                  <Textarea
                    placeholder="Message to all residents..."
                    className="resize-none"
                    value={announcement.message}
                    onChange={(e) => setAnnouncement({...announcement, message: e.target.value})}
                  />
                  <NoticeAttachmentUpload attachment={noticeAttachment} onChange={setNoticeAttachment} />
                  <Button
                    className="w-full"
                    onClick={handleSendAnnouncement}
                    disabled={!announcement.title || !announcement.message || !announcement.noticeType}
                  >
                    <Send className="w-4 h-4 mr-2" /> Send Notice
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="hidden lg:block w-80 flex-shrink-0">
          <BuildingUpdatesFeed />
        </div>
      </div>
    );
  }

  // Financials view (board or property_management selecting financials mode)
  if (role === 'financials') {
    return <Financials key="dashboard-financials" />;
  }

  // Board View
  if (accountType === 'management' && role === 'board') {
    return (
        <div key="dashboard-board" className="flex flex-col lg:flex-row gap-6">
          <div className="flex-1 space-y-6">
            <h2 className="text-3xl font-bold tracking-tight">Board Oversight</h2>
            <div className="p-6 bg-white rounded-xl border border-zinc-200 text-center">
                <p className="text-zinc-500">Welcome to the Board Dashboard. You have oversight access to all logs and calendars.</p>
                <Link to={createPageUrl('BoardOverview')}>
                    <Button className="mt-4">View Operations Overview</Button>
                </Link>
            </div>
            {/* Updates & Alerts on mobile */}
            <div className="lg:hidden">
              <BuildingUpdatesFeed />
            </div>
          </div>
          
          <div className="hidden lg:block w-80 flex-shrink-0">
            <BuildingUpdatesFeed />
          </div>
        </div>
    );
  }

  // Fallback - redirect to onboarding
  return null;
}
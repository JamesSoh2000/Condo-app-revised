import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';
import { Bell, AlertCircle, Package, ShieldAlert, Archive, ArchiveX, AlertTriangle, Zap, Paperclip, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import BuildingUpdateModal from './BuildingUpdateModal';
import ArchivedUpdatesModal from './ArchivedUpdatesModal';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLanguage } from '@/lib/LanguageContext';

export default function BuildingUpdatesFeed({ onCountChange }) {
  const { t } = useLanguage();
  const TABS = [
    { id: 'all', label: t('All') },
    { id: 'updates', label: t('Updates') },
    { id: 'emergency', label: t('Emergency') },
  ];
  const [selectedUpdate, setSelectedUpdate] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isArchivedModalOpen, setIsArchivedModalOpen] = useState(false);
  const [archiveAllConfirm, setArchiveAllConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState('all');
  const [user, setUser] = useState(null);
  // dataReady resets to false on every mount — this prevents stale cache from ever
  // flashing through before a fresh server fetch completes (AnimatePresence race condition fix)
  const [dataReady, setDataReady] = useState(false);
  const queryClient = useQueryClient();

  // On mount: forcibly remove stale cache entries so queries always fetch fresh data.
  useEffect(() => {
    queryClient.removeQueries({ queryKey: ['building-updates', 'active'] });
    queryClient.removeQueries({ queryKey: ['general-announcements'] });
  }, [queryClient]);

  // Run auto-cleanup on mount: archive active items older than 30 days,
  // hard-delete BuildingUpdate records that are is_deleted=true or inactive older than 7 days.
  useEffect(() => {
    const runCleanup = async () => {
      try {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        // Fetch all active building updates (broad fetch for cleanup purposes)
        const allActive = await base44.entities.BuildingUpdate.list('-created_date', 200);

        for (const u of allActive) {
          const created = new Date(u.created_date);

          // Permanently delete any record already marked is_deleted or inactive, older than 7 days
          if ((u.is_deleted || !u.isActive) && created < sevenDaysAgo) {
            try { await base44.entities.BuildingUpdate.delete(u.id); } catch (_) {}
            continue;
          }

          // Auto-archive active records older than 30 days (soft-delete from feed)
          if (u.isActive && !u.is_deleted && created < thirtyDaysAgo) {
            try {
              await base44.entities.BuildingUpdate.update(u.id, {
                isActive: false,
                is_deleted: true,
                archivedAt: now.toISOString()
              });
            } catch (_) {}
          }
        }
      } catch (_) {}
    };
    runCleanup();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const loadUser = async () => {
      const currentUser = await base44.auth.me();
      setUser(currentUser);
    };
    loadUser();
  }, []);

  const { data: buildingUpdates, isLoading: isLoadingUpdates } = useQuery({
    queryKey: ['building-updates', 'active'],
    queryFn: async () => {
      // Only fetch strictly active, non-deleted records
      const allUpdates = await base44.entities.BuildingUpdate.filter({ isActive: true }, '-created_date', 50);
      const now = new Date();
      return allUpdates.filter(u =>
        u.isActive === true &&
        !u.is_deleted &&
        (!u.expiresAt || new Date(u.expiresAt) > now)
      );
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 30000
  });

  // Real-time subscription: immediate optimistic removal + always force a DB refetch
  useEffect(() => {
    const unsubscribe = base44.entities.BuildingUpdate.subscribe((event) => {
      const itemId = event.id || event.data?.id;

      if (itemId) {
        const shouldRemoveNow =
          event.type === 'delete' ||
          (event.type === 'update' && event.data &&
            (event.data.isActive === false || event.data.is_deleted === true));

        if (shouldRemoveNow) {
          // Immediately remove from active cache — never let deleted/inactive items linger
          queryClient.setQueryData(['building-updates', 'active'], (prev) =>
            prev ? prev.filter(u => u.id !== itemId) : prev
          );
        }
      }

      // Always force a fresh server fetch after ANY change
      queryClient.invalidateQueries({ queryKey: ['building-updates', 'active'] });
    });
    return () => unsubscribe();
  }, [queryClient]);

  const { data: personalNotifications, isLoading: isLoadingPersonal } = useQuery({
    queryKey: ['personal-notifications', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      
      // Fetch Profile to get actual unit_number
      const profiles = await base44.entities.Profile.filter({ userId: user.id });
      const userUnitNumber = profiles.length > 0 ? profiles[0].unit_number : user.unit_number;
      
      if (!userUnitNumber) return [];
      
      // Fetch notifications targeted by user_id OR by unit_number
      const byUserId = await base44.entities.Notification.filter({
        target_user_id: user.id
      }, '-created_date', 50);
      
      const byUnit = await base44.entities.Notification.filter({
        target_unit: userUnitNumber
      }, '-created_date', 50);
      
      // Merge and deduplicate
      const allNotifs = [...byUserId, ...byUnit];
      const uniqueNotifs = Array.from(new Map(allNotifs.map(n => [n.id, n])).values());
      
      // Extra safety: only show if target_user_id matches OR target_unit matches
      return uniqueNotifs.filter(n => 
        n.target_user_id === user.id || n.target_unit === userUnitNumber
      ).slice(0, 20);
    },
    enabled: !!user?.id,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 30000
  });

  const { data: generalAnnouncements, isLoading: isLoadingGeneral } = useQuery({
    queryKey: ['general-announcements'],
    queryFn: async () => {
      const allNotifs = await base44.entities.Notification.filter({
        type: 'announcement'
      }, '-created_date', 20);
      return allNotifs.filter(n => !n.target_user_id);
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 30000
  });

  const { data: archivedIds, isLoading: isLoadingArchives } = useQuery({
    queryKey: ['update-archives', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const archives = await base44.entities.UpdateArchive.filter({ userId: user.id }, '-archivedAt', 50);
      return archives.map(a => `${a.updateType}-${a.updateId}`);
    },
    enabled: !!user?.id,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always'
  });

  // Merge and sort updates, filtering out archived/inactive items
  const allItems = React.useMemo(() => {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const items = [];
    
    // Add building updates — triple-check: isActive=true, not deleted, not expired
    // Emergency type gets NO special pass-through — it must also be isActive=true and not deleted
    if (buildingUpdates) {
      items.push(...buildingUpdates
        .filter(u => {
          if (u.isActive !== true) return false;
          if (u.is_deleted) return false;
          if (u.expiresAt && new Date(u.expiresAt) <= now) return false;
          return true;
        })
        .map(u => ({ ...u, source: 'building' }))
      );
    }
    
    // Add personal notifications — package notifications always show; others: 7-day window
    if (personalNotifications) {
      items.push(...personalNotifications
        .filter(n => n.type === 'package' || new Date(n.created_date) >= sevenDaysAgo)
        .map(n => ({ ...n, source: 'notification' }))
      );
    }
    
    // Add general announcements — only from the past 7 days
    if (generalAnnouncements) {
      items.push(...generalAnnouncements
        .filter(n => new Date(n.created_date) >= sevenDaysAgo)
        .map(n => ({ ...n, source: 'notification' }))
      );
    }
    
    // Filter out user-archived items
    const filteredItems = archivedIds 
      ? items.filter(item => !archivedIds.includes(`${item.source}-${item.id}`))
      : items;
    
    return filteredItems;
  }, [buildingUpdates, personalNotifications, generalAnnouncements, archivedIds]);

  // Tab-filtered and priority-sorted items
  const displayItems = React.useMemo(() => {
    let filtered = allItems;

    if (activeTab === 'updates') {
      filtered = allItems.filter(item => item.type === 'update' || (item.source === 'building' && item.priority === 'important'));
    } else if (activeTab === 'emergency') {
      filtered = allItems.filter(item => item.type === 'emergency');
    }

    if (activeTab === 'all') {
      // Pinned: emergency first, then update/important; both groups newest-first
      // Then remaining regular notifications newest-first
      const emergencies = filtered.filter(i => i.type === 'emergency')
        .sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
      const updates = filtered.filter(i => i.type === 'update' || (i.source === 'building' && i.priority === 'important' && i.type !== 'emergency'))
        .sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
      const rest = filtered.filter(i => i.type !== 'emergency' && i.type !== 'update' && !(i.source === 'building' && i.priority === 'important'))
        .sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
      return [...emergencies, ...updates, ...rest].slice(0, 20);
    }

    return filtered.sort((a, b) => new Date(b.created_date) - new Date(a.created_date)).slice(0, 20);
  }, [allItems, activeTab]);

  // Notify parent of current active item count whenever allItems changes
  useEffect(() => {
    if (onCountChange && dataReady) {
      const count = allItems?.filter(i => i.type === 'emergency' || i.type === 'update' || i.priority === 'important').length || 0;
      onCountChange(count);
    }
  }, [allItems, dataReady, onCountChange]);

  // Mark data as ready only once all primary queries have completed their first fresh fetch.
  // Until then, always show the skeleton — never stale cached data.
  useEffect(() => {
    if (!isLoadingUpdates && !isLoadingGeneral && (!user?.id || (!isLoadingPersonal && !isLoadingArchives))) {
      setDataReady(true);
    }
  }, [isLoadingUpdates, isLoadingPersonal, isLoadingGeneral, isLoadingArchives, user?.id]);

  const isLoading = !dataReady;

  const isPinned = (item) => item.type === 'emergency' || item.type === 'update' || (item.source === 'building' && item.priority === 'important');

  const archiveMutation = useMutation({
    mutationFn: async ({ updateId, updateType }) => {
      if (!user?.id) {
        throw new Error('User not authenticated');
      }
      
      console.log('[ARCHIVE] Creating archive record:', { userId: user.id, updateId, updateType });
      
      const result = await base44.entities.UpdateArchive.create({
        userId: user.id,
        updateId,
        updateType,
        archivedAt: new Date().toISOString(),
        is_deleted: false
      });
      
      console.log('[ARCHIVE] Archive created successfully:', result);
      return { updateId, updateType, archiveId: result.id };
    },
    onMutate: async ({ updateId, updateType }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['update-archives'] });
      
      // Snapshot previous value
      const previousArchived = queryClient.getQueryData(['update-archives', user?.id]);
      
      // Optimistically add to archived ids
      const newArchivedId = `${updateType}-${updateId}`;
      queryClient.setQueryData(
        ['update-archives', user?.id], 
        [...(previousArchived || []), newArchivedId]
      );
      
      return { previousArchived };
    },
    onError: (err, variables, context) => {
      console.error('[ARCHIVE] Failed to archive:', err);
      // Rollback on error
      if (context?.previousArchived) {
        queryClient.setQueryData(['update-archives', user?.id], context.previousArchived);
      }
      toast.error(`Failed to archive: ${err.message || 'Unknown error'}`);
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['update-archives'] });
      queryClient.invalidateQueries({ queryKey: ['archived-items-optimized'] });
      queryClient.invalidateQueries({ queryKey: ['building-updates', 'active'] });
      toast.success(`Archived`);
    }
  });

  const archiveAllMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('User not authenticated');
      if (!allItems || allItems.length === 0) return 0;
      
      // Archive all currently visible items
      await Promise.all(
        allItems.map(item => 
          base44.entities.UpdateArchive.create({
            userId: user.id,
            updateId: item.id,
            updateType: item.source,
            archivedAt: new Date().toISOString(),
            is_deleted: false
          })
        )
      );
      
      return allItems.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ['update-archives'] });
      queryClient.invalidateQueries({ queryKey: ['archived-items-optimized'] });
      queryClient.invalidateQueries({ queryKey: ['building-updates', 'active'] });
      toast.success(`Archived ${count} updates`);
      setArchiveAllConfirm(false);
    },
    onError: (err) => {
      toast.error(`Failed to archive all: ${err.message || 'Unknown error'}`);
    }
  });

  const handleUpdateClick = (update, e) => {
    // Don't open modal if clicking archive button
    if (e?.target?.closest('.archive-button')) return;
    
    setSelectedUpdate(update);
    setIsModalOpen(true);
  };

  const unsendMutation = useMutation({
    mutationFn: async (item) => {
      // Hard soft-delete: marks it gone for ALL users permanently
      await base44.entities.BuildingUpdate.update(item.id, { isActive: false, is_deleted: true });
    },
    onMutate: async (item) => {
      queryClient.setQueryData(['building-updates', 'active'], (prev) =>
        prev ? prev.filter(u => u.id !== item.id) : prev
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['building-updates', 'active'] });
      toast.success('Notice removed for all users');
    },
    onError: (err) => {
      queryClient.invalidateQueries({ queryKey: ['building-updates', 'active'] });
      toast.error(`Failed to unsend: ${err.message}`);
    }
  });

  const editMutation = useMutation({
    mutationFn: async ({ id, title, message }) => {
      await base44.entities.BuildingUpdate.update(id, { title, message });
    },
    onMutate: async ({ id, title, message }) => {
      queryClient.setQueryData(['building-updates', 'active'], (prev) =>
        prev ? prev.map(u => u.id === id ? { ...u, title, message } : u) : prev
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['building-updates', 'active'] });
      toast.success('Notice updated');
    },
    onError: (err) => {
      queryClient.invalidateQueries({ queryKey: ['building-updates', 'active'] });
      toast.error(`Failed to update: ${err.message}`);
    }
  });

  const resolveMutation = useMutation({
    mutationFn: async (item) => {
      await base44.entities.BuildingUpdate.update(item.id, { is_resolved: !item.is_resolved });
    },
    onMutate: async (item) => {
      queryClient.setQueryData(['building-updates', 'active'], (prev) =>
        prev ? prev.map(u => u.id === item.id ? { ...u, is_resolved: !u.is_resolved } : u) : prev
      );
    },
    onSuccess: (_, item) => {
      queryClient.invalidateQueries({ queryKey: ['building-updates', 'active'] });
      toast.success(item.is_resolved ? 'Marked as unresolved' : 'Marked as resolved');
      setIsModalOpen(false);
    },
    onError: (err) => {
      queryClient.invalidateQueries({ queryKey: ['building-updates', 'active'] });
      toast.error(`Failed: ${err.message}`);
    }
  });

  const handleArchive = (item, e) => {
    e.stopPropagation();
    
    if (isPinned(item)) {
      if (!confirm('This is a pinned update. Archive anyway?')) {
        return;
      }
    }
    
    archiveMutation.mutate({
      updateId: item.id,
      updateType: item.source
    });
  };

  const handleArchiveAll = () => {
    setArchiveAllConfirm(true);
  };

  const confirmArchiveAll = () => {
    archiveAllMutation.mutate();
  };

  const getTypeBadge = (type) => {
    const config = {
      general: { label: t('General'), className: 'bg-blue-100 text-blue-700', icon: Bell },
      maintenance: { label: t('Maintenance'), className: 'bg-orange-100 text-orange-700', icon: AlertCircle },
      security: { label: t('Security'), className: 'bg-red-100 text-red-700', icon: ShieldAlert },
      security_report: { label: t('Security'), className: 'bg-red-100 text-red-700', icon: ShieldAlert },
      amenity: { label: t('Amenity'), className: 'bg-purple-100 text-purple-700', icon: Bell },
      emergency: { label: `🚨 ${t('Emergency')}`, className: 'bg-red-600 text-white', icon: Zap },
      update: { label: `📌 ${t('Updates')}`, className: 'bg-zinc-800 text-white', icon: AlertTriangle },
      package: { label: t('Packages'), className: 'bg-blue-100 text-blue-700', icon: Package },
      announcement: { label: t('Announcement'), className: 'bg-indigo-100 text-indigo-700', icon: Bell }
    };
    return config[type] || config.general;
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {/* Header skeleton */}
        <div className="flex items-center gap-2 mb-2">
          <Bell className="w-5 h-5 text-zinc-400" />
          <h3 className="font-semibold text-lg">{t('Updates & Alerts')}</h3>
          <div className="ml-auto flex gap-2">
            <div className="h-7 w-20 bg-zinc-100 rounded-md animate-pulse" />
            <div className="h-7 w-20 bg-zinc-100 rounded-md animate-pulse" />
          </div>
        </div>
        {/* Tabs skeleton */}
        <div className="flex gap-1 bg-zinc-100 rounded-lg p-1 mb-3">
          {['All', 'Updates', 'Emergency'].map(label => (
            <div key={label} className="flex-1 py-1.5 px-2 rounded-md bg-zinc-200/60 animate-pulse h-7" />
          ))}
        </div>
        {/* Card skeletons */}
        {[1, 2, 3, 4].map(i => (
          <Card key={i} className="overflow-hidden">
            <CardContent className="p-4 space-y-2">
              <div className="flex items-start gap-2">
                <div className="w-4 h-4 mt-0.5 rounded bg-zinc-200 animate-pulse flex-shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className={`h-4 bg-zinc-200 rounded animate-pulse`} style={{ width: `${55 + (i * 11) % 35}%` }} />
                  <div className="flex gap-2">
                    <div className="h-3 w-16 bg-zinc-100 rounded animate-pulse" />
                    <div className="h-3 w-20 bg-zinc-100 rounded animate-pulse" />
                  </div>
                  <div className="h-3 bg-zinc-100 rounded animate-pulse w-full" />
                  <div className="h-3 bg-zinc-100 rounded animate-pulse" style={{ width: `${40 + (i * 13) % 40}%` }} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  // Count per tab (from allItems, not filtered)
  const emergencyCount = allItems?.filter(i => i.type === 'emergency').length || 0;
  const updatesCount = allItems?.filter(i => i.type === 'update' || (i.source === 'building' && i.priority === 'important')).length || 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-2">
        <Bell className="w-5 h-5 text-zinc-600" />
        <h3 className="font-semibold text-lg">{t('Updates & Alerts')}</h3>
        {allItems?.length > 0 && (
          <Badge variant="outline">{allItems.length}</Badge>
        )}
        <div className="ml-auto flex gap-2">
          {allItems?.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={handleArchiveAll}
            >
              <Archive className="w-4 h-4 mr-1" />
              {t('Archive All')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => setIsArchivedModalOpen(true)}
          >
            <Archive className="w-4 h-4 mr-1" />
            {t('Archived')}
          </Button>
        </div>
      </div>

      {/* Segmented Tabs */}
      <div className="flex gap-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg p-1 mb-3">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`relative flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-all duration-200
              ${activeTab === tab.id 
                ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm' 
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}
              ${tab.id === 'emergency' && emergencyCount > 0 && activeTab !== 'emergency' ? 'text-red-600' : ''}
            `}
          >
            {tab.id === 'emergency' && <Zap className="w-3 h-3" />}
            {tab.label}
            {tab.id === 'emergency' && emergencyCount > 0 && (
              <span className="ml-0.5 min-w-[16px] h-4 rounded-full bg-red-500 text-white text-[10px] flex items-center justify-center px-1 font-bold">
                {emergencyCount}
              </span>
            )}
            {tab.id === 'updates' && updatesCount > 0 && (
              <span className="ml-0.5 min-w-[16px] h-4 rounded-full bg-zinc-600 text-white text-[10px] flex items-center justify-center px-1 font-bold">
                {updatesCount}
              </span>
            )}
          </button>
        ))}
      </div>

      <motion.div
        key="updates-list"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25 }}
        className="space-y-3 lg:max-h-[calc(100vh-14rem)] lg:overflow-y-auto pr-2"
      >
        <AnimatePresence mode="popLayout">
        {!displayItems || displayItems.length === 0 ? (
          <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <Card className="border-dashed bg-zinc-50/50 dark:bg-zinc-800/50 dark:border-zinc-700">
              <CardContent className="p-6 text-center text-zinc-400 dark:text-zinc-500">
                <Bell className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">
                  {activeTab === 'emergency' ? t('No active emergencies.') : activeTab === 'updates' ? t('No building updates.') : t('No updates at this time.')}
                </p>
              </CardContent>
            </Card>
          </motion.div>
        ) : (
          displayItems.map((item, index) => {
            const title = item.title;
            const message = item.message;
            const type = item.type;
            const typeBadge = getTypeBadge(type);
            const Icon = typeBadge.icon;
            const pinned = isPinned(item);
            const isEmergency = item.type === 'emergency';
            
            return (
              <motion.div
                key={`${item.source}-${item.id}`}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.18 }}
              >
                <Card 
                  className={`cursor-pointer hover:shadow-md transition-shadow bg-white/80 dark:bg-zinc-800/80 backdrop-blur-sm
                    ${isEmergency ? 'border-red-400 border-l-4 bg-red-50/60 dark:bg-red-950/30' : ''}
                    ${!isEmergency && pinned ? 'border-zinc-400 dark:border-zinc-500 border-l-4' : ''}
                    ${!pinned && item.is_read === false ? 'border-blue-300 border-l-4' : ''}
                    ${!pinned && item.is_read !== false && !isEmergency ? 'border-zinc-200 dark:border-zinc-700' : ''}
                  `}
                  onClick={(e) => handleUpdateClick(item, e)}
                >
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-start gap-2">
                      {isEmergency ? (
                        <Zap className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-600" />
                      ) : (
                        <Icon className={`w-4 h-4 flex-shrink-0 mt-0.5 ${item.is_read === false ? 'text-blue-600' : 'text-zinc-400'}`} />
                      )}
                      <div className="flex-1">
                        <h4 className={`text-sm line-clamp-1 ${isEmergency ? 'font-bold text-red-900 dark:text-red-400' : item.is_read === false ? 'font-bold dark:text-zinc-100' : 'font-semibold dark:text-zinc-100'} ${item.is_resolved ? 'line-through text-zinc-400 dark:text-zinc-500' : ''}`}>
                          {item.is_resolved && <CheckCircle2 className="w-3 h-3 inline mr-1 text-green-500 no-underline" style={{textDecoration:'none'}} />}
                          {title}
                        </h4>
                      </div>
                      {pinned && (
                        <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400 flex-shrink-0">
                          {isEmergency ? '🚨 PINNED' : '📌 PINNED'}
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="archive-button h-6 w-6 -mr-1 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex-shrink-0"
                        onClick={(e) => handleArchive(item, e)}
                        title="Archive update"
                      >
                        <Archive className="w-3.5 h-3.5 text-zinc-400 hover:text-zinc-600" />
                      </Button>
                    </div>
                    
                    <div className="flex items-center gap-2 text-xs">
                      <Badge variant="outline" className={`${typeBadge.className} text-xs`}>
                        {typeBadge.label}
                      </Badge>
                      <span className="text-zinc-400 dark:text-zinc-500">
                        {format(new Date(item.created_date), 'MMM d, h:mm a')}
                      </span>
                    </div>

                    <p className="text-sm text-zinc-600 dark:text-zinc-400 line-clamp-2">
                      {message}
                    </p>

                    {item.attachment_url && (
                      <div className="flex items-center gap-1 text-xs text-zinc-400 dark:text-zinc-500 mt-1">
                        <Paperclip className="w-3 h-3" />
                        <span className="truncate">{item.attachment_name || 'Attachment'}</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            );
          })
        )}
        </AnimatePresence>
      </motion.div>

      <BuildingUpdateModal 
        update={selectedUpdate}
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setSelectedUpdate(null); }}
        user={user}
        onUnsend={(item) => unsendMutation.mutate(item)}
        onEdit={(item) => editMutation.mutate({ id: item.id, title: item.title, message: item.message })}
        onResolve={(item) => resolveMutation.mutate(item)}
      />

      <ArchivedUpdatesModal 
        isOpen={isArchivedModalOpen}
        onClose={() => setIsArchivedModalOpen(false)}
        user={user}
      />

      {/* Archive All Confirmation Dialog */}
      <Dialog open={archiveAllConfirm} onOpenChange={setArchiveAllConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-orange-600" />
              {t('Archive All Updates')}
            </DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {t('Are you sure you want to archive all')} {allItems?.length || 0} {t('active updates? You can restore them later from the Archived section.')}
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setArchiveAllConfirm(false)}
              disabled={archiveAllMutation.isPending}
            >
              {t('Cancel')}
            </Button>
            <Button
              onClick={confirmArchiveAll}
              disabled={archiveAllMutation.isPending}
            >
              {archiveAllMutation.isPending ? t('Archiving...') : t('Archive All')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
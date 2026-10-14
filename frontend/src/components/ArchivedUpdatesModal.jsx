import React from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';
import { Bell, AlertCircle, Package, ShieldAlert, RotateCcw, Eye, Trash2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import BuildingUpdateModal from './BuildingUpdateModal';

export default function ArchivedUpdatesModal({ isOpen, onClose, user }) {
  const [selectedUpdate, setSelectedUpdate] = React.useState(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = React.useState(false);
  const [limit, setLimit] = React.useState(20);
  const [deleteAllConfirm, setDeleteAllConfirm] = React.useState(false);
  const queryClient = useQueryClient();

  const { data: archivedItems, isLoading } = useQuery({
    queryKey: ['archived-items-optimized', user?.id, limit],
    queryFn: async () => {
      if (!user?.id) {
        console.log('[ARCHIVED] No user ID available');
        return [];
      }
      
      console.log('[ARCHIVED] Fetching archives for userId:', user.id, 'limit:', limit);
      
      // Fetch archives with limit, sorted by archivedAt desc, exclude deleted
      const allArchives = await base44.entities.UpdateArchive.filter(
        { userId: user.id }, 
        '-archivedAt', 
        limit
      );
      
      // Filter out deleted items
      const archives = allArchives.filter(a => !a.is_deleted);
      
      console.log('[ARCHIVED] Found', archives.length, 'archive records');
      
      if (archives.length === 0) {
        console.log('[ARCHIVED] No archives found, returning empty array');
        return [];
      }
      
      // Batch fetch all building updates and notifications
      const buildingIds = archives.filter(a => a.updateType === 'building').map(a => a.updateId);
      const notificationIds = archives.filter(a => a.updateType === 'notification').map(a => a.updateId);
      
      console.log('[ARCHIVED] Fetching buildingIds:', buildingIds.length, 'notificationIds:', notificationIds.length);
      
      const [buildings, notifications] = await Promise.all([
        buildingIds.length > 0 
          ? base44.entities.BuildingUpdate.list('-created_date', 100).then(all => 
              all.filter(b => buildingIds.includes(b.id))
            )
          : [],
        notificationIds.length > 0 
          ? base44.entities.Notification.list('-created_date', 100).then(all => 
              all.filter(n => notificationIds.includes(n.id))
            )
          : []
      ]);
      
      console.log('[ARCHIVED] Fetched', buildings.length, 'buildings and', notifications.length, 'notifications');
      
      // Map archives to items
      const items = archives.map(archive => {
        let item;
        if (archive.updateType === 'building') {
          item = buildings.find(b => b.id === archive.updateId);
          if (item) return { ...item, source: 'building', archiveRecord: archive };
        } else if (archive.updateType === 'notification') {
          item = notifications.find(n => n.id === archive.updateId);
          if (item) return { ...item, source: 'notification', archiveRecord: archive };
        }
        return null;
      }).filter(Boolean);
      
      console.log('[ARCHIVED] Returning', items.length, 'items');
      
      // Show debug toast
      if (isOpen) {
        toast.info(`Archived count: ${items.length}`, { duration: 3000 });
      }
      
      return items;
    },
    enabled: !!user?.id && isOpen,
    staleTime: 30000, // Cache for 30 seconds
    refetchOnMount: 'always'
  });
  
  // Log when modal opens
  React.useEffect(() => {
    if (isOpen && user?.id) {
      console.log('[ARCHIVED MODAL] Opened for user:', user.id);
    }
  }, [isOpen, user?.id]);

  const restoreMutation = useMutation({
    mutationFn: async ({ archiveId, itemId, source }) => {
      await base44.entities.UpdateArchive.delete(archiveId);
      return { itemId, source };
    },
    onMutate: async ({ archiveId, itemId, source }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['archived-items-optimized'] });
      
      // Snapshot previous value
      const previousArchived = queryClient.getQueryData(['archived-items-optimized', user?.id, limit]);
      
      // Optimistically remove from archived list
      if (previousArchived) {
        queryClient.setQueryData(
          ['archived-items-optimized', user?.id, limit], 
          previousArchived.filter(item => item.id !== itemId)
        );
      }
      
      return { previousArchived };
    },
    onError: (err, variables, context) => {
      // Rollback on error
      if (context?.previousArchived) {
        queryClient.setQueryData(
          ['archived-items-optimized', user?.id, limit], 
          context.previousArchived
        );
      }
      toast.error('Failed to restore update');
    },
    onSuccess: () => {
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ['update-archives'] });
      queryClient.invalidateQueries({ queryKey: ['building-updates'] });
      queryClient.invalidateQueries({ queryKey: ['personal-notifications'] });
      queryClient.invalidateQueries({ queryKey: ['general-announcements'] });
      toast.success('Update restored to active feed');
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ archiveId, itemId }) => {
      // Mark as deleted by updating the archive record
      await base44.entities.UpdateArchive.update(archiveId, {
        is_deleted: true,
        deleted_at: new Date().toISOString()
      });
      return { archiveId, itemId };
    },
    onMutate: async ({ archiveId, itemId }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['archived-items-optimized'] });
      
      // Snapshot previous value
      const previousArchived = queryClient.getQueryData(['archived-items-optimized', user?.id, limit]);
      
      // Optimistically remove from archived list
      if (previousArchived) {
        queryClient.setQueryData(
          ['archived-items-optimized', user?.id, limit], 
          previousArchived.filter(item => item.id !== itemId)
        );
      }
      
      return { previousArchived };
    },
    onError: (err, variables, context) => {
      // Rollback on error
      if (context?.previousArchived) {
        queryClient.setQueryData(
          ['archived-items-optimized', user?.id, limit], 
          context.previousArchived
        );
      }
      toast.error(`Failed to delete: ${err.message || 'Unknown error'}`);
    },
    onSuccess: () => {
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ['update-archives'] });
      queryClient.invalidateQueries({ queryKey: ['archived-items-optimized'] });
      toast.success('Archived update deleted');
    }
  });

  const deleteAllMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('User not authenticated');
      
      // Fetch all archive records for this user
      const archives = await base44.entities.UpdateArchive.filter({ userId: user.id }, '-archivedAt', 500);
      
      // Mark all as deleted
      await Promise.all(
        archives.map(archive => 
          base44.entities.UpdateArchive.update(archive.id, {
            is_deleted: true,
            deleted_at: new Date().toISOString()
          })
        )
      );
      
      return archives.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ['update-archives'] });
      queryClient.invalidateQueries({ queryKey: ['archived-items-optimized'] });
      toast.success(`Deleted ${count} archived updates`);
      setDeleteAllConfirm(false);
    },
    onError: (err) => {
      toast.error(`Failed to delete all: ${err.message || 'Unknown error'}`);
    }
  });

  const handleRestore = (item) => {
    restoreMutation.mutate({
      archiveId: item.archiveRecord.id,
      itemId: item.id,
      source: item.source
    });
  };

  const handleDelete = (item) => {
    if (!confirm('Delete this archived update? This cannot be undone.')) {
      return;
    }
    
    deleteMutation.mutate({
      archiveId: item.archiveRecord.id,
      itemId: item.id
    });
  };

  const handleDeleteAll = () => {
    setDeleteAllConfirm(true);
  };

  const confirmDeleteAll = () => {
    deleteAllMutation.mutate();
  };

  const handleViewDetail = (item) => {
    if (item.source === 'building') {
      setSelectedUpdate(item);
      setIsDetailModalOpen(true);
    }
  };

  const getTypeBadge = (type) => {
    const config = {
      general: { label: 'General', className: 'bg-blue-100 text-blue-700', icon: Bell },
      maintenance: { label: 'Maintenance', className: 'bg-orange-100 text-orange-700', icon: AlertCircle },
      security: { label: 'Security', className: 'bg-red-100 text-red-700', icon: ShieldAlert },
      security_report: { label: 'Security', className: 'bg-red-100 text-red-700', icon: ShieldAlert },
      amenity: { label: 'Amenity', className: 'bg-purple-100 text-purple-700', icon: Bell },
      emergency: { label: 'Emergency', className: 'bg-red-600 text-white', icon: AlertCircle },
      package: { label: 'Package', className: 'bg-blue-100 text-blue-700', icon: Package },
      announcement: { label: 'Announcement', className: 'bg-indigo-100 text-indigo-700', icon: Bell }
    };
    return config[type] || config.general;
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle className="flex items-center gap-2">
                <Bell className="w-5 h-5" />
                Archived Updates
              </DialogTitle>
              {archivedItems && archivedItems.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  onClick={handleDeleteAll}
                >
                  <Trash2 className="w-3 h-3 mr-1" />
                  Delete All
                </Button>
              )}
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto pr-2 space-y-3">
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => (
                  <Card key={i} className="animate-pulse">
                    <CardContent className="p-4">
                      <div className="h-4 bg-zinc-200 rounded w-3/4 mb-2"></div>
                      <div className="h-3 bg-zinc-100 rounded w-1/2"></div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : !archivedItems || archivedItems.length === 0 ? (
              <Card className="border-dashed bg-zinc-50/50">
                <CardContent className="p-8 text-center text-zinc-400">
                  <Bell className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">No archived updates.</p>
                </CardContent>
              </Card>
            ) : (
              archivedItems.map((item) => {
                const typeBadge = getTypeBadge(item.type);
                const Icon = typeBadge.icon;
                
                return (
                  <motion.div
                    key={`${item.source}-${item.id}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                  >
                    <Card className="bg-white border-zinc-200">
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-start gap-2">
                          <Icon className="w-4 h-4 flex-shrink-0 mt-0.5 text-zinc-400" />
                          <div className="flex-1">
                            <h4 className="text-sm font-semibold line-clamp-1">{item.title}</h4>
                          </div>
                          {item.priority === 'important' && (
                            <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0" />
                          )}
                        </div>
                        
                        <div className="flex items-center gap-2 text-xs flex-wrap">
                          <Badge variant="outline" className={`${typeBadge.className} text-xs`}>
                            {typeBadge.label}
                          </Badge>
                          <span className="text-zinc-400">
                            Posted: {format(new Date(item.created_date), 'MMM d, h:mm a')}
                          </span>
                          <span className="text-zinc-400">•</span>
                          <span className="text-zinc-400">
                            Archived: {format(new Date(item.archiveRecord.archivedAt), 'MMM d, h:mm a')}
                          </span>
                        </div>

                        <p className="text-sm text-zinc-600 line-clamp-2">{item.message}</p>

                        <div className="flex gap-2">
                          {item.source === 'building' && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleViewDetail(item)}
                            >
                              <Eye className="w-3 h-3 mr-1" />
                              View
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRestore(item)}
                            disabled={restoreMutation.isPending || deleteMutation.isPending}
                          >
                            <RotateCcw className="w-3 h-3 mr-1" />
                            Restore
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => handleDelete(item)}
                            disabled={restoreMutation.isPending || deleteMutation.isPending}
                          >
                            <Trash2 className="w-3 h-3 mr-1" />
                            Delete
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                );
              })
            )}
            
            {archivedItems && archivedItems.length >= limit && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setLimit(limit + 20)}
                disabled={isLoading}
              >
                Load More
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <BuildingUpdateModal 
        update={selectedUpdate}
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
      />

      {/* Delete All Confirmation Dialog */}
      <Dialog open={deleteAllConfirm} onOpenChange={setDeleteAllConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-600" />
              Delete All Archived Updates
            </DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-zinc-600">
              Are you sure you want to permanently delete all archived updates? This action cannot be undone.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setDeleteAllConfirm(false)}
              disabled={deleteAllMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteAll}
              disabled={deleteAllMutation.isPending}
            >
              {deleteAllMutation.isPending ? 'Deleting...' : 'Delete All'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
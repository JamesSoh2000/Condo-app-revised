import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Search, Plus, CheckCircle, Box, Package, History, X, ZoomIn, ChevronDown, ChevronUp } from 'lucide-react';
import { format, isToday, isYesterday, differenceInDays } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import PhotoViewer from '@/components/PhotoViewer';
import { useLanguage } from '@/lib/LanguageContext';

export default function Packages() {
  const { t } = useLanguage();
  const [selectedPackage, setSelectedPackage] = useState(null);
  const [photoViewerPhotos, setPhotoViewerPhotos] = useState(null);
  const [photoViewerIndex, setPhotoViewerIndex] = useState(0);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [showSuccessAnimation, setShowSuccessAnimation] = useState(false);
  const [retryDisabled, setRetryDisabled] = useState(false);
  const queryClient = useQueryClient();

  const pickupMutation = useMutation({
    mutationFn: async (packageId) => {
      const currentUser = await base44.auth.me();
      if (!currentUser?.id) throw new Error('Not authenticated');
      
      return base44.entities.Package.update(packageId, {
        status: 'picked_up',
        picked_up_at: new Date().toISOString(),
        picked_up_by_user_id: currentUser.id,
        pickup_method: 'resident'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['resident-packages']);
      setSelectedPackage(null);
      
      // Show success animation
      setShowSuccessAnimation(true);
      setTimeout(() => setShowSuccessAnimation(false), 2000);
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to confirm pickup');
    }
  });

  const { data: user, isLoading: userLoading } = useQuery({
    queryKey: ['me'],
    queryFn: () => base44.auth.me(),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  });

  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ['resident-profile', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      
      console.log('[Packages] Fetching profile for userId:', user.id);
      
      const profiles = await base44.entities.Profile.filter({ userId: user.id });
      if (profiles.length > 0) {
        console.log('[Packages] Profile found:', profiles[0].id, '| unit_id:', profiles[0].unit_id);
        return profiles[0];
      }
      
      const residentProfiles = await base44.entities.ResidentProfile.filter({ user_id: user.id });
      if (residentProfiles.length > 0 && residentProfiles[0].status === 'approved') {
        const rp = residentProfiles[0];
        console.log('[Packages] ResidentProfile found:', rp.id, '| unit_id:', rp.unit_id);
        return {
          id: rp.id,
          userId: rp.user_id,
          unit_id: rp.unit_id,
          unit_number: rp.unit_number,
          full_name: rp.full_name,
          _isResidentProfile: true
        };
      }
      
      console.warn('[Packages] No profile found for userId:', user.id);
      return null;
    },
    enabled: !!user?.id,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  });

  const { data: unit, isLoading: unitLoading } = useQuery({
    queryKey: ['resident-unit', user?.id, profile?.unit_id, profile?.unit_number],
    queryFn: async () => {
      if (!profile) return null;
      
      if (profile.unit_id) {
        const units = await base44.entities.Unit.filter({ id: profile.unit_id });
        if (units.length > 0) {
          console.log('[Packages] Unit found by unit_id:', units[0].id, units[0].unit_number, units[0].tower);
          return units[0];
        }
      }
      
      if (profile.unit_number) {
        const parts = profile.unit_number.toString().trim().split(/\s+/);
        const unitNum = parts[0];
        const tower = parts[1] || (unitNum.startsWith('1') ? 'E' : 'W');
        const units = await base44.entities.Unit.filter({ unit_number: unitNum, tower });
        
        if (units.length > 0) {
          try {
            if (profile._isResidentProfile) {
              await base44.entities.ResidentProfile.update(profile.id, { unit_id: units[0].id });
            } else {
              await base44.entities.Profile.update(profile.id, { unit_id: units[0].id });
            }
          } catch (_) {}
          console.log('[Packages] Unit found by unit_number:', units[0].id, units[0].unit_number, units[0].tower);
          return units[0];
        }
      }
      
      console.warn('[Packages] No unit found for profile:', profile.id, '| unit_id:', profile.unit_id, '| unit_number:', profile.unit_number);
      return null;
    },
    enabled: !!profile && !!user?.id,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  });

  const { data: packages, isLoading, error, refetch } = useQuery({
    queryKey: ['resident-packages', profile?.id, unit?.id],
    queryFn: async () => {
      const allPackages = await base44.entities.Package.filter(
        { unit_id: unit.id },
        '-created_date',
        50
      );
      return allPackages.filter(pkg => 
        pkg.recipient_profile_id === profile.id || !pkg.recipient_profile_id
      );
    },
    enabled: !!unit?.id && !!profile?.id && !userLoading && !profileLoading && !unitLoading,
    staleTime: 60 * 1000,
    gcTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: 'always',
  });

  // Real-time subscription for instant updates when packages are created/updated
  React.useEffect(() => {
    if (!unit?.id || !profile?.id) return;

    const unsubscribe = base44.entities.Package.subscribe((event) => {
      if (event.data?.unit_id === unit.id) {
        queryClient.invalidateQueries(['resident-packages', profile.id, unit.id]);
      }
    });

    return () => unsubscribe();
  }, [unit?.id, profile?.id, queryClient]);

  // Show unit info loading
  if (userLoading || profileLoading || unitLoading) {
    return (
      <div className="p-8 text-center">
        <div className="max-w-md mx-auto bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 p-8">
          <Package className="w-12 h-12 mx-auto mb-4 text-zinc-300 dark:text-zinc-600" />
          <p className="text-zinc-500 dark:text-zinc-400 mb-2">{t('Loading your unit information...')}</p>
          <div className="w-full h-2 bg-zinc-100 rounded-full overflow-hidden">
            <div className="h-full bg-blue-600 rounded-full animate-pulse w-1/3"></div>
          </div>
        </div>
      </div>
    );
  }

  // Check if unit info is missing
  if (!unit?.id) {
    return (
      <div className="p-8">
        <div className="max-w-md mx-auto bg-white dark:bg-zinc-800 rounded-xl border border-yellow-200 dark:border-yellow-900/40 p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center mx-auto mb-4">
            <X className="w-6 h-6 text-yellow-600" />
          </div>
          <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">{t('Unit Not Assigned')}</h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">{t('Your unit hasn\'t been assigned yet. Please contact management to complete your unit setup.')}</p>
        </div>
      </div>
    );
  }

  // Show error state
  if (error) {
    const handleRetry = () => {
      setRetryDisabled(true);
      refetch();
      setTimeout(() => setRetryDisabled(false), 5000);
    };

    return (
      <div className="p-8">
        <div className="max-w-md mx-auto bg-white dark:bg-zinc-800 rounded-xl border border-red-200 dark:border-red-900/40 p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mx-auto mb-4">
            <X className="w-6 h-6 text-red-600" />
          </div>
          <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">{t('Packages couldn\'t load right now')}</h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">{t('Please wait a moment and try again.')}</p>
          <div className="flex gap-2 justify-center">
            <Button onClick={handleRetry} disabled={retryDisabled} className="bg-blue-600 hover:bg-blue-700">
              {retryDisabled ? t('Please wait...') : t('Try Again')}
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              {t('Reload Page')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Show loading skeleton
  if (isLoading) {
    return (
      <div className="space-y-8 p-4">
        <div className="flex items-center gap-4 mb-8">
          <div className="w-16 h-16 bg-zinc-200 rounded-2xl animate-pulse" />
          <div className="space-y-2">
            <div className="h-8 w-40 bg-zinc-200 rounded animate-pulse" />
            <div className="h-4 w-28 bg-zinc-100 rounded animate-pulse" />
          </div>
        </div>
        <div className="space-y-3">
          <div className="h-24 bg-white rounded-xl border border-zinc-100 animate-pulse" />
          <div className="h-24 bg-white rounded-xl border border-zinc-100 animate-pulse" />
        </div>
      </div>
    );
  }

  const activePackages = packages?.filter(p => p.status === 'ready_for_pickup') || [];
  
  // Filter history to only include packages from last 30 days (client-side safety check)
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const historyPackages = (packages?.filter(p => {
    if (p.status !== 'picked_up' && p.status !== 'collected') return false;
    // Use picked_up_at for picked up packages, created_date for fallback
    const referenceDate = new Date(p.picked_up_at || p.created_date);
    return referenceDate >= thirtyDaysAgo;
  }) || []).sort((a, b) => new Date(b.picked_up_at || b.created_date) - new Date(a.picked_up_at || a.created_date));
  
  // Group history by date
  const groupedHistory = historyPackages.reduce((groups, pkg) => {
    const date = new Date(pkg.picked_up_at || pkg.created_date);
    const dateKey = format(date, 'yyyy-MM-dd');
    
    if (!groups[dateKey]) {
      groups[dateKey] = {
        date: date,
        packages: []
      };
    }
    groups[dateKey].packages.push(pkg);
    return groups;
  }, {});
  
  const sortedDateKeys = Object.keys(groupedHistory).sort((a, b) => new Date(b) - new Date(a));
  
  const getDateLabel = (date) => {
    if (isToday(date)) return 'Today';
    if (isYesterday(date)) return 'Yesterday';
    return format(date, 'MMM d, yyyy');
  };
  
  // Get first 5 packages for collapsed view
  const first5Packages = historyPackages.slice(0, 5);
  const displayPackages = historyExpanded ? historyPackages : first5Packages;

  const PackageCard = ({ pkg }) => (
    <div 
      className="bg-white dark:bg-zinc-800 rounded-xl border border-zinc-100 dark:border-zinc-700 p-4 flex items-center justify-between hover:bg-zinc-50 dark:hover:bg-zinc-750 transition-colors cursor-pointer"
      onClick={() => setSelectedPackage(pkg)}
    >
        <div className="flex items-center gap-4">
            {pkg.packagePhotoUrls && pkg.packagePhotoUrls.length > 0 ? (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        setPhotoViewerPhotos(pkg.packagePhotoUrls);
                        setPhotoViewerIndex(0);
                    }}
                    className="relative group"
                >
                    <img 
                        src={pkg.packagePhotoUrls[0]} 
                        alt="Package" 
                        loading="lazy"
                        className="w-16 h-16 rounded-lg object-cover border-2 border-zinc-200 group-hover:border-blue-400 transition-colors"
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 rounded-lg flex items-center justify-center transition-colors">
                        <ZoomIn className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                    {pkg.packagePhotoUrls.length > 1 && (
                        <div className="absolute -top-1 -right-1 bg-blue-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold">
                            {pkg.packagePhotoUrls.length}
                        </div>
                    )}
                </button>
            ) : (
                <div className={`w-16 h-16 rounded-lg flex items-center justify-center ${(pkg.status === 'picked_up' || pkg.status === 'collected') ? 'bg-zinc-100 text-zinc-400' : 'bg-blue-50 text-blue-600'}`}>
                    <Box className="w-6 h-6" />
                </div>
            )}
            <div>
                <div className="flex items-center gap-2">
                    <span className="font-semibold text-zinc-900 dark:text-zinc-100">{pkg.recipient_name}</span>
                    {pkg.status === 'ready_for_pickup' && <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">{t('Ready')}</Badge>}
                    {(pkg.status === 'picked_up' || pkg.status === 'collected') && <Badge className="bg-green-100 text-green-700">{t('Picked Up')}</Badge>}
                </div>
                <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
                    {pkg.status === 'picked_up' && pkg.picked_up_at
                      ? `${t('Picked up')} ${format(new Date(pkg.picked_up_at), 'MMM d, h:mm a')}`
                      : `${t('Delivered')} ${format(new Date(pkg.created_date), 'MMM d, h:mm a')}`
                    }
                </p>
                {pkg.notes && <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1 italic">"{pkg.notes}"</p>}
            </div>
        </div>
        {pkg.status === 'ready_for_pickup' && (
            <Button 
              variant="outline" 
              size="sm"
              className="text-green-600 hover:text-green-700 hover:bg-green-50 border-green-200"
              onClick={(e) => {
                e.stopPropagation();
                pickupMutation.mutate(pkg.id);
              }}
              disabled={pickupMutation.isPending}
            >
              {pickupMutation.isPending ? 'Confirming...' : 'Confirm Pick Up'}
            </Button>
        )}
    </div>
  );

  const WindowBox = ({ title, icon: Icon, count, children, delay = 0 }) => (
    <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        whileHover={{ 
            scale: 1.02,
        }}
        transition={{ type: "spring", stiffness: 300, damping: 20, delay }}
        className="group"
    >
        <div className="flex items-center gap-2 mb-3 px-1">
            <Icon className="w-5 h-5 text-zinc-500 group-hover:text-blue-600 transition-colors" />
            <h2 className="text-xl font-semibold text-zinc-900">{title}</h2>
            {count > 0 && <Badge className="bg-blue-600 ml-2">{count}</Badge>}
        </div>
        <Card className="bg-white/80 dark:bg-zinc-800/80 backdrop-blur-sm border-zinc-200 dark:border-zinc-700 p-4 shadow-sm group-hover:border-blue-200 dark:group-hover:border-blue-700 transition-colors">
            <div className="grid gap-3">
                {children}
            </div>
        </Card>
    </motion.div>
  );

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4 mb-8">
          <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-blue-600/20">
              <Package className="w-8 h-8" />
          </div>
          <div>
              <h1 className="text-4xl font-bold tracking-tight text-zinc-900">{t('My Packages')}</h1>
              <p className="text-zinc-500">
                  {t('Deliveries for Unit')} {unit?.display_unit || `${unit?.unit_number} ${unit?.tower}`}
              </p>
          </div>
      </div>

      <WindowBox title={t('Ready for Pickup')} icon={Package} count={activePackages.length}>
        {activePackages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-zinc-400 dark:text-zinc-600 border-2 border-dashed border-zinc-100 dark:border-zinc-700 rounded-xl">
                <Box className="w-10 h-10 mb-2 opacity-30" />
                <p className="text-sm">{t('No active packages.')}</p>
            </div>
        ) : (
            activePackages.map(pkg => <PackageCard key={pkg.id} pkg={pkg} />)
        )}
      </WindowBox>

      <WindowBox title={t('Package History')} icon={History} delay={0.1}>
        {historyPackages.length === 0 ? (
          <p className="text-sm text-zinc-400 dark:text-zinc-500 italic text-center py-8">{t('No package history (last 30 days).')}</p>
        ) : (
          <div className="space-y-4">
            {/* Group displayed packages by date */}
            {(() => {
              const grouped = displayPackages.reduce((groups, pkg) => {
                const date = new Date(pkg.picked_up_at || pkg.created_date);
                const dateKey = format(date, 'yyyy-MM-dd');
                if (!groups[dateKey]) {
                  groups[dateKey] = { date: date, packages: [] };
                }
                groups[dateKey].packages.push(pkg);
                return groups;
              }, {});
              
              const dateKeys = Object.keys(grouped).sort((a, b) => new Date(b) - new Date(a));
              
              return dateKeys.map((dateKey) => {
                const group = grouped[dateKey];
                return (
                  <div key={dateKey} className="space-y-2">
                    <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide px-1">
                      {getDateLabel(group.date)}
                    </div>
                    {group.packages.map(pkg => <PackageCard key={pkg.id} pkg={pkg} />)}
                  </div>
                );
              });
            })()}
            
            {/* Expand/Collapse Button */}
            {historyPackages.length > 5 && (
              <Button
                variant="outline"
                className="w-full text-zinc-600 dark:text-zinc-300 dark:border-zinc-600 dark:hover:bg-zinc-700"
                onClick={() => setHistoryExpanded(!historyExpanded)}
              >
                {historyExpanded ? (
                  <>
                    <ChevronUp className="w-4 h-4 mr-2" />
                    {t('Show Less')}
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-4 h-4 mr-2" />
                    {t('View All History')} ({historyPackages.length - 5} {t('more packages')})
                  </>
                )}
              </Button>
            )}
          </div>
        )}
      </WindowBox>

      <Dialog open={!!selectedPackage} onOpenChange={() => setSelectedPackage(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('Package Details')}</DialogTitle>
          </DialogHeader>
          {selectedPackage && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-zinc-500">{t('Recipient')}</p>
                  <p className="font-semibold">{selectedPackage.recipient_name}</p>
                </div>
                <div>
                  <p className="text-zinc-500">{t('Delivered on')}</p>
                  <p className="font-semibold">{format(new Date(selectedPackage.created_date), 'MMM d, h:mm a')}</p>
                </div>
                {selectedPackage.status === 'picked_up' && selectedPackage.picked_up_at && (
                  <div>
                    <p className="text-zinc-500">Picked Up</p>
                    <p className="font-semibold">{format(new Date(selectedPackage.picked_up_at), 'MMM d, h:mm a')}</p>
                  </div>
                )}
                {selectedPackage.status === 'collected' && selectedPackage.collected_at && (
                  <div>
                    <p className="text-zinc-500">Collected</p>
                    <p className="font-semibold">{format(new Date(selectedPackage.collected_at), 'MMM d, h:mm a')}</p>
                  </div>
                )}
                {selectedPackage.notes && (
                  <div className="col-span-2">
                    <p className="text-zinc-500">{t('Notes')}</p>
                    <p className="font-semibold">{selectedPackage.notes}</p>
                  </div>
                )}
              </div>
              
              <div>
                <p className="text-zinc-500 mb-2">Package Photo{selectedPackage.packagePhotoUrls?.length > 1 ? 's' : ''}</p>
                {selectedPackage.packagePhotoUrls && selectedPackage.packagePhotoUrls.length > 0 ? (
                  <div className="grid grid-cols-2 gap-2">
                    {selectedPackage.packagePhotoUrls.map((url, idx) => (
                      <button
                        key={idx}
                        onClick={() => {
                          setPhotoViewerPhotos(selectedPackage.packagePhotoUrls);
                          setPhotoViewerIndex(idx);
                        }}
                        className="relative group block"
                      >
                        <img 
                          src={url} 
                          alt={`Package photo ${idx + 1}`}
                          loading="lazy"
                          className="w-full h-48 object-cover rounded-lg border border-zinc-200 group-hover:border-blue-400 transition-colors"
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 rounded-lg flex items-center justify-center transition-colors">
                          <ZoomIn className="w-8 h-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-zinc-400 italic">{t('No photo provided')}</p>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Photo Viewer */}
      {photoViewerPhotos && (
        <PhotoViewer
          photos={photoViewerPhotos}
          initialIndex={photoViewerIndex}
          onClose={() => setPhotoViewerPhotos(null)}
        />
      )}

      {/* Success Animation */}
      <AnimatePresence>
        {showSuccessAnimation && (
          <div className="fixed inset-0 z-50 flex items-start justify-center pt-32 md:pt-40 pointer-events-none">
            <motion.div
              initial={{ y: -100, opacity: 0, scale: 0.8 }}
              animate={{ 
                y: 0, 
                opacity: 1, 
                scale: 1,
              }}
              exit={{ y: 100, opacity: 0, scale: 0.8 }}
              transition={{
                type: "spring",
                damping: 12,
                stiffness: 200,
                duration: 0.6
              }}
              className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl p-8 flex flex-col items-center gap-4"
            >
              <motion.div
                animate={{ 
                  rotate: [0, -10, 10, -5, 5, 0],
                }}
                transition={{
                  delay: 0.3,
                  duration: 0.5
                }}
              >
                <div className="w-20 h-20 bg-green-100 rounded-2xl flex items-center justify-center">
                  <Package className="w-10 h-10 text-green-600" />
                </div>
              </motion.div>
              <motion.p
                initial={{ opacity: 0, y: 10, scale: 0.9 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ 
                  delay: 0.4,
                  type: "spring",
                  damping: 10,
                  stiffness: 200
                }}
                className="text-5xl md:text-6xl font-bold text-zinc-900 dark:text-zinc-100"
              >
                {t('Enjoy!')}
              </motion.p>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
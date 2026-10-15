import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Gamepad2, Clock, ArrowRight, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { useLanguage } from '@/lib/LanguageContext';

const items = [
  { id: 'ping-pong', name: 'Ping Pong', image: 'https://images.unsplash.com/photo-1534158914592-062992fbe900?auto=format&fit=crop&q=80&w=800' },
  { id: 'pool-cues', name: 'Pool Cues', image: 'https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/6931cd960917c204b2b4808b/3b3fd9728_thumb-1920-437610.jpg' },
  { id: 'both', name: 'Ping Pong & Pool Cues', image: 'https://images.unsplash.com/photo-1596443686812-2f45229eeb36?q=80&w=2070&auto=format&fit=crop' }
];

export default function Gameroom() {
  const { t } = useLanguage();
  const [selectedItem, setSelectedItem] = useState(null);
  const [activeRental, setActiveRental] = useState(null);
  const [showRentalDialog, setShowRentalDialog] = useState(false);
  const queryClient = useQueryClient();
  
  const { data: user } = useQuery({
    queryKey: ['me'],
    queryFn: () => base44.auth.me()
  });

  const { data: myRentals, refetch } = useQuery({
      queryKey: ['my-rentals', user?.email],
      queryFn: async () => {
          const all = await base44.entities.GameroomRental.list('-created_date', 50);
          return all.filter(r => 
              ['requested', 'approved', 'active'].includes(r.status) && 
              r.created_by === user?.email
          );
      },
    enabled: !!user?.email,
    refetchInterval: 2000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    placeholderData: []
  });

  // Fetch ALL active rentals to check availability
  const { data: allActiveRentals } = useQuery({
    queryKey: ['all-active-rentals'],
    queryFn: async () => {
        const all = await base44.entities.GameroomRental.list('-created_date', 100);
        return all.filter(r => ['requested', 'accepted', 'active'].includes(r.status));
    },
    refetchInterval: 5000, // Auto-refresh every 5 seconds
    placeholderData: []
  });

  useEffect(() => {
    if (myRentals && myRentals.length > 0) {
        setActiveRental(myRentals[0]);
    } else {
        setActiveRental(null);
        setShowRentalDialog(false);
    }
  }, [myRentals]);

  const requestMutation = useMutation({
      mutationFn: async (itemName) => {
          // Backend validation: check if item is available
          const activeRentals = await base44.entities.GameroomRental.list('-created_date', 100);
          const conflicts = activeRentals.filter(r => ['requested', 'accepted', 'active'].includes(r.status));
          
          // Check availability based on dependency rules
          if (itemName === 'Pool Cues') {
              const blocked = conflicts.some(r => r.item_name === 'Pool Cues' || r.item_name === 'Ping Pong & Pool Cues');
              if (blocked) throw new Error('Pool Cues is currently rented');
          } else if (itemName === 'Ping Pong') {
              const blocked = conflicts.some(r => r.item_name === 'Ping Pong' || r.item_name === 'Ping Pong & Pool Cues');
              if (blocked) throw new Error('Ping Pong is currently rented');
          } else if (itemName === 'Ping Pong & Pool Cues') {
              const blocked = conflicts.some(r => 
                r.item_name === 'Pool Cues' || 
                r.item_name === 'Ping Pong' || 
                r.item_name === 'Ping Pong & Pool Cues'
              );
              if (blocked) throw new Error('Equipment is currently rented');
          }

          // Fetch Profile to get accurate name and unit
          const profiles = await base44.entities.Profile.filter({ userId: user.id });
          const residentName = profiles.length > 0 ? profiles[0].full_name : user.full_name;
          const residentUnit = profiles.length > 0 ? profiles[0].unit_number : user.unit_number;
          const tower = residentUnit?.toString().startsWith('1') ? 'E' : 'W';

          const rental = await base44.entities.GameroomRental.create({
              item_name: itemName,
              resident_name: residentName,
              resident_unit: residentUnit,
              resident_tower: tower,
              status: 'requested',
              start_time: new Date().toISOString()
          });

          // Notify ALL security staff
          const users = await base44.entities.User.list();
          const securityStaff = users.filter(u => 
            (u.management_role === 'security' || u.app_role === 'security') && u.email
          );

          // Create in-app notification for each security user (one per user for per-user read tracking)
          for (const securityUser of securityStaff) {
            await base44.entities.Notification.create({
                title: 'Gameroom Rental Request',
                message: `${residentName} (Unit ${residentUnit}) requested ${itemName}`,
                type: 'amenity',
                target_role: 'security',
                target_user_id: securityUser.id,
                link: 'SecurityGameroom',
                related_entity_id: rental.id,
                is_read: false
            });
          }

          return rental;
      },
    onSuccess: (newRental) => {
        toast.success("Rental requested! Please go to front desk.");
        setSelectedItem(null);
        queryClient.setQueryData(['my-rentals'], (old) => old ? [newRental, ...old] : [newRental]);
        queryClient.invalidateQueries(['all-active-rentals']);
        setActiveRental(newRental);
        setShowRentalDialog(true);
    },
    onError: (error) => {
        toast.error(error.message || 'Item not available');
        setSelectedItem(null);
    }
  });

  const startRentalMutation = useMutation({
    mutationFn: (id) => base44.entities.GameroomRental.update(id, { status: 'active' }),
    onSuccess: () => {
        toast.success("Rental started!");
        refetch();
    }
  });



  const cancelRequestMutation = useMutation({
    mutationFn: async (id) => {
        try {
            await base44.entities.GameroomRental.update(id, { status: 'denied' });
        } catch (error) {
            console.error('Cancel failed:', error);
            throw error;
        }
    },
    onSuccess: () => {
        toast.success("Request cancelled");
        setActiveRental(null);
        setShowRentalDialog(false);
        queryClient.setQueryData(['my-rentals', user?.email], (old) => 
            old ? old.filter(r => r.id !== activeRental?.id) : []
        );
        refetch();
    },
    onError: (error) => {
        toast.error(error.message || "Failed to cancel request");
    }
  });

  // Active rental view is now handled by the Dialog in the main return

  // Check item availability based on dependency rules
  const checkAvailability = (itemName) => {
    if (!allActiveRentals) return true;
    
    if (itemName === 'Pool Cues') {
      return !allActiveRentals.some(r => r.item_name === 'Pool Cues' || r.item_name === 'Ping Pong & Pool Cues');
    } else if (itemName === 'Ping Pong') {
      return !allActiveRentals.some(r => r.item_name === 'Ping Pong' || r.item_name === 'Ping Pong & Pool Cues');
    } else if (itemName === 'Ping Pong & Pool Cues') {
      return !allActiveRentals.some(r => 
        r.item_name === 'Pool Cues' || 
        r.item_name === 'Ping Pong' || 
        r.item_name === 'Ping Pong & Pool Cues'
      );
    }
    return true;
  };

  // Check if current user is renting this item
  const isCurrentUserRenting = (itemName) => {
    if (!allActiveRentals || !user?.email) return false;
    
    return allActiveRentals.some(r => {
      const matchesItem = 
        (itemName === 'Pool Cues' && (r.item_name === 'Pool Cues' || r.item_name === 'Ping Pong & Pool Cues')) ||
        (itemName === 'Ping Pong' && (r.item_name === 'Ping Pong' || r.item_name === 'Ping Pong & Pool Cues')) ||
        (itemName === 'Ping Pong & Pool Cues' && (r.item_name === 'Pool Cues' || r.item_name === 'Ping Pong' || r.item_name === 'Ping Pong & Pool Cues'));
      
      return matchesItem && r.created_by === user.email;
    });
  };

  const handleBorrowClick = (item) => {
      if (activeRental && ['requested', 'approved', 'active'].includes(activeRental.status)) {
          toast.info("You already have an active rental");
          setShowRentalDialog(true);
          return;
      }
      
      if (!checkAvailability(item.name)) {
          toast.error("Not available — item is currently rented");
          return;
      }
      
      setSelectedItem(item);
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-4 mb-8">
          <div className="w-16 h-16 bg-amber-500 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-amber-500/20">
              <Gamepad2 className="w-8 h-8" />
          </div>
          <div>
              <h1 className="text-4xl font-bold tracking-tight text-zinc-900">{t('Gameroom')}</h1>
              <p className="text-zinc-500">{t('Equipment rentals & fun')}</p>
          </div>
      </div>

      {activeRental && ['requested', 'approved', 'active'].includes(activeRental.status) && (
          <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-gradient-to-r from-amber-500 to-orange-500 rounded-2xl p-6 text-white shadow-2xl cursor-pointer"
              onClick={() => setShowRentalDialog(true)}
          >
              <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center">
                          <Clock className="w-6 h-6" />
                      </div>
                      <div>
                          <h3 className="text-xl font-bold">{activeRental.item_name}</h3>
                          <p className="text-white/80 text-sm">
                              {activeRental.status === 'requested' && t('Waiting for approval')}
                              {activeRental.status === 'approved' && t('Ready to pick up')}
                              {activeRental.status === 'active' && t('Rental in progress')}
                          </p>
                      </div>
                  </div>
                  <Button variant="ghost" className="text-white hover:bg-white/20 text-lg font-semibold">
                      {t('View Details →')}
                  </Button>
              </div>
          </motion.div>
      )}

      <div className="grid md:grid-cols-2 gap-8 h-[70vh]">
        {items.map((item) => {
            const isAvailable = checkAvailability(item.name);
            const isMyRental = isCurrentUserRenting(item.name);
            return (
            <motion.div 
                key={item.id}
                layoutId={item.id}
                onClick={() => handleBorrowClick(item)}
                className={`relative group rounded-3xl overflow-hidden h-full shadow-xl ${item.id === 'both' ? 'md:col-span-2' : ''} ${isAvailable ? 'cursor-pointer' : isMyRental ? 'cursor-pointer' : 'cursor-not-allowed opacity-75'}`}
                whileHover={isAvailable || isMyRental ? { scale: 1.02 } : {}}
                transition={{ duration: 0.4, ease: "easeOut" }}
            >
                <div className={`absolute inset-0 ${isAvailable ? 'bg-black/40 group-hover:bg-black/20' : isMyRental ? 'bg-black/40 group-hover:bg-black/20' : 'bg-black/60'} transition-colors z-10`} />
                {item.id === 'both' ? (
                    <div className="absolute inset-0 flex w-full h-full">
                         <img src={items[0].image} className="w-1/2 h-full object-cover transition-transform duration-700 group-hover:scale-110 origin-left" alt="Ping Pong" />
                         <img src={items[1].image} className="w-1/2 h-full object-cover transition-transform duration-700 group-hover:scale-110 origin-right" alt="Pool" />
                    </div>
                ) : (
                    <img src={item.image} className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" alt={item.name} />
                )}
                
                {!isAvailable && !isMyRental && (
                    <div className="absolute top-6 left-6 z-30">
                        <div className="bg-red-500 text-white px-4 py-2 rounded-full font-bold text-sm shadow-lg">
                            {t('Currently Rented')}
                        </div>
                    </div>
                )}

                {isMyRental && (
                    <div className="absolute top-6 left-6 z-30">
                        <div className="bg-amber-500 text-white px-4 py-2 rounded-full font-bold text-sm shadow-lg">
                            {t('YOUR ACTIVE RENTAL')}
                        </div>
                    </div>
                )}
                
                <div className="absolute bottom-0 left-0 right-0 p-8 z-20 bg-gradient-to-t from-black/80 to-transparent">
                    <h3 className="text-3xl font-bold text-white">{item.name}</h3>
                    {isAvailable ? (
                        <div className="flex items-center gap-2 text-white/80 mt-2 opacity-0 group-hover:opacity-100 transition-opacity translate-y-4 group-hover:translate-y-0">
                            <span>{t('Tap to borrow')}</span>
                            <ArrowRight className="w-4 h-4" />
                        </div>
                    ) : isMyRental ? (
                        <div className="text-amber-300 mt-2 text-sm font-bold">
                            {t('YOU ARE CURRENTLY RENTING THIS ITEM')}
                        </div>
                    ) : (
                        <div className="text-red-300 mt-2 text-sm font-medium">
                            {t('Not available — currently in use')}
                        </div>
                    )}
                </div>
            </motion.div>
        )})}
      </div>

      <AnimatePresence>
        {selectedItem && (
            <div 
                className="fixed inset-0 z-50 flex items-center justify-center p-4"
                onClick={() => setSelectedItem(null)}
            >
                <motion.div 
                    layoutId={selectedItem.id}
                    className="bg-white w-full max-w-md rounded-3xl overflow-hidden shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="h-64 relative flex">
                        {selectedItem.id === 'both' ? (
                            <>
                                <img src={items[0].image} className="w-1/2 h-full object-cover" alt="Ping Pong" />
                                <img src={items[1].image} className="w-1/2 h-full object-cover" alt="Pool" />
                            </>
                        ) : (
                            <img src={selectedItem.image} className="w-full h-full object-cover" alt={selectedItem.name} />
                            )}
                            <Button 
                                variant="ghost" 
                                size="icon" 
                                className="absolute top-4 right-4 bg-white hover:bg-zinc-100 text-zinc-900 rounded-full shadow-lg z-10"
                                onClick={() => setSelectedItem(null)}
                            >
                                <X className="w-5 h-5" />
                            </Button>
                            </div>
                    <div className="p-8 space-y-6">
                        <div>
                            <h2 className="text-2xl font-bold text-zinc-900">{selectedItem.name}</h2>
                            {checkAvailability(selectedItem.name) ? (
                                <p className="text-zinc-500">{t('Available for immediate rental.')}</p>
                            ) : (
                                <p className="text-red-500 font-medium">{t('Currently unavailable')}</p>
                            )}
                        </div>

                        <div className="bg-zinc-50 p-4 rounded-xl border border-zinc-100 text-sm space-y-2">
                            <div className="flex justify-between">
                                <span className="text-zinc-500">{t('Time Limit')}</span>
                                <span className="font-medium">{t('Until Closing')}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-zinc-500">{t('Return By')}</span>
                                <span className="font-medium text-red-500">11:00 PM</span>
                            </div>
                        </div>

                        <div className="flex gap-3">
                            <Button 
                                variant="outline"
                                className="flex-1 h-12 text-lg"
                                onClick={() => setSelectedItem(null)}
                            >
                                {t('Cancel')}
                            </Button>
                            <Button 
                                className="flex-1 h-12 text-lg bg-zinc-900 hover:bg-zinc-800 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                                onClick={() => requestMutation.mutate(selectedItem.name)}
                                disabled={requestMutation.isPending || !checkAvailability(selectedItem.name)}
                            >
                                {requestMutation.isPending ? (
                                    <span className="flex items-center gap-2">
                                        <span className="animate-spin">⏳</span> {t('Requesting...')}
                                    </span>
                                ) : checkAvailability(selectedItem.name) ? t('Borrow Item') : t('Not Available')}
                            </Button>
                        </div>
                        </div>
                </motion.div>
            </div>
        )}
      </AnimatePresence>



      <Dialog open={showRentalDialog && !!activeRental} onOpenChange={(open) => {
          if (!open) {
              setShowRentalDialog(false);
          }
      }}>
        <DialogContent className="bg-zinc-900 text-white border-zinc-800 sm:max-w-md">
            {activeRental ? (
                <>
                    <DialogHeader>
                        <DialogTitle className="text-center">{activeRental.item_name}</DialogTitle>
                        <DialogDescription className="text-center text-zinc-400">
                            <BadgeStatus status={activeRental.status} />
                        </DialogDescription>
                    </DialogHeader>
                    
                    <div className="py-6">
                 {activeRental?.status === 'requested' && (
                    <div className="space-y-6 text-center">
                        <p className="text-zinc-400">{t('Please proceed to the front desk.')}</p>
                        <div className="flex flex-col items-center justify-center gap-2">
                            <div className="text-5xl font-mono font-bold text-amber-500 tabular-nums">
                                <CountdownTimer startTime={activeRental.start_time} />
                            </div>
                            <div className="flex items-center gap-2 text-xs text-zinc-500 uppercase tracking-wider">
                            <Clock className="w-3 h-3" /> {t('Expires in 10m')}
                            </div>
                        </div>
                         <div className="p-4 bg-zinc-800/50 rounded-lg text-sm text-zinc-400">
                             {t('Show this screen to security to pick up your item.')}
                         </div>
                        <Button 
                            variant="outline"
                            className="w-full text-red-400 border-red-400 hover:bg-red-950"
                            onClick={() => {
                                if (activeRental?.id) {
                                    cancelRequestMutation.mutate(activeRental.id);
                                }
                            }}
                            disabled={cancelRequestMutation.isPending || !activeRental?.id}
                        >
                            {cancelRequestMutation.isPending ? t('Cancelling...') : t('Cancel Request')}
                        </Button>
                    </div>
                )}

                {activeRental?.status === 'approved' && (
                    <div className="space-y-4 text-center">
                        <div className="w-16 h-16 bg-green-500/10 text-green-500 rounded-full flex items-center justify-center mx-auto">
                            <Check className="w-8 h-8" />
                        </div>
                        <p className="text-green-400 font-medium">{t('Approved! Pick it up now.')}</p>
                        <Button 
                           className="w-full bg-white text-black hover:bg-zinc-200 font-bold"
                           onClick={() => startRentalMutation.mutate(activeRental.id)}
                        >
                           {t('Start Timer')}
                        </Button>
                    </div>
                )}

                {activeRental?.status === 'active' && (
                   <div className="space-y-6 text-center">
                        <div className="text-6xl font-mono font-light tracking-widest tabular-nums text-amber-500">
                           <LiveTimer startTime={activeRental.start_time} />
                        </div>
                        <p className="text-sm text-zinc-500">{t('Rental in progress')}</p>
                        <div className="bg-zinc-800/50 rounded-lg p-4 text-sm text-zinc-400">
                           {t('Return the item to the front desk when done. Security will process your return.')}
                        </div>
                   </div>
                )}
                    </div>
                </>
            ) : (
                <div className="p-6 text-center text-zinc-400">
                    {t('No active rental')}
                </div>
            )}
        </DialogContent>
      </Dialog>

      </div>
      );
      }

function BadgeStatus({ status }) {
    const styles = {
        requested: "bg-amber-100 text-amber-800 border-amber-200",
        approved: "bg-green-100 text-green-800 border-green-200",
        active: "bg-blue-100 text-blue-800 border-blue-200 animate-pulse",
        return_pending: "bg-purple-100 text-purple-800 border-purple-200",
        returned: "bg-zinc-100 text-zinc-800 border-zinc-200",
    };
    return (
        <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider border ${styles[status] || styles.requested}`}>
            {status.replace('_', ' ')}
        </span>
    );
}

function LiveTimer({ startTime }) {
    const [elapsed, setElapsed] = useState('00:00');
    
    useEffect(() => {
        const interval = setInterval(() => {
            if (!startTime) return;
            const start = new Date(startTime);
            const now = new Date();
            const diff = Math.floor((now - start) / 1000);
            
            const m = Math.floor(diff / 60).toString().padStart(2, '0');
            const s = (diff % 60).toString().padStart(2, '0');
            setElapsed(`${m}:${s}`);
        }, 1000);
        return () => clearInterval(interval);
    }, [startTime]);

    return elapsed;
}

function CountdownTimer({ startTime }) {
    const calculateRemaining = () => {
        if (!startTime) return '10:00';
        const start = new Date(startTime);
        const expire = new Date(start.getTime() + 10 * 60 * 1000);
        const now = new Date();
        const diff = Math.floor((expire - now) / 1000);
        
        if (diff <= 0) return 'EXPIRED';
        
        const m = Math.floor(diff / 60).toString().padStart(2, '0');
        const s = (diff % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    };

    const [remaining, setRemaining] = useState(calculateRemaining());
    
    useEffect(() => {
        const interval = setInterval(() => {
            setRemaining(calculateRemaining());
        }, 1000);
        return () => clearInterval(interval);
    }, [startTime]);

    return remaining;
}
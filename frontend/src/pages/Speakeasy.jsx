import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Calendar } from "@/components/ui/calendar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Wine, Clock, Calendar as CalendarIcon, Check, Archive, Camera } from 'lucide-react';
import { format, addDays, isSameDay } from 'date-fns';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { motion, AnimatePresence } from "framer-motion";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import VirtualTour from '@/components/speakeasy/VirtualTour';
import { ChevronDown } from 'lucide-react';
import { useLanguage } from '@/lib/LanguageContext';

function VirtualTourCollapsible() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white/80 dark:bg-zinc-800/80 backdrop-blur-sm rounded-2xl border border-purple-100 dark:border-zinc-700 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-purple-50/60 dark:hover:bg-zinc-700/60 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-purple-100 dark:bg-purple-900/40 rounded-lg flex items-center justify-center">
            <Camera className="w-4 h-4 text-purple-700 dark:text-purple-400" />
          </div>
          <div className="text-left">
            <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100 leading-none">{t('Virtual Tour')}</p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">{t('Preview each space before booking')}</p>
          </div>
        </div>
        <motion.div animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.25 }}>
          <ChevronDown className="w-5 h-5 text-zinc-400" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="tour-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div className="px-6 pb-6">
              <VirtualTour hideHeader />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const ROOMS = [
  "Speakeasy", 
  "TV Room (2nd floor)", 
  "Dining room with TV (2nd floor)", 
  "Living and Dining Room (3rd floor)"
];
const CLOSING_HOUR = 23; // All reservations must end by 23:00
const TIMES = [
  "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", 
  "15:00", "16:00", "17:00", "18:00", "19:00", "20:00",
  "21:00", "22:00"
];

export default function Speakeasy() {
  const { t } = useLanguage();
  const [date, setDate] = useState(new Date());
  const [room, setRoom] = useState(ROOMS[0]);
  const [startTime, setStartTime] = useState("");
  const [duration, setDuration] = useState("2"); // hours
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const queryClient = useQueryClient();

  const { data: user } = useQuery({ queryKey: ['me'], queryFn: () => base44.auth.me() });

  // Fetch existing reservations for selected date and room
  const { data: reservations } = useQuery({
    queryKey: ['reservations', date, room],
    queryFn: async () => {
      const allReservations = await base44.entities.SpeakeasyReservation.list();
      return allReservations.filter(r => 
        r.room_type === room && 
        r.date === format(date, 'yyyy-MM-dd') &&
        (r.status === 'pending' || r.status === 'approved' || r.status === 'paid' || r.status === 'active')
      );
    }
  });

  // A start time is only blocked if starting there would immediately overlap an existing reservation
  // i.e. there's an existing booking whose window covers this exact start time
  const isTimeReserved = (time) => {
    if (!reservations) return false;
    const timeHour = parseInt(time.split(':')[0]);
    return reservations.some(res => {
      const resStartHour = parseInt(res.start_time.split(':')[0]);
      const resEndHour = parseInt(res.end_time.split(':')[0]);
      // Block only if timeHour falls strictly inside an existing booking
      return timeHour >= resStartHour && timeHour < resEndHour;
    });
  };

  // Check if a duration would cause overlap with existing reservations or exceed closing time
  const isDurationInvalid = (durationHours) => {
    if (!startTime) return false;
    const startHour = parseInt(startTime.split(':')[0]);
    const endHour = startHour + parseInt(durationHours);
    // Block if it exceeds closing time
    if (endHour > CLOSING_HOUR) return true;
    if (!reservations) return false;
    return reservations.some(res => {
      const resStartHour = parseInt(res.start_time.split(':')[0]);
      const resEndHour = parseInt(res.end_time.split(':')[0]);
      return startHour < resEndHour && endHour > resStartHour;
    });
  };

  // When start time changes, reset duration if the current selection becomes invalid
  const handleStartTimeChange = (newTime) => {
    setStartTime(newTime);
    const startHour = parseInt(newTime.split(':')[0]);
    const currentDur = parseInt(duration);
    const maxAllowed = Math.min(4, CLOSING_HOUR - startHour);
    if (currentDur > maxAllowed) {
      setDuration(maxAllowed > 0 ? maxAllowed.toString() : "1");
    }
  };

  const bookMutation = useMutation({
    mutationFn: async () => {
        // Fetch Profile to get accurate name and unit
        const profiles = await base44.entities.Profile.filter({ userId: user.id });
        const residentName = profiles.length > 0 ? profiles[0].full_name : user.full_name;
        const residentUnit = profiles.length > 0 ? profiles[0].unit_number : user.unit_number;
        
        const res = await base44.entities.SpeakeasyReservation.create({
            room_type: room,
            date: format(date, 'yyyy-MM-dd'),
            start_time: startTime,
            end_time: `${parseInt(startTime.split(':')[0]) + parseInt(duration)}:00`,
            status: 'pending',
            payment_status: 'unpaid',
            resident_user_id: user.id,
            resident_name: residentName,
            resident_unit: residentUnit
        });
        
        // Notify all property management users
        const allUsers = await base44.entities.User.list();
        const managementUsers = allUsers.filter(u => u.management_role === 'property_management');
        
        for (const mgmt of managementUsers) {
            await base44.entities.Notification.create({
                title: 'New Speakeasy Reservation',
                message: `${residentName} (Unit ${residentUnit}) requested ${room} on ${format(date, 'MMM d')}`,
                type: 'amenity',
                target_user_id: mgmt.id,
                link: 'ManagementSpeakeasy'
            });
        }
        
        // Confirm to resident - use target_user_id for personal notifications
        await base44.entities.Notification.create({
            title: 'Reservation Submitted',
            message: `Your ${room} reservation for ${format(date, 'MMM d')} at ${startTime} is pending approval.`,
            type: 'amenity',
            target_user_id: user.id,
            link: 'Speakeasy'
        });
        
        return res;
    },
    onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['my-reservations'] });
        setShowConfirmModal(true);
        setStartTime("");
    }
  });

  return (
    <div className="space-y-8">
        <div className="flex items-center gap-4 mb-8">
            <div className="w-16 h-16 bg-purple-900 rounded-2xl flex items-center justify-center text-purple-200 shadow-lg shadow-purple-900/20">
                <Wine className="w-8 h-8" />
            </div>
            <div>
                <h1 className="text-4xl font-bold tracking-tight text-zinc-900 dark:text-zinc-900">{t('The Speakeasy')}</h1>
                <p className="text-zinc-500 dark:text-zinc-400">{t('Exclusive amenity reservations')}</p>
            </div>
        </div>

        {/* Virtual Tour - collapsible */}
        <VirtualTourCollapsible />

        <div className="grid md:grid-cols-2 gap-8">
            {/* Booking Form */}
            <motion.div
              whileHover={{ scale: 1.02, boxShadow: "0 0 25px rgba(88, 28, 135, 0.15)" }}
              transition={{ type: "spring", stiffness: 300 }}
            >
            <Card className="border-zinc-200 dark:border-zinc-700 dark:bg-zinc-800 shadow-xl h-fit">
                <CardContent className="p-8 space-y-6">
                    <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 border-b dark:border-zinc-700 pb-4">{t('New Reservation')}</h2>
                    
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <label className="text-sm font-medium">{t('Select Room')}</label>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {ROOMS.map(r => (
                                    <button
                                        key={r}
                                        onClick={() => setRoom(r)}
                                        className={cn(
                                            "px-2 py-3 rounded-lg text-sm font-medium border transition-all",
                                            room === r ? "bg-purple-50 dark:bg-purple-900/40 border-purple-500 text-purple-700 dark:text-purple-300" : "hover:bg-zinc-50 dark:hover:bg-zinc-700 border-zinc-200 dark:border-zinc-600 text-zinc-900 dark:text-zinc-300"
                                        )}
                                    >
                                        {r}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-medium">{t('Date')}</label>
                            <Popover>
                                <PopoverTrigger asChild>
                                    <Button variant="outline" className="w-full justify-start text-left font-normal">
                                        <CalendarIcon className="mr-2 h-4 w-4" />
                                        {date ? format(date, "PPP") : <span>{t('Pick a date')}</span>}
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-auto p-0">
                                    <Calendar
                                        mode="single"
                                        selected={date}
                                        onSelect={setDate}
                                        initialFocus
                                        disabled={(date) => {
                                            const today = new Date();
                                            today.setHours(0, 0, 0, 0);
                                            return date < today;
                                        }}
                                    />
                                </PopoverContent>
                            </Popover>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                             <div className="space-y-2">
                                <label className="text-sm font-medium">{t('Start Time')}</label>
                                <Select value={startTime} onValueChange={handleStartTimeChange}>
                                    <SelectTrigger>
                                        <SelectValue placeholder={t('Select time')} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {TIMES.map(time => {
                                           const reserved = isTimeReserved(time);
                                           return (
                                             <SelectItem 
                                               key={time} 
                                               value={time}
                                               disabled={reserved}
                                               className={reserved ? 'opacity-40 cursor-not-allowed line-through' : ''}
                                             >
                                               {time}{reserved ? ` (${t('Reserved')})` : ''}
                                             </SelectItem>
                                           );
                                        })}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2">
                                <label className="text-sm font-medium">{t('Duration')}</label>
                                <Select value={duration} onValueChange={setDuration}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Hours" />
                                    </SelectTrigger>
                                    <SelectContent>
                                       {[1, 2, 3, 4].filter(hours => !isDurationInvalid(hours)).map(hours => (
                                         <SelectItem key={hours} value={hours.toString()}>
                                           {hours} {hours === 1 ? t('Hour') : t('Hours')}
                                         </SelectItem>
                                       ))}
                                       {!startTime && (
                                         <SelectItem value="__placeholder__" disabled className="opacity-40 italic">
                                           Select a start time first
                                         </SelectItem>
                                       )}
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <Button 
                            className="w-full bg-purple-900 hover:bg-purple-800 h-12 mt-4" 
                            onClick={() => {
                              const startHour = parseInt(startTime.split(':')[0]);
                              const endHour = startHour + parseInt(duration);
                              if (endHour > CLOSING_HOUR) {
                                toast.error('Reservations cannot extend past 23:00.');
                                return;
                              }
                              bookMutation.mutate();
                            }}
                            disabled={!startTime || bookMutation.isPending}
                        >
                            {bookMutation.isPending ? t('Submitting...') : t('Request Reservation')}
                        </Button>
                         <p className="text-xs text-center text-zinc-400 dark:text-zinc-500">{t('Payment required upon approval.')}</p>
                        </div>
                        </CardContent>
                        </Card>
                        </motion.div>

            {/* Info / My Reservations */}
            <div className="space-y-6">
                <motion.div
                  whileHover={{ scale: 1.02, boxShadow: "0 0 30px rgba(147, 51, 234, 0.3)" }}
                  transition={{ type: "spring", stiffness: 300 }}
                >
                <Card className="bg-zinc-900 text-zinc-200 border-none shadow-2xl overflow-hidden">
                    <div className="absolute top-0 right-0 w-64 h-64 bg-purple-600/20 blur-3xl rounded-full -mr-16 -mt-16 pointer-events-none" />
                    <CardContent className="p-8 relative">
                        <h3 className="text-xl font-semibold text-white mb-4">{t('House Rules')}</h3>
                        <ul className="space-y-3 text-sm text-zinc-400">
                            <li className="flex gap-2 items-start"><Check className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" /> <span>{t('Strict 11:00 PM curfew (Residential floors)')}</span></li>
                            <li className="flex gap-2 items-start"><Check className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" /> <span>{t('No smoking/vaping ($1000 fine)')}</span></li>
                            <li className="flex gap-2 items-start"><Check className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" /> <span>{t('Guests restricted to room ($250 fine for roaming)')}</span></li>
                            <li className="flex gap-2 items-start"><Check className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" /> <span>{t('Cleaning required before return')}</span></li>
                            <li className="flex gap-2 items-start"><Check className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" /> <span>{t('No loud music or DJ allowed')}</span></li>
                            <li className="flex gap-2 items-start"><Check className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" /> <span>{t('Pre-inspection & Debit deposit required')}</span></li>
                            <li className="flex gap-2 items-start"><Check className="w-4 h-4 text-purple-400 mt-0.5 shrink-0" /> <span>{t('Max 4 hours (extra $50/hr)')}</span></li>
                            </ul>
                            </CardContent>
                            </Card>
                            </motion.div>

                <MyReservations user={user} />
            </div>
        </div>

        <Dialog open={showConfirmModal} onOpenChange={setShowConfirmModal}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="text-center">✅ {t('Reservation Submitted')}</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 pt-4">
                    <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                        <p className="text-sm text-purple-900 font-medium text-center">
                            {t('Please visit the front desk to complete payment and get your reservation approved.')}
                        </p>
                    </div>
                    <p className="text-xs text-zinc-500 text-center">
                        {t('To modify or cancel this request, speak with the front desk.')}
                    </p>
                    <Button onClick={() => setShowConfirmModal(false)} className="w-full bg-purple-900 hover:bg-purple-800">
                        {t('Got it')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    </div>
  );
}

function MyReservations({ user }) {
    const { t } = useLanguage();
    const [showArchived, setShowArchived] = useState(false);
    const queryClient = useQueryClient();

    const { data: myRes } = useQuery({
        queryKey: ['my-reservations', user?.id],
        queryFn: () => base44.entities.SpeakeasyReservation.filter({
            resident_user_id: user?.id
        }, '-created_date', 50),
        enabled: !!user?.id
    });

    const archiveMutation = useMutation({
        mutationFn: (resId) => base44.entities.SpeakeasyReservation.update(resId, { archived: true }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['my-reservations'] });
            toast.success('Reservation archived');
        }
    });

    const activeReservations = myRes?.filter(r => !r.archived) || [];
    const archivedReservations = myRes?.filter(r => r.archived) || [];
    const displayReservations = showArchived ? archivedReservations : activeReservations;

    return (
        <motion.div
          whileHover={{ scale: 1.02, boxShadow: "0 0 25px rgba(88, 28, 135, 0.15)" }}
          transition={{ type: "spring", stiffness: 300 }}
        >
        <Card className="border-zinc-200 dark:border-zinc-700 dark:bg-zinc-800 shadow-xl overflow-hidden">
            <CardContent className="p-4">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{t('Your Reservations')}</h3>
                    <Button 
                        variant="ghost" 
                        size="sm"
                        onClick={() => setShowArchived(!showArchived)}
                        className="text-xs"
                    >
                        {showArchived ? t('Show Active') : `${t('Archived')} (${archivedReservations.length})`}
                    </Button>
                </div>

                <div className="space-y-3 max-h-[240px] overflow-y-auto pr-2">
                  {!displayReservations.length && (
                      <div className="text-center py-6 bg-zinc-50 dark:bg-zinc-700/50 rounded-lg border border-zinc-100 dark:border-zinc-700">
                          <p className="text-sm text-zinc-500 dark:text-zinc-400">
                              {showArchived ? t('No archived reservations.') : t('No upcoming reservations found.')}
                          </p>
                      </div>
                  )}

                  {displayReservations.map(res => (
                      <div key={res.id} className="flex justify-between items-center gap-2 p-3 rounded-lg bg-zinc-50 border border-zinc-100 hover:bg-zinc-100 transition-colors">
                          <div className="flex-1 min-w-0">
                              <p className="font-medium text-zinc-900 text-sm truncate">{res.room_type}</p>
                              <p className="text-xs text-zinc-500">{format(new Date(res.date + 'T12:00:00'), 'MMM d')} • {res.start_time}</p>
                          </div>
                          <Badge className={
                              res.status === 'approved' ? 'bg-green-100 text-green-800 border-green-200' : 
                              res.status === 'pending' ? 'bg-amber-100 text-amber-800 border-amber-200' : 
                              'bg-zinc-200 text-zinc-600 border-zinc-300'
                          }>
                              {res.status === 'pending' ? t('Pending reservation') : 
                               res.status === 'approved' ? t('Reservation approved') : 
                               res.status}
                          </Badge>
                          {!showArchived && (
                              <Button 
                                  variant="ghost" 
                                  size="icon"
                                  className="h-8 w-8 shrink-0"
                                  onClick={() => archiveMutation.mutate(res.id)}
                              >
                                  <Archive className="w-4 h-4 text-zinc-400" />
                              </Button>
                          )}
                      </div>
                  ))}
                </div>
                </CardContent>
                </Card>
                </motion.div>
                );
                }
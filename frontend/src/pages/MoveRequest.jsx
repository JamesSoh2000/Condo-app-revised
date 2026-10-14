import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Truck, Calendar, Clock, AlertCircle, CheckCircle2, XCircle, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { createPageUrl } from '@/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLanguage } from '@/lib/LanguageContext';

export default function MoveRequest() {
  const { t } = useLanguage();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [requestType, setRequestType] = useState('');
  const [purpose, setPurpose] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [notes, setNotes] = useState('');
  const [showMoveSentOverlay, setShowMoveSentOverlay] = useState(false);
  const [lastMoveRequestId, setLastMoveRequestId] = useState(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [clearAllConfirm, setClearAllConfirm] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    const loadUser = async () => {
      try {
        const currentUser = await base44.auth.me();
        
        // Redirect management users to SecurityMoveRequests
        if (currentUser.account_type === 'management') {
          navigate(createPageUrl('SecurityMoveRequests'));
          // Keep loading true during redirect
          return;
        }
        
        setUser(currentUser);
        setLoading(false);
      } catch (error) {
        console.error('Failed to load user:', error);
        setLoading(false);
      }
    };
    loadUser();
  }, [navigate]);

  const { data: myRequests, isLoading } = useQuery({
    queryKey: ['my-move-requests', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      return await base44.entities.MoveRequest.filter({ residentUserId: user.id }, '-created_date', 50);
    },
    enabled: !!user?.id
  });

  const createRequest = useMutation({
    mutationFn: async (data) => {
      // Fetch Profile to get accurate name and unit
      const profiles = await base44.entities.Profile.filter({ userId: user.id });
      const residentProfiles = await base44.entities.ResidentProfile.filter({ user_id: user.id });
      
      let residentName = user.full_name;
      let residentUnit = user.unit_number;
      
      if (profiles.length > 0) {
        residentName = profiles[0].full_name;
        residentUnit = profiles[0].unit_number;
      } else if (residentProfiles.length > 0) {
        residentName = residentProfiles[0].full_name;
        residentUnit = residentProfiles[0].unit_number;
      }
      
      const requestData = {
        ...data,
        residentName,
        unitNumber: residentUnit,
        tower: residentUnit?.toString().startsWith('1') ? 'E' : 'W'
      };
      
      const request = await base44.entities.MoveRequest.create(requestData);
      
      // Notify security
      await base44.entities.Notification.create({
        title: 'New Move Request',
        message: `${residentName} (Unit ${residentUnit}) requested ${data.requestType === 'move_in' ? 'Move In' : 'Move Out'} on ${format(new Date(data.date + 'T00:00:00'), 'MMM d, yyyy')}`,
        type: 'amenity',
        target_role: 'security',
        related_entity_id: request.id
      });

      // Notify property management
      await base44.entities.Notification.create({
        title: 'New Move Request',
        message: `${residentName} (Unit ${residentUnit}) requested ${data.requestType === 'move_in' ? 'Move In' : 'Move Out'} on ${format(new Date(data.date + 'T00:00:00'), 'MMM d, yyyy')}`,
        type: 'amenity',
        target_role: 'property_management',
        related_entity_id: request.id
      });

      return request;
    },
    onSuccess: (newRequest) => {
      console.log('✅ SUCCESS HANDLER FIRED - Move Request ID:', newRequest.id);
      toast.success(`Success handler fired for Move Request ID: ${newRequest.id}`);
      
      setLastMoveRequestId(newRequest.id);
      setShowMoveSentOverlay(true);
      
      setTimeout(() => {
        setShowMoveSentOverlay(false);
      }, 2000);
      
      queryClient.invalidateQueries({ queryKey: ['my-move-requests'] });
      setRequestType('');
      setPurpose('');
      setDate('');
      setStartTime('');
      setEndTime('');
      setNotes('');
    },
    onError: () => {
      toast.error('Failed to submit request');
    }
  });

  const deleteRequest = useMutation({
    mutationFn: async (requestId) => {
      await base44.entities.MoveRequest.delete(requestId);
    },
    onSuccess: () => {
      toast.success('Request deleted');
      queryClient.invalidateQueries({ queryKey: ['my-move-requests'] });
      setDeleteConfirm(null);
    },
    onError: () => {
      toast.error('Failed to delete request');
    }
  });

  const clearAllRequests = useMutation({
    mutationFn: async () => {
      if (!user?.id) return;
      const requests = await base44.entities.MoveRequest.filter({ residentUserId: user.id });
      await Promise.all(requests.map(r => base44.entities.MoveRequest.delete(r.id)));
    },
    onSuccess: () => {
      toast.success('All requests cleared');
      queryClient.invalidateQueries({ queryKey: ['my-move-requests'] });
      setClearAllConfirm(false);
    },
    onError: () => {
      toast.error('Failed to clear requests');
    }
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    
    if (!requestType || !purpose || !date || !startTime || !endTime) {
      toast.error('Please fill in all required fields');
      return;
    }

    // Validate move hours (08:00 - 22:00)
    const startHour = parseInt(startTime.split(':')[0]);
    const startMinute = parseInt(startTime.split(':')[1]);
    const endHour = parseInt(endTime.split(':')[0]);
    const endMinute = parseInt(endTime.split(':')[1]);
    
    if (startHour < 8 || startHour >= 22) {
      toast.error('Start time must be between 08:00 and 22:00');
      return;
    }
    
    if (endHour > 22 || (endHour === 22 && endMinute > 0)) {
      toast.error('End time must be 22:00 or earlier');
      return;
    }

    // Validate end time is after start time
    const start = new Date(`2000-01-01T${startTime}`);
    const end = new Date(`2000-01-01T${endTime}`);
    if (end <= start) {
      toast.error('End time must be after start time');
      return;
    }
    
    // Validate minimum 2-hour duration
    const durationMinutes = (end - start) / (1000 * 60);
    if (durationMinutes < 120) {
      toast.error('Moves must be at least 2 hours long');
      return;
    }

    createRequest.mutate({
      residentUserId: user.id,
      requestType,
      purpose,
      date,
      startTime,
      endTime,
      notes
    });
  };

  const getStatusBadge = (status) => {
    const config = {
      pending: { label: t('Pending'), className: 'bg-yellow-100 text-yellow-700', icon: Clock },
      approved: { label: t('Approved'), className: 'bg-green-100 text-green-700', icon: CheckCircle2 },
      declined: { label: t('Declined'), className: 'bg-red-100 text-red-700', icon: XCircle }
    };
    const statusConfig = config[status] || config.pending;
    const { label, className, icon: Icon } = statusConfig;
    return (
      <Badge className={className}>
        <Icon className="w-3 h-3 mr-1" />
        {label}
      </Badge>
    );
  };

  if (loading || !user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-zinc-200 border-t-zinc-900 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-zinc-500">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Truck animation overlay - viewport level */}
      <AnimatePresence>
        {showMoveSentOverlay && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              width: '100vw',
              height: '100vh',
              zIndex: 999999,
              pointerEvents: 'none',
              overflow: 'hidden'
            }}
          >
            {/* Truck with bounce and movement */}
            <motion.div
              initial={{ x: '60vw', y: 0 }}
              animate={{ 
                x: '-60vw',
                y: [0, -12, 0, -12, 0, -12, 0, -12, 0]
              }}
              transition={{ 
                x: { duration: 1.8, ease: 'linear' },
                y: { duration: 1.8, times: [0, 0.11, 0.22, 0.33, 0.44, 0.55, 0.66, 0.77, 1], ease: 'easeInOut' }
              }}
              className="relative"
              style={{ 
                position: 'absolute',
                top: '45%',
                fontSize: '140px',
                lineHeight: 1,
                transform: 'scaleX(-1)'
              }}
            >
              🚚
              
              {/* Smoke puffs */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0.6, 0] }}
                transition={{ duration: 0.4, repeat: 4, repeatDelay: 0.2 }}
                className="absolute"
                style={{ 
                  right: '-40px',
                  bottom: '10px',
                  fontSize: '50px',
                  transform: 'scaleX(-1)'
                }}
              >
                💨
              </motion.div>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0.5, 0] }}
                transition={{ duration: 0.4, delay: 0.15, repeat: 4, repeatDelay: 0.2 }}
                className="absolute"
                style={{ 
                  right: '-60px',
                  bottom: '20px',
                  fontSize: '40px',
                  transform: 'scaleX(-1)'
                }}
              >
                💨
              </motion.div>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0.4, 0] }}
                transition={{ duration: 0.4, delay: 0.3, repeat: 3, repeatDelay: 0.2 }}
                className="absolute"
                style={{ 
                  right: '-80px',
                  bottom: '30px',
                  fontSize: '32px',
                  transform: 'scaleX(-1)'
                }}
              >
                💨
              </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div>
        <h1 className="text-3xl font-bold">{t('Move In / Move Out')}</h1>
        <p className="text-zinc-500 mt-2">{t('Request elevator reservation for your move')}</p>
      </div>

      <div style={{ position: 'relative' }}>
        <Card>
          {/* Centered overlay for confirmation */}
          <AnimatePresence>
            {showMoveSentOverlay && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'rgba(255, 255, 255, 0.95)',
                  zIndex: 9999,
                  pointerEvents: 'none'
                }}
              >
                <motion.div
                  initial={{ scale: 0.8 }}
                  animate={{ scale: 1 }}
                  exit={{ scale: 0.8 }}
                  transition={{ duration: 0.4 }}
                  className="bg-white px-8 py-4 rounded-2xl shadow-2xl border-4 border-green-500"
                >
                  <p className="text-2xl font-bold text-zinc-900 mb-2">{t('Move request sent!')}</p>
                  <p className="text-sm text-zinc-500 text-center">ID: {lastMoveRequestId}</p>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          <CardHeader>
          <CardTitle className="flex items-center gap-2">
          <Truck className="w-5 h-5" />
          {t('Submit Move Request')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>{t('Request Type *')}</Label>
              <Select 
                value={requestType} 
                onValueChange={(value) => {
                  setRequestType(value);
                  // Reset purpose if it's no longer valid for the new request type
                  if (value === 'move_in' && purpose !== 'moving_in_furniture') {
                    setPurpose('');
                  } else if (value === 'move_out' && purpose === 'moving_in_furniture') {
                    setPurpose('');
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('Select move type')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="move_in">{t('Move In')}</SelectItem>
                  <SelectItem value="move_out">{t('Move Out')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {requestType && (
              <div className="space-y-3">
                <Label>{t('Purpose of move *')}</Label>
                <div className="space-y-2">
                  {requestType === 'move_in' ? (
                    <label className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-zinc-50 transition-colors">
                      <input
                        type="radio"
                        name="purpose"
                        value="moving_in_furniture"
                        checked={purpose === 'moving_in_furniture'}
                        onChange={(e) => setPurpose(e.target.value)}
                        className="w-4 h-4 text-zinc-900 cursor-pointer"
                      />
                      <span className="text-sm">{t('Moving in furniture')}</span>
                    </label>
                  ) : (
                    <>
                      <label className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-zinc-50 transition-colors">
                        <input
                          type="radio"
                          name="purpose"
                          value="moving_out_furniture"
                          checked={purpose === 'moving_out_furniture'}
                          onChange={(e) => setPurpose(e.target.value)}
                          className="w-4 h-4 text-zinc-900 cursor-pointer"
                        />
                        <span className="text-sm">{t('Moving out furniture')}</span>
                      </label>
                      <label className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-zinc-50 transition-colors">
                        <input
                          type="radio"
                          name="purpose"
                          value="moving_out_building"
                          checked={purpose === 'moving_out_building'}
                          onChange={(e) => setPurpose(e.target.value)}
                          className="w-4 h-4 text-zinc-900 cursor-pointer"
                        />
                        <span className="text-sm">{t('Moving out of the building (permanent move-out)')}</span>
                      </label>
                    </>
                  )}
                </div>
              </div>
            )}

            <div>
              <Label>{t('Date *')}</Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                min={new Date().toISOString().split('T')[0]}
              />
            </div>

            <div className="space-y-4">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-xs text-blue-800">
                  <strong>{t('Move Hours:')}</strong> 08:00–22:00 {t('only')} • <strong>{t('Minimum Duration:')}</strong> {t('2 hours')}
                </p>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>{t('Start Time *')}</Label>
                  <Select
                    value={startTime}
                    onValueChange={(value) => {
                      setStartTime(value);
                      
                      // Auto-fill end time to start + 2 hours
                      if (value) {
                        const [hours, minutes] = value.split(':').map(Number);
                        const startDate = new Date(2000, 0, 1, hours, minutes);
                        const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000);
                        const endHours = endDate.getHours();
                        const endMinutes = endDate.getMinutes();
                        
                        // Cap at 22:00
                        if (endHours > 22 || (endHours === 22 && endMinutes > 0)) {
                          setEndTime('22:00');
                        } else {
                          const endTimeStr = `${endHours.toString().padStart(2, '0')}:${endMinutes.toString().padStart(2, '0')}`;
                          setEndTime(endTimeStr);
                        }
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('Select start time')} />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px]">
                      {Array.from({ length: 28 }, (_, i) => {
                        const totalMinutes = 8 * 60 + i * 30; // Start at 08:00, 30-min intervals
                        const hours = Math.floor(totalMinutes / 60);
                        const minutes = totalMinutes % 60;
                        if (hours >= 22) return null; // Don't allow 22:00 or later for start
                        const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
                        return (
                          <SelectItem key={timeStr} value={timeStr}>
                            {timeStr}
                          </SelectItem>
                        );
                      }).filter(Boolean)}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-zinc-500 mt-1">{t('Between 08:00 and 21:30')}</p>
                </div>
                <div>
                  <Label>{t('End Time *')}</Label>
                  <Select
                    value={endTime}
                    onValueChange={setEndTime}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('Select end time')} />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px]">
                      {Array.from({ length: 29 }, (_, i) => {
                        const totalMinutes = 8 * 60 + i * 30; // Start at 08:00, 30-min intervals
                        const hours = Math.floor(totalMinutes / 60);
                        const minutes = totalMinutes % 60;
                        if (hours > 22 || (hours === 22 && minutes > 0)) return null; // Max 22:00
                        const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
                        
                        // Disable times that don't meet 2-hour minimum from start
                        let disabled = false;
                        if (startTime) {
                          const [startH, startM] = startTime.split(':').map(Number);
                          const startMinutes = startH * 60 + startM;
                          const endMinutes = hours * 60 + minutes;
                          disabled = (endMinutes - startMinutes) < 120;
                        }
                        
                        return (
                          <SelectItem key={timeStr} value={timeStr} disabled={disabled}>
                            {timeStr}
                          </SelectItem>
                        );
                      }).filter(Boolean)}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-zinc-500 mt-1">{t('Must be at least 2 hours after start')}</p>
                </div>
              </div>
            </div>

            <div>
              <Label>{t('Notes (Optional)')}</Label>
              <Textarea
                placeholder={t('Moving company name, truck size, special instructions, etc.')}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </div>

            <Button
              type="submit"
              disabled={createRequest.isPending}
              className="w-full"
            >
              {t('Submit Request')}
            </Button>
          </form>
        </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{t('My Move Requests')}</CardTitle>
            {myRequests && myRequests.length > 0 && (
              <div className="flex gap-2">
                {myRequests.length >= 3 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsExpanded(!isExpanded)}
                  >
                    {isExpanded ? (
                      <>
                        <ChevronUp className="w-4 h-4 mr-1" />
                        {t('Collapse')}
                      </>
                    ) : (
                      <>
                        <ChevronDown className="w-4 h-4 mr-1" />
                        {t('Show all')} ({myRequests.length})
                      </>
                    )}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setClearAllConfirm(true)}
                  className="text-red-600 hover:text-red-700"
                >
                  {t('Clear all')}
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-zinc-500 text-center py-8">{t('Loading...')}</p>
          ) : !myRequests || myRequests.length === 0 ? (
            <p className="text-zinc-400 text-center py-8">{t('No move requests yet')}</p>
          ) : (
            <div className={`space-y-3 ${isExpanded && myRequests.length >= 3 ? 'max-h-[600px] overflow-y-auto pr-2' : ''}`}>
              {(isExpanded || myRequests.length < 3 ? myRequests : myRequests.slice(0, 2)).map((request) => (
                <Card key={request.id} className="bg-zinc-50">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <h4 className="font-semibold">
                          {request.requestType === 'move_in' ? t('Move In') : t('Move Out')}
                        </h4>
                        <div className="flex items-center gap-2 text-sm text-zinc-600 mt-1">
                          <Calendar className="w-4 h-4" />
                          {format(new Date(request.date + 'T00:00:00'), 'MMM d, yyyy')}
                        </div>
                        <div className="flex items-center gap-2 text-sm text-zinc-600">
                          <Clock className="w-4 h-4" />
                          {request.startTime} - {request.endTime}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {getStatusBadge(request.status)}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeleteConfirm(request.id)}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                    
                    {request.notes && (
                      <p className="text-sm text-zinc-600 mb-3">
                        <span className="font-medium">{t('Notes')}:</span> {request.notes}
                      </p>
                    )}

                    {request.status === 'declined' && request.declineReason && (
                      <div className="bg-red-50 border border-red-200 rounded-lg p-3 mt-3">
                        <div className="flex items-start gap-2">
                          <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
                          <div>
                            <p className="text-sm font-semibold text-red-900">{t('Decline Reason')}</p>
                            <p className="text-sm text-red-700 mt-1">{request.declineReason}</p>
                          </div>
                        </div>
                      </div>
                    )}

                    {request.reviewedAt && (
                      <p className="text-xs text-zinc-400 mt-2">
                        {t('Reviewed')} {format(new Date(request.reviewedAt), 'MMM d, yyyy h:mm a')}
                      </p>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Delete Move Request')}</DialogTitle>
            <DialogDescription>
              {t('Are you sure you want to delete this move request? This action cannot be undone.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              {t('Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteRequest.mutate(deleteConfirm)}
              disabled={deleteRequest.isPending}
            >
              {deleteRequest.isPending ? t('Deleting...') : t('Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear all confirmation dialog */}
      <Dialog open={clearAllConfirm} onOpenChange={setClearAllConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Clear All Move Requests')}</DialogTitle>
            <DialogDescription>
              {t('Are you sure you want to clear all move requests? This action cannot be undone.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearAllConfirm(false)}>
              {t('Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => clearAllRequests.mutate()}
              disabled={clearAllRequests.isPending}
            >
              {clearAllRequests.isPending ? t('Clearing...') : t('Clear All')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, History as HistoryIcon, ChevronDown, ChevronUp, ZoomIn } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function SecurityGameroom() {
  const queryClient = useQueryClient();
  const [selectedRental, setSelectedRental] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [conditionModalOpen, setConditionModalOpen] = useState(false);
  const [selectedReturnRental, setSelectedReturnRental] = useState(null);
  const [condition, setCondition] = useState('good');
  const [conditionNotes, setConditionNotes] = useState('');
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingRental, setEditingRental] = useState(null);
  const [expandedHistoryId, setExpandedHistoryId] = useState(null);
  const [lightboxImage, setLightboxImage] = useState(null);

  // Mark gameroom notifications as read when page loads
  React.useEffect(() => {
    const markNotificationsRead = async () => {
      try {
        const me = await base44.auth.me();
        const notifications = await base44.entities.Notification.list('-created_date', 100);
        const myUnread = notifications.filter(n =>
          n.target_user_id === me.id &&
          n.type === 'amenity' &&
          n.link === 'SecurityGameroom' &&
          n.is_read === false
        );

        // Mark all as read
        for (const notification of myUnread) {
          await base44.entities.Notification.update(notification.id, { is_read: true });
        }
      } catch (error) {
        console.error('Failed to mark notifications as read:', error);
      }
    };

    markNotificationsRead();
  }, []);

  // Fetch ALL rentals (not filtered by creator) with auto-refresh
  const { data: rentals, isLoading } = useQuery({
    queryKey: ['gameroom-ops'],
    queryFn: async () => {
        const all = await base44.entities.GameroomRental.list('-created_date', 100);
        return all.filter(r => ['requested', 'accepted', 'active'].includes(r.status));
    },
    refetchInterval: 5000 // Auto-refresh every 5 seconds
  });

  // Fetch returns pending review
  const { data: pendingReturns } = useQuery({
    queryKey: ['gameroom-pending-returns'],
    queryFn: async () => {
        const all = await base44.entities.GameroomRental.list('-return_requested_at', 100);
        return all.filter(r => r.status === 'return_pending');
    },
    refetchInterval: 5000
  });

  // Fetch history from immutable event log (last 7 days)
  const { data: history } = useQuery({
    queryKey: ['gameroom-history'],
    queryFn: async () => {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        // Query the event log for completed events
        const allEvents = await base44.entities.GameroomRentalEvent.list('-event_at', 200);

        console.log('DEBUG: All events fetched:', allEvents.length);

        const completedEvents = allEvents.filter(e =>
            e.event_type === 'completed' &&
            e.event_at &&
            new Date(e.event_at) >= sevenDaysAgo
        );

        console.log('DEBUG: Completed events within 7 days:', completedEvents.length);

        // Backfill missing tower data for events in last 7 days
        const eventsNeedingTower = completedEvents.filter(e => !e.resident_tower && e.resident_unit);
        if (eventsNeedingTower.length > 0) {
            console.log('DEBUG: Backfilling tower for', eventsNeedingTower.length, 'events');

            for (const event of eventsNeedingTower) {
                // Derive tower from unit number (units starting with 1 are East tower)
                const tower = event.resident_unit.toString().startsWith('1') ? 'E' : 'W';

                // Update the event record
                await base44.entities.GameroomRentalEvent.update(event.id, {
                    resident_tower: tower
                });

                // Also update in memory
                event.resident_tower = tower;

                console.log(`DEBUG: Backfilled event ${event.id} with tower ${tower}`);
            }

            // Also backfill the original rental requests
            const requestIds = [...new Set(eventsNeedingTower.map(e => e.request_id))];
            for (const requestId of requestIds) {
                try {
                    const rentals = await base44.entities.GameroomRental.list();
                    const rental = rentals.find(r => r.id === requestId);
                    if (rental && !rental.resident_tower && rental.resident_unit) {
                        const tower = rental.resident_unit.toString().startsWith('1') ? 'E' : 'W';
                        await base44.entities.GameroomRental.update(requestId, {
                            resident_tower: tower
                        });
                        console.log(`DEBUG: Backfilled rental ${requestId} with tower ${tower}`);
                    }
                } catch (err) {
                    console.error(`Failed to backfill rental ${requestId}:`, err);
                }
            }
        }

        return completedEvents.map(e => ({
            id: e.id,
            request_id: e.request_id,
            item_name: e.item_name,
            resident_name: e.resident_name,
            resident_unit: e.resident_unit,
            resident_tower: e.resident_tower,
            completed_at: e.event_at,
            status: 'completed',
            condition: e.condition,
            condition_notes: e.condition_notes,
            acceptedByName: e.security_user_name || 'Security',
            preUsePhotoUrls: e.preUsePhotoUrls || [],
            postUsePhotoUrls: e.postUsePhotoUrls || [],
            preUseUploadedAt: e.preUseUploadedAt,
            postUseUploadedAt: e.postUseUploadedAt
        }));
    },
    refetchInterval: 10000
  });

  // Accept request
  const acceptRequest = useMutation({
    mutationFn: async (rental) => {
      const me = await base44.auth.me();
      const updated = await base44.entities.GameroomRental.update(rental.id, {
        status: 'accepted',
        assigned_security_user_id: me.id,
        accepted_at: new Date().toISOString(),
        security_notes: `Accepted by ${me.full_name}`
      });

      await base44.entities.Notification.create({
        title: 'Gameroom Request Accepted',
        message: `Your ${rental.item_name} request has been accepted. Security is preparing the item.`,
        type: 'amenity',
        target_unit: rental.resident_unit,
        link: 'gameroom'
      });

      return updated;
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['gameroom-ops']);
      toast.success("Request accepted");
    }
  });

  // Deny request
  const denyRequest = useMutation({
    mutationFn: async (rental) => {
      console.log('[DENY] Starting denial for rental:', rental.id);
      const me = await base44.auth.me();
      console.log('[DENY] Current user:', me.id, me.full_name);

      const updated = await base44.entities.GameroomRental.update(rental.id, {
        status: 'denied',
        completed_at: new Date().toISOString(),
        assigned_security_user_id: me.id,
        security_notes: `Denied by ${me.full_name}`
      });

      console.log('[DENY] Record updated:', updated);

      await base44.entities.Notification.create({
        title: 'Gameroom Request Denied',
        message: `Your ${rental.item_name} request was not approved.`,
        type: 'amenity',
        target_unit: rental.resident_unit,
        link: 'gameroom'
      });

      console.log('[DENY] Notification sent');
      return updated;
    },
    onSuccess: () => {
      console.log('[DENY] Success - invalidating queries');
      queryClient.invalidateQueries(['gameroom-ops']);
      toast.success("Request denied");
    },
    onError: (error) => {
      console.error('[DENY] Error:', error);
      toast.error(`Failed to deny request: ${error.message}`);
    }
  });

  // Proceed with photo (REQUIRED before completing)
  const proceedWithPhoto = useMutation({
    mutationFn: async () => {
      if (!photoFile) {
        throw new Error('Photo is required before proceeding');
      }

      const me = await base44.auth.me();
      const { file_url } = await base44.integrations.Core.UploadFile({ file: photoFile });

      await base44.entities.GameroomRental.update(selectedRental.id, {
        status: 'active',
        preUsePhotoUrls: [file_url],
        preUseUploadedAt: new Date().toISOString(),
        preUseUploadedBySecurityUserId: me.id,
        start_time: new Date().toISOString()
      });

      await base44.entities.Notification.create({
        title: 'Gameroom Item Ready',
        message: `Your ${selectedRental.item_name} is ready for pickup at the front desk. Timer started.`,
        type: 'amenity',
        target_unit: selectedRental.resident_unit,
        link: 'gameroom'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['gameroom-ops']);
      setSelectedRental(null);
      setPhotoFile(null);
      toast.success("Item checked out successfully");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to proceed");
    }
  });

  // Accept return with condition
  const acceptReturn = useMutation({
    mutationFn: async ({ rental, condition, conditionNotes }) => {
      const me = await base44.auth.me();
      const completedAt = new Date().toISOString();

      // Update the rental request
      await base44.entities.GameroomRental.update(rental.id, {
        status: 'completed',
        completed_at: completedAt,
        return_reviewed_at: completedAt,
        return_reviewed_by_security_user_id: me.id,
        condition: condition,
        condition_notes: conditionNotes,
        assigned_security_user_id: rental.assigned_security_user_id || me.id
      });

      // Ensure tower is set (backfill if missing)
      let tower = rental.resident_tower;
      if (!tower && rental.resident_unit) {
        tower = rental.resident_unit.toString().startsWith('1') ? 'E' : 'W';
        // Update rental with tower
        await base44.entities.GameroomRental.update(rental.id, {
          resident_tower: tower
        });
      }

      // Write immutable event log entry
      const eventData = await base44.entities.GameroomRentalEvent.create({
      request_id: rental.id,
      event_type: 'completed',
      event_at: completedAt,
      resident_user_id: rental.created_by,
      resident_name: rental.resident_name,
      resident_unit: rental.resident_unit,
      resident_tower: tower,
      item_name: rental.item_name,
      security_user_id: rental.assigned_security_user_id || me.id,
      security_user_name: me.full_name,
      photos: [...(rental.postUsePhotoUrls || []), ...(rental.preUsePhotoUrls || [])].filter(Boolean),
      condition: condition,
      condition_notes: conditionNotes,
      notes: rental.security_notes,
      preUsePhotoUrls: rental.preUsePhotoUrls || [],
      postUsePhotoUrls: rental.postUsePhotoUrls || [],
      preUseUploadedAt: rental.preUseUploadedAt,
      postUseUploadedAt: rental.postUseUploadedAt
      });

      // DEBUG: Show completion details
      toast.info(`DEBUG: Completed request ${rental.id}. Event logged. completedAt=${completedAt}`, { duration: 5000 });

      await base44.entities.Notification.create({
        title: 'Gameroom Return Confirmed',
        message: `Your ${rental.item_name} return has been confirmed. Thank you!`,
        type: 'amenity',
        target_unit: rental.resident_unit,
        link: 'gameroom'
      });

      return { rentalId: rental.id, completedAt };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries(['gameroom-ops']);
      queryClient.invalidateQueries(['gameroom-pending-returns']);
      queryClient.invalidateQueries(['gameroom-history']);
      queryClient.invalidateQueries(['all-active-rentals']);
      toast.success("Return accepted and completed");
      setConditionModalOpen(false);
      setSelectedReturnRental(null);
      setCondition('good');
      setConditionNotes('');

      // Force immediate refetch to show in history
      setTimeout(() => {
        queryClient.refetchQueries(['gameroom-history']);
      }, 500);
    }
  });

  // Edit condition in history
  const editCondition = useMutation({
    mutationFn: async ({ rentalId, eventId, condition, conditionNotes }) => {
      const me = await base44.auth.me();
      const editedAt = new Date().toISOString();

      // Update rental record
      await base44.entities.GameroomRental.update(rentalId, {
        condition: condition,
        condition_notes: conditionNotes,
        condition_edited_at: editedAt,
        condition_edited_by_security_user_id: me.id
      });

      // Update event record
      await base44.entities.GameroomRentalEvent.update(eventId, {
        condition: condition,
        condition_notes: conditionNotes
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['gameroom-history']);
      toast.success("Condition updated");
      setEditModalOpen(false);
      setEditingRental(null);
    }
  });

  // Security-initiated return
  const [returnRental, setReturnRental] = useState(null);
  const [returnPhotoFile, setReturnPhotoFile] = useState(null);
  const [returnCondition, setReturnCondition] = useState('good');
  const [returnNotes, setReturnNotes] = useState('');
  const [showReturnModal, setShowReturnModal] = useState(false);

  const processReturn = useMutation({
    mutationFn: async ({ rental, photoFile, condition, notes }) => {
      if (!photoFile) throw new Error('Return photo is required');

      const me = await base44.auth.me();
      const completedAt = new Date().toISOString();

      // Upload return photo
      const { file_url } = await base44.integrations.Core.UploadFile({ file: photoFile });

      // Ensure tower is set
      let tower = rental.resident_tower;
      if (!tower && rental.resident_unit) {
        tower = rental.resident_unit.toString().startsWith('1') ? 'E' : 'W';
      }

      // Update rental to completed
      await base44.entities.GameroomRental.update(rental.id, {
        status: 'completed',
        completed_at: completedAt,
        end_time: completedAt,
        postUsePhotoUrls: [file_url],
        postUseUploadedAt: completedAt,
        condition: condition,
        condition_notes: notes,
        return_reviewed_at: completedAt,
        return_reviewed_by_security_user_id: me.id,
        resident_tower: tower,
        assigned_security_user_id: rental.assigned_security_user_id || me.id
      });

      // Write immutable event log entry
      await base44.entities.GameroomRentalEvent.create({
        request_id: rental.id,
        event_type: 'completed',
        event_at: completedAt,
        resident_user_id: rental.created_by,
        resident_name: rental.resident_name,
        resident_unit: rental.resident_unit,
        resident_tower: tower,
        item_name: rental.item_name,
        security_user_id: me.id,
        security_user_name: me.full_name,
        photos: [file_url, ...(rental.preUsePhotoUrls || [])].filter(Boolean),
        condition: condition,
        condition_notes: notes,
        notes: rental.security_notes,
        preUsePhotoUrls: rental.preUsePhotoUrls || [],
        postUsePhotoUrls: [file_url],
        preUseUploadedAt: rental.preUseUploadedAt,
        postUseUploadedAt: completedAt
      });

      // Notify resident
      await base44.entities.Notification.create({
        title: 'Gameroom Return Confirmed',
        message: `Your ${rental.item_name} has been returned and confirmed by security. Thank you!`,
        type: 'amenity',
        target_unit: rental.resident_unit,
        link: 'gameroom'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['gameroom-ops']);
      queryClient.invalidateQueries(['gameroom-history']);
      queryClient.invalidateQueries(['all-active-rentals']);
      setShowReturnModal(false);
      setReturnRental(null);
      setReturnPhotoFile(null);
      setReturnCondition('good');
      setReturnNotes('');
      toast.success("Return processed successfully");

      setTimeout(() => {
        queryClient.refetchQueries(['gameroom-history']);
      }, 500);
    }
  });

  // Group history by day
  const groupedHistory = React.useMemo(() => {
    if (!history) return {};

    const groups = {};
    history.forEach(rental => {
      const date = format(new Date(rental.completed_at), 'yyyy-MM-dd');
      if (!groups[date]) groups[date] = [];
      groups[date].push(rental);
    });

    return groups;
  }, [history]);

  if (isLoading) return <div>Loading...</div>;

  return (
    <div className="space-y-6">
        <div className="flex justify-between items-center">
             <h2 className="text-2xl font-bold">Gameroom Operations</h2>
             <Button size="sm" variant="outline" onClick={() => {
                queryClient.invalidateQueries(['gameroom-ops']);
                queryClient.invalidateQueries(['gameroom-pending-returns']);
             }}>
                <RefreshCw className="w-4 h-4 mr-2" /> Refresh
             </Button>
        </div>

      {/* Returns Pending Review */}
      {pendingReturns && pendingReturns.length > 0 && (
        <Card className="border-purple-200 bg-purple-50">
          <div className="p-6 border-b border-purple-100">
            <h3 className="text-lg font-semibold text-purple-900">Returns Pending Review ({pendingReturns.length})</h3>
          </div>
          <div className="p-4 space-y-3">
            {pendingReturns.map(r => (
            <div key={r.id} className="bg-white rounded-lg p-4 border border-purple-100 flex items-start gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-semibold text-zinc-900">{r.resident_name}</span>
                  <span className="text-xs text-zinc-500">Unit {r.resident_unit} ({r.resident_tower})</span>
                  <span className="text-sm text-zinc-600">• {r.item_name}</span>
                </div>
                <div className="flex items-center gap-3">
                  {r.postUsePhotoUrls?.[0] && (
                    <img
                      src={r.postUsePhotoUrls[0]}
                      className="w-20 h-20 object-cover rounded border border-zinc-200 cursor-pointer hover:opacity-75"
                      alt="Return photo"
                      onClick={() => window.open(r.postUsePhotoUrls[0], '_blank')}
                    />
                  )}
                  <div className="text-xs text-zinc-500">
                    Requested {format(new Date(r.return_requested_at), 'MMM d, h:mm a')}
                  </div>
                </div>
              </div>
              <Button
                size="sm"
                className="bg-green-600 hover:bg-green-700"
                onClick={() => {
                  setSelectedReturnRental(r);
                  setConditionModalOpen(true);
                }}
              >
                Accept Return
              </Button>
            </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Resident</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {rentals?.map(r => (
                    <TableRow key={r.id}>
                        <TableCell className="font-medium">{r.item_name}</TableCell>
                        <TableCell>
                            {r.resident_name} <span className="text-zinc-400 text-xs">#{r.resident_unit}</span>
                        </TableCell>
                        <TableCell>
                            <StatusBadge status={r.status} />
                        </TableCell>
                        <TableCell className="text-xs text-zinc-500">
                            {format(new Date(r.created_date), 'MMM d, HH:mm')}
                        </TableCell>
                        <TableCell className="text-right space-x-2">
                            {r.status === 'requested' && (
                                <>
                                    <Button
                                        size="sm"
                                        className="bg-green-600 hover:bg-green-700"
                                        onClick={() => acceptRequest.mutate(r)}
                                        disabled={acceptRequest.isPending}
                                    >
                                        Accept
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="destructive"
                                        onClick={() => denyRequest.mutate(r)}
                                        disabled={denyRequest.isPending}
                                    >
                                        Deny
                                    </Button>
                                </>
                            )}

                            {r.status === 'accepted' && (
                                <Button
                                    size="sm"
                                    className="bg-blue-600 hover:bg-blue-700"
                                    onClick={() => setSelectedRental(r)}
                                >
                                    Upload Photo & Proceed
                                </Button>
                            )}

                            {r.status === 'active' && (
                                <>
                                    <Badge className="bg-blue-500 text-white">Active</Badge>
                                    <Button
                                        size="sm"
                                        className="bg-green-600 hover:bg-green-700"
                                        onClick={() => {
                                          setReturnRental(r);
                                          setShowReturnModal(true);
                                        }}
                                    >
                                        Return
                                    </Button>
                                </>
                            )}


                        </TableCell>
                    </TableRow>
                ))}
                 {(!rentals || rentals.length === 0) && (
                    <TableRow>
                        <TableCell colSpan={5} className="text-center text-zinc-400 py-8">No active requests.</TableCell>
                    </TableRow>
                )}
            </TableBody>
        </Table>
      </Card>

      {/* Photo Upload Dialog */}
      <Dialog open={!!selectedRental} onOpenChange={(open) => !open && setSelectedRental(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Photo & Proceed</DialogTitle>
            <DialogDescription>
              Photo is required before checking out the item to the resident.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
              📸 Take a clear photo of the <strong>{selectedRental?.item_name}</strong> before handing it over.
            </div>

            <div className="grid gap-2">
              <Label htmlFor="photo">Equipment Photo (Required)</Label>
              <Input
                id="photo"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => setPhotoFile(e.target.files?.[0])}
              />
              {photoFile && (
                <p className="text-sm text-green-600 font-medium">✓ Photo ready</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setSelectedRental(null);
              setPhotoFile(null);
            }}>
              Cancel
            </Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700"
              onClick={() => proceedWithPhoto.mutate()}
              disabled={!photoFile || proceedWithPhoto.isPending}
            >
              {proceedWithPhoto.isPending ? 'Processing...' : 'Proceed & Start Timer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* History Section */}
      <Card className="mt-8">
        <div className="p-6 border-b border-zinc-100">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-zinc-100 rounded-lg flex items-center justify-center">
                <HistoryIcon className="w-5 h-5 text-zinc-600" />
              </div>
              <div>
                <h3 className="text-lg font-semibold">History (Last 7 Days)</h3>
                <p className="text-sm text-zinc-500">
                  Total rentals: {history?.length || 0}
                  <span className="ml-2 text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded">
                    DEBUG: Query count = {history?.length || 0}
                  </span>
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => queryClient.refetchQueries(['gameroom-history'])}
            >
              <RefreshCw className="w-4 h-4 mr-2" /> Refresh
            </Button>
          </div>
        </div>

        <div className="divide-y divide-zinc-100">
          {Object.keys(groupedHistory).length === 0 ? (
            <div className="p-8 text-center text-zinc-400">
              No completed rentals in the last 7 days
            </div>
          ) : (
            Object.keys(groupedHistory)
              .sort((a, b) => new Date(b) - new Date(a))
              .map(dateKey => (
                <div key={dateKey} className="p-6">
                  <h4 className="text-sm font-semibold text-zinc-700 mb-4">
                    {isToday(new Date(dateKey)) ? 'Today' :
                     isYesterday(new Date(dateKey)) ? 'Yesterday' :
                     format(new Date(dateKey), 'EEEE, MMM d')}
                  </h4>
                  <div className="space-y-3">
                    {groupedHistory[dateKey].map(rental => {
                      const isDamagedOrLost = rental.condition === 'damaged' || rental.condition === 'lost';
                      const isExpanded = expandedHistoryId === rental.id;
                      return (
                        <div
                          key={rental.id}
                          className={`rounded-lg border overflow-hidden ${
                            isDamagedOrLost ? 'bg-red-50 border-red-200' : 'bg-zinc-50 border-zinc-100'
                          }`}
                        >
                          <div
                            className="flex items-center justify-between p-4 cursor-pointer hover:shadow-md transition-shadow"
                            onClick={() => setExpandedHistoryId(isExpanded ? null : rental.id)}
                          >
                            <div className="flex-1">
                              <div className="flex items-center gap-3">
                                {isDamagedOrLost && <span className="text-lg">👎</span>}
                                <div className="font-medium text-zinc-900">
                                  {rental.resident_name}
                                  <span className="ml-2 text-xs text-zinc-400">
                                    Unit {rental.resident_unit} ({rental.resident_tower || 'N/A'})
                                  </span>
                                </div>
                                <div className="text-sm text-zinc-500">•</div>
                                <div className="text-sm text-zinc-600">{rental.item_name}</div>
                                {isDamagedOrLost && (
                                  <span className={`text-xs font-bold uppercase px-2 py-1 rounded ${
                                    rental.condition === 'damaged' ? 'bg-orange-100 text-orange-800' : 'bg-red-100 text-red-800'
                                  }`}>
                                    {rental.condition}
                                  </span>
                                )}
                              </div>
                              <div className="mt-1 flex items-center gap-3 text-xs text-zinc-500">
                                <span>Completed: {format(new Date(rental.completed_at), 'h:mm a')}</span>
                                <span>•</span>
                                <span>Handled by: {rental.acceptedByName}</span>
                                {rental.condition_notes && (
                                  <>
                                    <span>•</span>
                                    <span className="italic">{rental.condition_notes}</span>
                                  </>
                                )}
                                {rental.request_id && (
                                  <span className="ml-2 text-[10px] bg-zinc-200 text-zinc-600 px-1.5 py-0.5 rounded">
                                    ID: {rental.request_id.slice(0, 8)}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <StatusBadge status={rental.status} />
                              {isExpanded ? <ChevronUp className="w-5 h-5 text-zinc-400" /> : <ChevronDown className="w-5 h-5 text-zinc-400" />}
                            </div>
                          </div>

                          {isExpanded && (
                            <div className="border-t border-zinc-200 bg-white p-6">
                              <div className="grid md:grid-cols-2 gap-6">
                                {/* Before Use Photos */}
                                <div>
                                  <h4 className="text-sm font-semibold text-zinc-700 mb-3 flex items-center gap-2">
                                    📸 Before Use (Security)
                                  </h4>
                                  {rental.preUsePhotoUrls && rental.preUsePhotoUrls.length > 0 ? (
                                    <div className="space-y-3">
                                      <div className="grid grid-cols-2 gap-2">
                                        {rental.preUsePhotoUrls.map((url, idx) => (
                                          <div
                                            key={idx}
                                            className="relative aspect-square rounded-lg overflow-hidden border border-zinc-200 cursor-pointer hover:opacity-75 transition-opacity group"
                                            onClick={() => setLightboxImage(url)}
                                          >
                                            <img src={url} alt={`Before use ${idx + 1}`} className="w-full h-full object-cover" />
                                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                              <ZoomIn className="w-6 h-6 text-white" />
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                      <div className="text-xs text-zinc-500">
                                        {rental.preUseUploadedAt && (
                                          <div>Uploaded: {format(new Date(rental.preUseUploadedAt), 'MMM d, h:mm a')}</div>
                                        )}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="text-sm text-zinc-400 italic p-4 bg-zinc-50 rounded-lg border border-zinc-200">
                                      No pre-use photos uploaded
                                    </div>
                                  )}
                                </div>

                                {/* After Use Photos */}
                                <div>
                                  <h4 className="text-sm font-semibold text-zinc-700 mb-3 flex items-center gap-2">
                                    📸 After Use (Resident Return)
                                  </h4>
                                  {rental.postUsePhotoUrls && rental.postUsePhotoUrls.length > 0 ? (
                                    <div className="space-y-3">
                                      <div className="grid grid-cols-2 gap-2">
                                        {rental.postUsePhotoUrls.map((url, idx) => (
                                          <div
                                            key={idx}
                                            className="relative aspect-square rounded-lg overflow-hidden border border-zinc-200 cursor-pointer hover:opacity-75 transition-opacity group"
                                            onClick={() => setLightboxImage(url)}
                                          >
                                            <img src={url} alt={`After use ${idx + 1}`} className="w-full h-full object-cover" />
                                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                              <ZoomIn className="w-6 h-6 text-white" />
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                      <div className="text-xs text-zinc-500">
                                        {rental.postUseUploadedAt && (
                                          <div>Uploaded: {format(new Date(rental.postUseUploadedAt), 'h:mm a')}</div>
                                        )}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="text-sm text-zinc-400 italic p-4 bg-zinc-50 rounded-lg border border-zinc-200">
                                      No return photos uploaded
                                    </div>
                                  )}
                                </div>
                              </div>

                              <div className="mt-4 pt-4 border-t border-zinc-100 flex justify-end">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingRental(rental);
                                    setCondition(rental.condition || 'good');
                                    setConditionNotes(rental.condition_notes || '');
                                    setEditModalOpen(true);
                                  }}
                                >
                                  Edit Condition
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
          )}
        </div>

        <div className="p-4 bg-zinc-50 border-t border-zinc-100 text-center">
          <p className="text-xs text-zinc-500">List automatically resets after 7 days</p>
        </div>
      </Card>

      {/* Condition Modal */}
      <Dialog open={conditionModalOpen} onOpenChange={setConditionModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Return Condition Check</DialogTitle>
            <DialogDescription>
              Were the items damaged or lost?
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-3">
              <label className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer hover:bg-zinc-50 transition-colors" style={{ borderColor: condition === 'good' ? '#22c55e' : '#e5e7eb' }}>
                <input
                  type="radio"
                  name="condition"
                  value="good"
                  checked={condition === 'good'}
                  onChange={(e) => setCondition(e.target.value)}
                  className="w-4 h-4"
                />
                <span className="font-medium">✅ Good condition</span>
              </label>

              <label className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer hover:bg-zinc-50 transition-colors" style={{ borderColor: condition === 'damaged' ? '#f97316' : '#e5e7eb' }}>
                <input
                  type="radio"
                  name="condition"
                  value="damaged"
                  checked={condition === 'damaged'}
                  onChange={(e) => setCondition(e.target.value)}
                  className="w-4 h-4"
                />
                <span className="font-medium">⚠️ Damaged</span>
              </label>

              <label className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer hover:bg-zinc-50 transition-colors" style={{ borderColor: condition === 'lost' ? '#ef4444' : '#e5e7eb' }}>
                <input
                  type="radio"
                  name="condition"
                  value="lost"
                  checked={condition === 'lost'}
                  onChange={(e) => setCondition(e.target.value)}
                  className="w-4 h-4"
                />
                <span className="font-medium">❌ Lost</span>
              </label>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="condition-notes">Notes (optional)</Label>
              <Input
                id="condition-notes"
                placeholder="Add any notes about the condition..."
                value={conditionNotes}
                onChange={(e) => setConditionNotes(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConditionModalOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={() => acceptReturn.mutate({
                rental: selectedReturnRental,
                condition,
                conditionNotes
              })}
              disabled={acceptReturn.isPending}
            >
              {acceptReturn.isPending ? 'Processing...' : 'Accept Return'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Condition Modal */}
      <Dialog open={editModalOpen} onOpenChange={setEditModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Condition</DialogTitle>
            <DialogDescription>
              Update the return condition for this rental
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-3">
              <label className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer hover:bg-zinc-50 transition-colors" style={{ borderColor: condition === 'good' ? '#22c55e' : '#e5e7eb' }}>
                <input
                  type="radio"
                  name="edit-condition"
                  value="good"
                  checked={condition === 'good'}
                  onChange={(e) => setCondition(e.target.value)}
                  className="w-4 h-4"
                />
                <span className="font-medium">✅ Good condition</span>
              </label>

              <label className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer hover:bg-zinc-50 transition-colors" style={{ borderColor: condition === 'damaged' ? '#f97316' : '#e5e7eb' }}>
                <input
                  type="radio"
                  name="edit-condition"
                  value="damaged"
                  checked={condition === 'damaged'}
                  onChange={(e) => setCondition(e.target.value)}
                  className="w-4 h-4"
                />
                <span className="font-medium">⚠️ Damaged</span>
              </label>

              <label className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer hover:bg-zinc-50 transition-colors" style={{ borderColor: condition === 'lost' ? '#ef4444' : '#e5e7eb' }}>
                <input
                  type="radio"
                  name="edit-condition"
                  value="lost"
                  checked={condition === 'lost'}
                  onChange={(e) => setCondition(e.target.value)}
                  className="w-4 h-4"
                />
                <span className="font-medium">❌ Lost</span>
              </label>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="edit-condition-notes">Notes (optional)</Label>
              <Input
                id="edit-condition-notes"
                placeholder="Add any notes about the condition..."
                value={conditionNotes}
                onChange={(e) => setConditionNotes(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditModalOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => editCondition.mutate({
                rentalId: editingRental.request_id,
                eventId: editingRental.id,
                condition,
                conditionNotes
              })}
              disabled={editCondition.isPending}
            >
              {editCondition.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Return Processing Modal */}
      <Dialog open={showReturnModal} onOpenChange={setShowReturnModal}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Process Return</DialogTitle>
            <DialogDescription>
              Take a photo of the returned item and verify its condition
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
              📸 Resident returning: <strong>{returnRental?.item_name}</strong>
              <div className="text-xs text-blue-600 mt-1">
                {returnRental?.resident_name} • Unit {returnRental?.resident_unit}
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="return-photo">Return Photo (Required)</Label>
              <Input
                id="return-photo"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => setReturnPhotoFile(e.target.files?.[0])}
              />
              {returnPhotoFile && (
                <p className="text-sm text-green-600 font-medium">✓ Photo ready</p>
              )}
            </div>

            <div className="space-y-3">
              <Label>Item Condition</Label>
              <label className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer hover:bg-zinc-50 transition-colors" style={{ borderColor: returnCondition === 'good' ? '#22c55e' : '#e5e7eb' }}>
                <input
                  type="radio"
                  name="return-condition"
                  value="good"
                  checked={returnCondition === 'good'}
                  onChange={(e) => setReturnCondition(e.target.value)}
                  className="w-4 h-4"
                />
                <span className="font-medium">✅ Good condition</span>
              </label>

              <label className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer hover:bg-zinc-50 transition-colors" style={{ borderColor: returnCondition === 'damaged' ? '#f97316' : '#e5e7eb' }}>
                <input
                  type="radio"
                  name="return-condition"
                  value="damaged"
                  checked={returnCondition === 'damaged'}
                  onChange={(e) => setReturnCondition(e.target.value)}
                  className="w-4 h-4"
                />
                <span className="font-medium">⚠️ Damaged</span>
              </label>

              <label className="flex items-center gap-3 p-3 border-2 rounded-lg cursor-pointer hover:bg-zinc-50 transition-colors" style={{ borderColor: returnCondition === 'lost' ? '#ef4444' : '#e5e7eb' }}>
                <input
                  type="radio"
                  name="return-condition"
                  value="lost"
                  checked={returnCondition === 'lost'}
                  onChange={(e) => setReturnCondition(e.target.value)}
                  className="w-4 h-4"
                />
                <span className="font-medium">❌ Lost</span>
              </label>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="return-notes">Notes (optional)</Label>
              <Input
                id="return-notes"
                placeholder="Add any notes about the condition..."
                value={returnNotes}
                onChange={(e) => setReturnNotes(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowReturnModal(false);
              setReturnRental(null);
              setReturnPhotoFile(null);
              setReturnCondition('good');
              setReturnNotes('');
            }}>
              Cancel
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700"
              onClick={() => processReturn.mutate({
                rental: returnRental,
                photoFile: returnPhotoFile,
                condition: returnCondition,
                notes: returnNotes
              })}
              disabled={!returnPhotoFile || processReturn.isPending}
            >
              {processReturn.isPending ? 'Processing...' : 'Complete Return'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lightbox for Photo Zoom */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setLightboxImage(null)}
        >
          <div className="relative max-w-4xl max-h-[90vh]">
            <img
              src={lightboxImage}
              alt="Full size"
              className="max-w-full max-h-[90vh] object-contain rounded-lg"
            />
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-4 right-4 bg-white/10 hover:bg-white/20 text-white"
              onClick={() => setLightboxImage(null)}
            >
              ✕
            </Button>
          </div>
        </div>
      )}
      </div>
      );
      }

function StatusBadge({ status }) {
  const styles = {
    requested: "bg-amber-100 text-amber-800 border-amber-200",
    accepted: "bg-purple-100 text-purple-800 border-purple-200",
    active: "bg-blue-500 text-white border-blue-600",
    returned: "bg-orange-100 text-orange-800 border-orange-200",
    completed: "bg-zinc-100 text-zinc-600 border-zinc-200",
    denied: "bg-red-100 text-red-800 border-red-200"
  };
  return (
    <Badge className={`${styles[status] || 'bg-zinc-50'} border`}>
      {status}
    </Badge>
  );
}

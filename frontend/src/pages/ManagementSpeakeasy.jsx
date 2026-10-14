import React from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Check, X, Archive, Trash2, Wine } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { format } from 'date-fns';
import { toast } from 'sonner';

const TABS = ['pending', 'active', 'archived'];

export default function ManagementSpeakeasy() {
  const [tab, setTab] = React.useState('pending');
  const [confirmDelete, setConfirmDelete] = React.useState(null);
  const queryClient = useQueryClient();
  const { data: currentUser } = useQuery({ queryKey: ['me'], queryFn: () => base44.auth.me() });

  const { data: reservations, isLoading } = useQuery({
    queryKey: ['mgmt-speakeasy', tab],
    queryFn: async () => {
      let statuses;
      if (tab === 'pending') statuses = ['pending'];
      else if (tab === 'active') statuses = ['approved', 'paid', 'active'];
      else statuses = ['declined', 'completed', 'force_closed'];

      let allReservations = [];
      for (const status of statuses) {
        const filtered = await base44.entities.SpeakeasyReservation.filter({ status }, '-created_date', 100);
        allReservations = [...allReservations, ...filtered];
      }

      const profiles = await base44.entities.Profile.list();
      return allReservations.map(res => {
        const profile = profiles.find(p => p.userId === res.resident_user_id);
        return {
          ...res,
          current_name: profile?.full_name || res.resident_name,
          current_unit: profile?.unit_number || res.resident_unit
        };
      });
    }
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status, resident_user_id, reservation }) => {
      const now = new Date().toISOString();
      const updateData = {
        status,
        ...(status === 'approved' ? { approved_by: currentUser?.id, approved_at: now } : {}),
        ...(status === 'declined' ? { declined_by: currentUser?.id, declined_at: now } : {})
      };

      await base44.entities.SpeakeasyReservation.update(id, updateData);

      // Notify resident
      if (resident_user_id) {
        try {
          const profiles = await base44.entities.Profile.filter({ userId: resident_user_id });
          const profile = profiles[0];
          await base44.entities.Notification.create({
            title: status === 'approved' ? 'Reservation Approved ✓' : 'Reservation Declined',
            message: status === 'approved'
              ? `Your ${reservation.room_type} reservation for ${format(new Date(reservation.date + 'T12:00:00'), 'MMM d')} has been approved!`
              : `Your ${reservation.room_type} reservation for ${format(new Date(reservation.date + 'T12:00:00'), 'MMM d')} has been declined.`,
            type: 'amenity',
            target_user_id: resident_user_id,
            target_unit: profile?.unit_number,
            link: 'Speakeasy'
          });
        } catch (error) {
          console.error('Failed to notify resident:', error);
        }
      }

      // If approved: notify security + add to calendar
      if (status === 'approved') {
        try {
          // Notify all security users
          const allUsers = await base44.entities.User.list();
          const securityUsers = allUsers.filter(u =>
            u.management_role === 'security' || u.app_role === 'security'
          );
          for (const sec of securityUsers) {
            await base44.entities.Notification.create({
              title: 'Speakeasy Reservation Approved',
              message: `${reservation.current_name || reservation.resident_name} (Unit ${reservation.current_unit || reservation.resident_unit}) – ${reservation.room_type} on ${format(new Date(reservation.date + 'T12:00:00'), 'MMM d')} from ${reservation.start_time} to ${reservation.end_time}`,
              type: 'amenity',
              target_user_id: sec.id,
              link: 'ManagementNotices'
            });
          }

          // Add to calendar as a BuildingUpdate so it appears in Daily Notices
          const startDatetime = new Date(`${reservation.date}T${reservation.start_time}:00`).toISOString();
          const endDatetime = new Date(`${reservation.date}T${reservation.end_time}:00`).toISOString();
          await base44.entities.BuildingUpdate.create({
            title: `Speakeasy: ${reservation.room_type}`,
            message: `${reservation.current_name || reservation.resident_name} (Unit ${reservation.current_unit || reservation.resident_unit}) has a reservation for ${reservation.room_type} from ${reservation.start_time} to ${reservation.end_time}.`,
            type: 'amenity',
            priority: 'normal',
            startTime: startDatetime,
            endTime: endDatetime,
            location: reservation.room_type,
            postedByUserId: currentUser?.id,
            postedByName: currentUser?.full_name,
            postedByRole: 'management',
            isActive: true
          });
        } catch (error) {
          console.error('Failed to notify security or add to calendar:', error);
          toast.error('Approved but failed to notify security / update calendar');
        }
      }

      return { id, status };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['mgmt-speakeasy'] });
      // Stay on pending tab — do NOT switch to archive
      toast.success(`Reservation ${data.status === 'approved' ? 'approved' : 'declined'} successfully`);
    },
    onError: () => toast.error('Failed to process reservation')
  });

  const archiveReservation = useMutation({
    mutationFn: (id) => base44.entities.SpeakeasyReservation.update(id, { status: 'completed' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mgmt-speakeasy'] });
      toast.success('Reservation archived');
    },
    onError: () => toast.error('Failed to archive reservation')
  });

  const permanentDelete = useMutation({
    mutationFn: async (id) => {
      await base44.entities.SpeakeasyReservation.delete(id);
      return id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mgmt-speakeasy'] });
      setConfirmDelete(null);
      toast.success('Reservation permanently deleted');
    },
    onError: () => toast.error('Failed to delete reservation')
  });

  const tabLabel = { pending: 'Pending', active: 'Active', archived: 'Archived' };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-purple-900 rounded-xl flex items-center justify-center">
            <Wine className="w-5 h-5 text-purple-200" />
          </div>
          <h2 className="text-2xl font-bold">Speakeasy Reservations</h2>
        </div>
        <Button size="sm" variant="outline" onClick={() => queryClient.invalidateQueries({ queryKey: ['mgmt-speakeasy'] })}>
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-200">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t
                ? 'border-zinc-900 text-zinc-900'
                : 'border-transparent text-zinc-500 hover:text-zinc-700'
            }`}
          >
            {tabLabel[t]}
          </button>
        ))}
      </div>

      <Card>
        {isLoading ? (
          <div className="py-12 text-center text-zinc-400">Loading...</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Room</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Resident</TableHead>
                <TableHead className="text-right">
                  {tab === 'pending' ? 'Decision' : tab === 'active' ? 'Action' : 'Status'}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reservations?.map(r => (
                <TableRow key={r.id}>
                  <TableCell>{format(new Date(r.date + 'T12:00:00'), 'MMM d, yyyy')}</TableCell>
                  <TableCell className="font-medium">{r.room_type}</TableCell>
                  <TableCell className="text-zinc-500">{r.start_time} – {r.end_time}</TableCell>
                  <TableCell>
                    {r.current_name} <span className="text-zinc-400 text-xs">#{r.current_unit}</span>
                  </TableCell>
                  <TableCell className="text-right">
                    {tab === 'pending' && (
                      <div className="flex gap-2 justify-end">
                        <Button
                          size="sm"
                          className="bg-green-600 hover:bg-green-700"
                          onClick={() => updateStatus.mutate({ id: r.id, status: 'approved', resident_user_id: r.resident_user_id, reservation: r })}
                          disabled={updateStatus.isPending}
                        >
                          <Check className="w-4 h-4 mr-1" /> Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => updateStatus.mutate({ id: r.id, status: 'declined', resident_user_id: r.resident_user_id, reservation: r })}
                          disabled={updateStatus.isPending}
                        >
                          <X className="w-4 h-4 mr-1" /> Decline
                        </Button>
                      </div>
                    )}
                    {tab === 'active' && (
                      <div className="flex items-center justify-end gap-2">
                        <Badge className="bg-green-100 text-green-800 border-green-200 capitalize">{r.status}</Badge>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-zinc-500 hover:text-zinc-700 h-7 px-2"
                          onClick={() => archiveReservation.mutate(r.id)}
                          disabled={archiveReservation.isPending}
                          title="Archive"
                        >
                          <Archive className="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                    {tab === 'archived' && (
                      <div className="flex items-center justify-end gap-2">
                        <Badge variant={r.status === 'declined' ? 'destructive' : 'secondary'} className="capitalize">
                          {r.status}
                        </Badge>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-500 hover:text-red-700 hover:bg-red-50 h-7 px-2"
                          onClick={() => setConfirmDelete(r)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {(!reservations || reservations.length === 0) && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-zinc-400 py-8">
                    No {tabLabel[tab].toLowerCase()} reservations.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Permanently Delete Reservation</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-zinc-600">
            This will permanently delete this reservation and cannot be undone.
          </p>
          <div className="flex gap-2 justify-end mt-4">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => permanentDelete.mutate(confirmDelete.id)}
              disabled={permanentDelete.isPending}
            >
              <Trash2 className="w-4 h-4 mr-2" /> Delete Permanently
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
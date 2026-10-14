import React from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { RefreshCw } from 'lucide-react';
import { format, isToday } from 'date-fns';
import { toast } from 'sonner';

export default function SecuritySpeakeasy() {
  const queryClient = useQueryClient();

  const { data: reservations, isLoading } = useQuery({
    queryKey: ['speakeasy-ops'],
    queryFn: async () => {
      const [res, profiles] = await Promise.all([
        base44.entities.SpeakeasyReservation.list('-created_date', 200),
        base44.entities.Profile.list('-created_date', 200),
      ]);
      const profileMap = {};
      profiles.forEach(p => { if (p.userId) profileMap[p.userId] = p; });

      const today = format(new Date(), 'yyyy-MM-dd');
      return res
        .filter(r => !r.archived && r.status !== 'declined' && (r.status !== 'pending' || r.date >= today))
        .sort((a, b) => {
          if (b.date !== a.date) return b.date.localeCompare(a.date);
          return (a.start_time || '').localeCompare(b.start_time || '');
        })
        .map(r => {
          const profile = r.resident_user_id ? profileMap[r.resident_user_id] : null;
          return {
            ...r,
            _displayName: profile?.full_name || r.resident_name || '—',
            _displayUnit: profile?.unit_number || r.resident_unit || '—',
          };
        });
    }
  });

  const updateStatus = useMutation({
    mutationFn: ({id, status, extraData={}}) => base44.entities.SpeakeasyReservation.update(id, { status, ...extraData }),
    onSuccess: () => {
        queryClient.invalidateQueries(['speakeasy-ops']);
        toast.success("Status updated");
    }
  });

  if (isLoading) return <div>Loading...</div>;

  return (
    <div className="space-y-6">
        <div className="flex justify-between items-center">
             <h2 className="text-2xl font-bold">Speakeasy Operations</h2>
             <Button size="sm" variant="outline" onClick={() => queryClient.invalidateQueries(['speakeasy-ops'])}>
                <RefreshCw className="w-4 h-4 mr-2" /> Refresh
             </Button>
        </div>
     
      <Card>
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Room</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead>Resident</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {reservations?.map(r => (
                    <TableRow key={r.id}>
                        <TableCell className="text-sm font-medium whitespace-nowrap">
                          {r.date ? format(new Date(r.date + 'T00:00:00'), 'MMM d, yyyy') : '—'}
                          {r.date === format(new Date(), 'yyyy-MM-dd') && <span className="ml-1 text-xs text-green-600 font-semibold">Today</span>}
                        </TableCell>
                        <TableCell className="font-medium">{r.room_type}</TableCell>
                        <TableCell className="text-zinc-500">
                             {r.start_time} - {r.end_time}
                        </TableCell>
                        <TableCell>
                            {r._displayName} <span className="text-zinc-400 text-xs">#{r._displayUnit}</span>
                        </TableCell>
                        <TableCell>
                            <BadgeStatus status={r.status} />
                        </TableCell>
                        <TableCell className="text-right space-x-2">
                            {r.status === 'paid' && (
                                <Button size="sm" className="bg-green-600" onClick={() => updateStatus.mutate({id: r.id, status: 'active', extraData: { session_start: new Date().toISOString() }})}>
                                    Start Session
                                </Button>
                            )}
                            {r.status === 'active' && (
                                <Button size="sm" variant="outline" onClick={() => updateStatus.mutate({id: r.id, status: 'completed', extraData: { session_end: new Date().toISOString() }})}>
                                    End Session
                                </Button>
                            )}
                            {(r.status === 'active' || r.status === 'paid') && (
                                <Button size="sm" variant="destructive" onClick={() => updateStatus.mutate({id: r.id, status: 'force_closed'})}>
                                    Force Close
                                </Button>
                            )}
                            {['approved', 'completed', 'force_closed', 'pending'].includes(r.status) && (
                                <Button size="sm" variant="ghost" className="text-zinc-400 hover:text-zinc-700" onClick={() => updateStatus.mutate({id: r.id, status: r.status, extraData: { archived: true }})}>
                                    Archive
                                </Button>
                            )}
                        </TableCell>
                    </TableRow>
                ))}
                 {(!reservations || reservations.length === 0) && (
                    <TableRow>
                        <TableCell colSpan={6} className="text-center text-zinc-400 py-8">No reservations to display.</TableCell>
                    </TableRow>
                )}
            </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function BadgeStatus({ status }) {
    const styles = {
        pending: "bg-yellow-100 text-yellow-800",
        approved: "bg-blue-100 text-blue-800",
        paid: "bg-green-100 text-green-800",
        active: "bg-purple-100 text-purple-800 animate-pulse",
        completed: "bg-zinc-100 text-zinc-800",
        force_closed: "bg-red-100 text-red-800"
    };
    return (
        <Badge variant="secondary" className={styles[status] || "bg-zinc-100"}>
            {status}
        </Badge>
    );
}
import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { RefreshCw, Clock, Phone, Mail, Archive, Send, Trash2, ArchiveRestore } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function ManagementMaintenance() {
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [filterStatus, setFilterStatus] = useState('all');
  const [showArchive, setShowArchive] = useState(false);
  const [newNoteContent, setNewNoteContent] = useState('');
  const [user, setUser] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const queryClient = useQueryClient();

  // Fetch current user
  React.useEffect(() => {
    const fetchUser = async () => {
      const currentUser = await base44.auth.me();
      setUser(currentUser);
    };
    fetchUser();
  }, []);

  const { data: allTickets, isLoading } = useQuery({
    queryKey: ['mgmt-maintenance'],
    queryFn: () => base44.entities.MaintenanceTicket.list('-created_date', 200)
  });

  const { data: profiles } = useQuery({
    queryKey: ['all-profiles'],
    queryFn: () => base44.entities.Profile.list()
  });

  const { data: users } = useQuery({
    queryKey: ['all-users'],
    queryFn: () => base44.entities.User.list()
  });

  const { data: notes } = useQuery({
    queryKey: ['maintenance-notes', selectedTicket?.id],
    queryFn: () => selectedTicket ? base44.entities.MaintenanceNote.filter({ ticket_id: selectedTicket.id }, '-created_date', 100) : Promise.resolve([]),
    enabled: !!selectedTicket
  });

  const addNoteMutation = useMutation({
    mutationFn: async (content) => {
      return base44.entities.MaintenanceNote.create({
        ticket_id: selectedTicket.id,
        content,
        created_by_name: user?.full_name || 'Staff'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['maintenance-notes', selectedTicket?.id]);
      setNewNoteContent('');
      toast.success('Note added');
    }
  });

  const archiveTicket = useMutation({
    mutationFn: async ({ id, archive }) => {
      return base44.entities.MaintenanceTicket.update(id, {
        is_archived: archive,
        archived_at: archive ? new Date().toISOString() : null
      });
    },
    onSuccess: (updated, { archive }) => {
      queryClient.invalidateQueries(['mgmt-maintenance']);
      setSelectedTicket(null);
      toast.success(archive ? 'Ticket archived' : 'Ticket restored');
    }
  });

  const tickets = allTickets?.filter(t => {
    if (showArchive) {
      return !!t.is_archived;
    }
    if (t.is_archived) return false;
    return filterStatus === 'all' || t.status === filterStatus;
  }).map(t => {
    const profile = profiles?.find(p => p.userId === t.resident_user_id);
    const user = users?.find(u => u.id === t.resident_user_id);
    return {
      ...t,
      current_name: profile?.full_name || 'Unknown',
      current_unit: profile?.unit_number || t.unit_number,
      resident_email: user?.email,
      resident_phone: profile?.primary_phone
    };
  }) || [];

  const updateTicket = useMutation({
    mutationFn: async ({id, updates, ticket}) => {
        const updated = await base44.entities.MaintenanceTicket.update(id, updates);

        // Notify resident of status change
        if (ticket && updates.status) {
          await base44.entities.Notification.create({
            title: 'Maintenance Update',
            message: `Your request "${ticket.title}" is now ${updates.status.replace('_', ' ')}.`,
            type: 'maintenance',
            target_user_id: ticket.resident_user_id,
            target_unit: ticket.current_unit,
            link: 'Maintenance'
          });
        }

        return updated;
    },
    onSuccess: (updated) => {
        queryClient.invalidateQueries(['mgmt-maintenance']);
        toast.success("Ticket updated");
        setSelectedTicket(prev => prev ? {...prev, ...updated} : null);
    }
  });

  const deleteTicket = useMutation({
    mutationFn: async (id) => {
      await base44.entities.MaintenanceTicket.delete(id);
      return id;
    },
    onSuccess: (id) => {
      queryClient.setQueryData(['mgmt-maintenance'], (old) => old?.filter(t => t.id !== id) ?? []);
      queryClient.invalidateQueries({ queryKey: ['mgmt-maintenance'] });
      if (selectedTicket?.id === id) setSelectedTicket(null);
      setConfirmDelete(null);
      toast.success('Ticket deleted');
    },
    onError: () => toast.error('Failed to delete ticket')
  });

  if (isLoading) return <div>Loading...</div>;

  return (
    <div className="space-y-6">
        <div className="space-y-4">
          <div className="flex justify-between items-center">
             <h2 className="text-2xl font-bold">Maintenance Management</h2>
             <div className="flex gap-2">
               <Button
                 size="sm"
                 variant={showArchive ? 'default' : 'outline'}
                 onClick={() => {
                   setShowArchive(!showArchive);
                   setFilterStatus('all');
                 }}
               >
                 <Archive className="w-4 h-4 mr-2" /> Archive
               </Button>
               <Button size="sm" variant="outline" onClick={() => queryClient.invalidateQueries(['mgmt-maintenance'])}>
                  <RefreshCw className="w-4 h-4 mr-2" /> Refresh
               </Button>
             </div>
          </div>
          {!showArchive && (
            <div className="flex gap-2">
              {['all', 'in_review', 'scheduled', 'in_progress', 'completed'].map(status => (
                <Button
                  key={status}
                  size="sm"
                  variant={filterStatus === status ? 'default' : 'outline'}
                  onClick={() => setFilterStatus(status)}
                  className="capitalize"
                >
                  {status === 'all' ? 'All' : status.replace('_', ' ')}
                </Button>
              ))}
            </div>
          )}
        </div>

      <Card className="overflow-hidden">
        <div className="overflow-y-auto max-h-[600px]">
          <Table>
              <TableHeader className="sticky top-0 bg-white">
                  <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Resident</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead></TableHead>
                  </TableRow>
              </TableHeader>
              <TableBody>
                  {tickets?.map(t => (
                      <TableRow key={t.id} className="cursor-pointer hover:bg-zinc-50" onClick={() => setSelectedTicket(t)}>
                          <TableCell className="text-xs text-zinc-500">
                            {format(new Date(t.created_date), 'MMM d')}
                          </TableCell>
                          <TableCell>
                              <div className="font-medium text-sm">{t.current_name}</div>
                              <div className="text-xs text-zinc-500">#{t.current_unit}</div>
                          </TableCell>
                          <TableCell>
                              <div className="font-medium">{t.title}</div>
                              <div className="text-xs text-zinc-500 truncate max-w-[200px]">{t.description}</div>
                          </TableCell>
                          <TableCell className="capitalize text-zinc-500 text-sm">{t.type.replace('_', ' ')}</TableCell>
                          <TableCell>
                              <Badge variant={t.priority === 'high' || t.priority === 'emergency' ? 'destructive' : 'outline'} className="capitalize">
                                {t.priority}
                              </Badge>
                          </TableCell>
                          <TableCell>
                              <Badge variant={t.status === 'submitted' || t.status === 'in_review' ? 'outline' : 'secondary'} className="capitalize">
                                 {t.status.replace('_', ' ')}
                              </Badge>
                          </TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()} className="flex gap-1">
                            {!showArchive ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-zinc-400 hover:text-zinc-700 h-7 px-2"
                                title="Archive"
                                onClick={(e) => { e.stopPropagation(); archiveTicket.mutate({ id: t.id, archive: true }); }}
                              >
                                <Archive className="w-4 h-4" />
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-zinc-400 hover:text-zinc-700 h-7 px-2"
                                title="Restore"
                                onClick={(e) => { e.stopPropagation(); archiveTicket.mutate({ id: t.id, archive: false }); }}
                              >
                                <ArchiveRestore className="w-4 h-4" />
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-red-500 hover:text-red-700 hover:bg-red-50 h-7 px-2"
                              onClick={(e) => { e.stopPropagation(); setConfirmDelete(t); }}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </TableCell>
                          </TableRow>
                  ))}
                  {(!tickets || tickets.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-zinc-400">No maintenance requests.</TableCell>
                    </TableRow>
                  )}
              </TableBody>
          </Table>
        </div>
      </Card>

      <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Maintenance Request</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-zinc-600">
            This action is permanent and cannot be undone. The request "<strong>{confirmDelete?.title}</strong>" will be removed.
          </p>
          <div className="flex gap-2 justify-end mt-4">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteTicket.mutate(confirmDelete.id)}
              disabled={deleteTicket.isPending}
            >
              <Trash2 className="w-4 h-4 mr-2" /> Delete Permanently
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedTicket} onOpenChange={() => setSelectedTicket(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Maintenance Request Details</DialogTitle>
          </DialogHeader>
          {selectedTicket && (
           <div className="space-y-6 max-h-[70vh] overflow-y-auto">
             <div className="flex items-start justify-between pb-4 border-b">
               <div>
                 <h3 className="text-lg font-semibold">{selectedTicket.title}</h3>
                 <p className="text-sm text-zinc-500">{selectedTicket.current_name} • Unit {selectedTicket.current_unit}</p>
                 <div className="flex gap-4 mt-2 text-xs">
                   {selectedTicket.resident_email && (
                     <a href={`mailto:${selectedTicket.resident_email}`} className="text-blue-600 hover:underline flex items-center gap-1">
                       <Mail className="w-3 h-3" /> {selectedTicket.resident_email}
                     </a>
                   )}
                   {selectedTicket.resident_phone && (
                     <a href={`tel:${selectedTicket.resident_phone}`} className="text-blue-600 hover:underline flex items-center gap-1">
                       <Phone className="w-3 h-3" /> {selectedTicket.resident_phone}
                     </a>
                   )}
                 </div>
               </div>
               <Badge className="capitalize">{selectedTicket.status.replace('_', ' ')}</Badge>
             </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1">
                  <p className="text-xs text-zinc-500">Submitted</p>
                  <p className="text-sm font-medium flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {format(new Date(selectedTicket.created_date), 'MMM d, h:mm a')}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-zinc-500">Type</p>
                  <p className="text-sm font-medium capitalize">{selectedTicket.type.replace('_', ' ')}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-zinc-500">Priority</p>
                  <Badge variant={selectedTicket.priority === 'high' || selectedTicket.priority === 'emergency' ? 'destructive' : 'outline'} className="capitalize">
                    {selectedTicket.priority}
                  </Badge>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs text-zinc-500 font-medium">Description</p>
                <p className="text-sm text-zinc-700 leading-relaxed bg-zinc-50 p-3 rounded-lg">{selectedTicket.description}</p>
              </div>

              <div className="space-y-4 pt-4 border-t">
                <h4 className="font-semibold text-sm">Management Actions</h4>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-xs text-zinc-500">Status</label>
                    <Select
                      value={selectedTicket.status}
                      onValueChange={(v) => updateTicket.mutate({id: selectedTicket.id, updates: {status: v}, ticket: selectedTicket})}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="submitted">Submitted</SelectItem>
                        <SelectItem value="in_review">In Review</SelectItem>
                        <SelectItem value="scheduled">Scheduled</SelectItem>
                        <SelectItem value="in_progress">In Progress</SelectItem>
                        <SelectItem value="completed">Completed</SelectItem>
                        <SelectItem value="cancelled">Cancelled</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs text-zinc-500">Priority</label>
                    <Select
                      value={selectedTicket.priority}
                      onValueChange={(v) => updateTicket.mutate({id: selectedTicket.id, updates: {priority: v}, ticket: selectedTicket})}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="emergency">Emergency</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs text-zinc-500">Assign To</label>
                    <Input
                      placeholder="Staff name"
                      defaultValue={selectedTicket.assigned_to || ''}
                      onBlur={(e) => {
                        if (e.target.value !== selectedTicket.assigned_to) {
                          updateTicket.mutate({id: selectedTicket.id, updates: {assigned_to: e.target.value}, ticket: selectedTicket});
                        }
                      }}
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs text-zinc-500">Schedule For</label>
                    <Input
                      type="datetime-local"
                      defaultValue={selectedTicket.scheduled_for ? format(new Date(selectedTicket.scheduled_for), "yyyy-MM-dd'T'HH:mm") : ''}
                      onBlur={(e) => {
                        if (e.target.value) {
                          updateTicket.mutate({id: selectedTicket.id, updates: {scheduled_for: new Date(e.target.value).toISOString()}, ticket: selectedTicket});
                        }
                      }}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                   <label className="text-xs text-zinc-500 font-medium">Internal Notes</label>
                   <div className="space-y-3 bg-zinc-50 p-3 rounded-lg max-h-64 overflow-y-auto mb-3">
                     {notes && notes.length > 0 ? (
                       notes.map(note => (
                         <div key={note.id} className="bg-white p-3 rounded border border-zinc-200">
                           <div className="flex justify-between items-start mb-1">
                             <span className="text-xs font-medium text-zinc-700">{note.created_by_name}</span>
                             <span className="text-xs text-zinc-400">{format(new Date(note.created_date), 'MMM d, h:mm a')}</span>
                           </div>
                           <p className="text-sm text-zinc-700 leading-relaxed">{note.content}</p>
                         </div>
                       ))
                     ) : (
                       <p className="text-xs text-zinc-400 italic">No notes yet</p>
                     )}
                   </div>
                   <div className="flex gap-2">
                     <Textarea
                       placeholder="Add a new note..."
                       value={newNoteContent}
                       onChange={(e) => setNewNoteContent(e.target.value)}
                       className="text-sm resize-none h-20"
                     />
                     <Button
                       size="icon"
                       onClick={() => {
                         if (newNoteContent.trim()) {
                           addNoteMutation.mutate(newNoteContent.trim());
                         }
                       }}
                       disabled={!newNoteContent.trim() || addNoteMutation.isPending}
                       className="self-end"
                     >
                       <Send className="w-4 h-4" />
                     </Button>
                   </div>
                 </div>

                <div className="pt-2 border-t flex justify-end">
                  {selectedTicket.is_archived ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => archiveTicket.mutate({ id: selectedTicket.id, archive: false })}
                      disabled={archiveTicket.isPending}
                    >
                      <ArchiveRestore className="w-4 h-4 mr-2" /> Restore from Archive
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-zinc-600 hover:bg-zinc-100"
                      onClick={() => archiveTicket.mutate({ id: selectedTicket.id, archive: true })}
                      disabled={archiveTicket.isPending}
                    >
                      <Archive className="w-4 h-4 mr-2" /> Archive Ticket
                    </Button>
                  )}
                </div>

                <div className="space-y-2">
                   <label className="text-xs text-zinc-500">Resolution Notes (visible to resident)</label>
                  <Textarea
                    placeholder="How was this resolved?"
                    defaultValue={selectedTicket.resolution_notes || ''}
                    onBlur={(e) => {
                      if (e.target.value !== selectedTicket.resolution_notes) {
                        updateTicket.mutate({id: selectedTicket.id, updates: {resolution_notes: e.target.value}, ticket: selectedTicket});
                      }
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

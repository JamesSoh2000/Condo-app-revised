import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Wrench, Plus, Image as ImageIcon, Calendar, Clock } from 'lucide-react';
import { toast } from "sonner";
import { format } from 'date-fns';

export default function Maintenance() {
  const [isNewOpen, setIsNewOpen] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [ticket, setTicket] = useState({
    type: 'unit',
    title: '',
    description: '',
    priority: 'medium'
  });
  
  const queryClient = useQueryClient();
  const { data: user } = useQuery({ queryKey: ['me'], queryFn: () => base44.auth.me() });

  const { data: profile } = useQuery({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const profiles = await base44.entities.Profile.filter({ userId: user.id });
      return profiles[0] || null;
    },
    enabled: !!user?.id
  });

  const { data: tickets } = useQuery({
    queryKey: ['my-tickets', user?.id],
    queryFn: () => {
      if (!user?.id) return [];
      return base44.entities.MaintenanceTicket.filter({ resident_user_id: user.id }, '-created_date', 100);
    },
    enabled: !!user?.id
  });

  const createMutation = useMutation({
    mutationFn: async (data) => {
        const ticketData = {
          ...data,
          resident_user_id: user.id,
          unit_number: profile?.unit_number || user.unit_number,
          status: 'submitted'
        };
        
        const newTicket = await base44.entities.MaintenanceTicket.create(ticketData);
        
        // Create notification
        await base44.entities.Notification.create({
            title: 'New Maintenance Request',
            message: `${data.priority.toUpperCase()} priority: ${data.title} (${data.type})`,
            type: 'maintenance',
            target_role: 'property_management',
            link: 'ManagementMaintenance'
        });
        
        return newTicket;
    },
    onMutate: async (data) => {
      await queryClient.cancelQueries(['my-tickets']);
      const previous = queryClient.getQueryData(['my-tickets', user?.id]);
      const optimistic = {
        id: `optimistic-${Date.now()}`,
        ...data,
        resident_user_id: user?.id,
        unit_number: profile?.unit_number || user?.unit_number,
        status: 'submitted',
        created_date: new Date().toISOString(),
      };
      queryClient.setQueryData(['my-tickets', user?.id], old => [optimistic, ...(old || [])]);
      return { previous };
    },
    onError: (_err, _data, context) => {
      if (context?.previous) queryClient.setQueryData(['my-tickets', user?.id], context.previous);
      toast.error("Failed to submit request");
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['my-tickets']);
      toast.success("Request submitted successfully");
      setIsNewOpen(false);
      setTicket({ type: 'unit', title: '', description: '', priority: 'medium' });
    }
  });

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Maintenance</h1>
        <Button onClick={() => setIsNewOpen(!isNewOpen)} className="bg-zinc-900 text-white">
            {isNewOpen ? 'Cancel' : 'New Request'}
        </Button>
      </div>

      {isNewOpen && (
        <Card className="border-zinc-200 shadow-lg animate-in slide-in-from-top-4 fade-in">
            <CardHeader>
                <CardTitle className="text-lg">Submit Request</CardTitle>
            </CardHeader>
            <CardContent>
                <div className="space-y-4">
                    <div className="grid md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Problem Type</label>
                            <Select value={ticket.type} onValueChange={v => setTicket({...ticket, type: v})}>
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="unit">My Unit</SelectItem>
                                    <SelectItem value="common_area">Common Area</SelectItem>
                                    <SelectItem value="building">Building Exterior</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">Priority</label>
                             <Select value={ticket.priority} onValueChange={v => setTicket({...ticket, priority: v})}>
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="low">Low</SelectItem>
                                    <SelectItem value="medium">Medium</SelectItem>
                                    <SelectItem value="high">High</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <div className="space-y-2">
                        <label className="text-sm font-medium">Title</label>
                        <Input 
                            placeholder="Brief summary (e.g. Leaky faucet)" 
                            value={ticket.title} 
                            onChange={e => setTicket({...ticket, title: e.target.value})}
                        />
                    </div>
                     <div className="space-y-2">
                        <label className="text-sm font-medium">Description</label>
                        <Textarea 
                            placeholder="Details about the issue..." 
                            value={ticket.description} 
                            onChange={e => setTicket({...ticket, description: e.target.value})}
                        />
                    </div>
                    <Button className="w-full" onClick={() => createMutation.mutate(ticket)} disabled={createMutation.isPending}>
                        Submit
                    </Button>
                </div>
            </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Request History</CardTitle>
        </CardHeader>
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Issue</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {tickets?.map(t => (
                    <TableRow key={t.id} className="cursor-pointer hover:bg-zinc-50" onClick={() => setSelectedTicket(t)}>
                        <TableCell className="text-zinc-500 text-xs">
                            {format(new Date(t.created_date), 'MMM d, yyyy')}
                        </TableCell>
                        <TableCell className="font-medium">{t.title}</TableCell>
                        <TableCell className="capitalize text-zinc-500">{t.type.replace('_', ' ')}</TableCell>
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
                    </TableRow>
                ))}
                 {(!tickets || tickets.length === 0) && (
                    <TableRow>
                        <TableCell colSpan={5} className="text-center py-8 text-zinc-400">No requests history.</TableCell>
                    </TableRow>
                )}
            </TableBody>
        </Table>
      </Card>

      <Dialog open={!!selectedTicket} onOpenChange={() => setSelectedTicket(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Request Details</DialogTitle>
          </DialogHeader>
          {selectedTicket && (
            <div className="space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-semibold">{selectedTicket.title}</h3>
                  <p className="text-sm text-zinc-500 capitalize">{selectedTicket.type.replace('_', ' ')}</p>
                </div>
                <Badge className="capitalize">{selectedTicket.status.replace('_', ' ')}</Badge>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="text-xs text-zinc-500">Submitted</p>
                  <p className="text-sm font-medium flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {format(new Date(selectedTicket.created_date), 'MMM d, yyyy h:mm a')}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-zinc-500">Priority</p>
                  <Badge variant={selectedTicket.priority === 'high' || selectedTicket.priority === 'emergency' ? 'destructive' : 'outline'} className="capitalize">
                    {selectedTicket.priority}
                  </Badge>
                </div>
                {selectedTicket.scheduled_for && (
                  <div className="space-y-1">
                    <p className="text-xs text-zinc-500">Scheduled For</p>
                    <p className="text-sm font-medium flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {format(new Date(selectedTicket.scheduled_for), 'MMM d, yyyy h:mm a')}
                    </p>
                  </div>
                )}
                {selectedTicket.assigned_to && (
                  <div className="space-y-1">
                    <p className="text-xs text-zinc-500">Assigned To</p>
                    <p className="text-sm font-medium">{selectedTicket.assigned_to}</p>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-xs text-zinc-500">Description</p>
                <p className="text-sm text-zinc-700 leading-relaxed">{selectedTicket.description}</p>
              </div>

              {selectedTicket.resolution_notes && (
                <div className="space-y-2 bg-green-50 p-4 rounded-lg border border-green-200">
                  <p className="text-xs text-green-700 font-medium">Resolution Notes</p>
                  <p className="text-sm text-green-900">{selectedTicket.resolution_notes}</p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
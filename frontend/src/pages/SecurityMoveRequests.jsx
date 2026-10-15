import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { Truck, Calendar, Clock, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';

export default function SecurityMoveRequests() {
  const [user, setUser] = useState(null);
  const [declineModalOpen, setDeclineModalOpen] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [declineReason, setDeclineReason] = useState('');
  const queryClient = useQueryClient();

  React.useEffect(() => {
    const loadUser = async () => {
      const currentUser = await base44.auth.me();
      setUser(currentUser);
    };
    loadUser();
  }, []);

  // Mark all pending requests as viewed when page loads
  React.useEffect(() => {
    const markAsViewed = async () => {
      if (!user) return;

      const role = user.management_role || user.app_role;
      const isBoard = user.isAdmin || role === 'board';

      // Determine which field to update based on role
      let viewedField = null;
      let viewedAtField = null;

      if (role === 'security' || (isBoard && user.activeViewRole === 'security')) {
        viewedField = 'viewed_by_security';
        viewedAtField = 'viewed_by_security_at';
      } else if (role === 'property_management' || (isBoard && user.activeViewRole === 'property_management')) {
        viewedField = 'viewed_by_management';
        viewedAtField = 'viewed_by_management_at';
      }

      if (!viewedField) return;

      // Fetch all pending unviewed requests
      const allRequests = await base44.entities.MoveRequest.filter({ status: 'pending' });
      const unviewedRequests = allRequests.filter(r => !r[viewedField]);

      // Mark them all as viewed
      const updatePromises = unviewedRequests.map(request =>
        base44.entities.MoveRequest.update(request.id, {
          [viewedField]: true,
          [viewedAtField]: new Date().toISOString()
        })
      );

      await Promise.all(updatePromises);

      // Refresh the list
      if (updatePromises.length > 0) {
        queryClient.invalidateQueries({ queryKey: ['move-requests'] });
      }
    };

    markAsViewed();
  }, [user, queryClient]);

  const { data: requests, isLoading } = useQuery({
    queryKey: ['move-requests'],
    queryFn: async () => {
      return await base44.entities.MoveRequest.list('-created_date', 100);
    },
    refetchInterval: 5000
  });

  const approveMutation = useMutation({
    mutationFn: async (request) => {
      await base44.entities.MoveRequest.update(request.id, {
        status: 'approved',
        reviewedByUserId: user.id,
        reviewedByName: user.full_name,
        reviewedAt: new Date().toISOString()
      });

      // Notify resident
      await base44.entities.Notification.create({
        title: 'Move Request Approved',
        message: `Your ${request.requestType === 'move_in' ? 'Move In' : 'Move Out'} request for ${format(new Date(request.date + 'T00:00:00'), 'MMM d, yyyy')} has been approved.`,
        type: 'amenity',
        target_user_id: request.residentUserId
      });
    },
    onSuccess: () => {
      toast.success('Request approved');
      queryClient.invalidateQueries({ queryKey: ['move-requests'] });
    }
  });

  const declineMutation = useMutation({
    mutationFn: async ({ request, reason }) => {
      await base44.entities.MoveRequest.update(request.id, {
        status: 'declined',
        declineReason: reason,
        reviewedByUserId: user.id,
        reviewedByName: user.full_name,
        reviewedAt: new Date().toISOString()
      });

      // Notify resident
      await base44.entities.Notification.create({
        title: 'Move Request Declined',
        message: `Your ${request.requestType === 'move_in' ? 'Move In' : 'Move Out'} request for ${format(new Date(request.date + 'T00:00:00'), 'MMM d, yyyy')} has been declined. Reason: ${reason}`,
        type: 'amenity',
        target_user_id: request.residentUserId
      });
    },
    onSuccess: () => {
      toast.success('Request declined');
      setDeclineModalOpen(false);
      setDeclineReason('');
      setSelectedRequest(null);
      queryClient.invalidateQueries({ queryKey: ['move-requests'] });
    }
  });

  const handleDeclineClick = (request) => {
    setSelectedRequest(request);
    setDeclineModalOpen(true);
  };

  const handleDeclineConfirm = () => {
    if (!declineReason.trim()) {
      toast.error('Please provide a reason for declining');
      return;
    }
    declineMutation.mutate({ request: selectedRequest, reason: declineReason });
  };

  const getStatusBadge = (status) => {
    const config = {
      pending: { label: 'Pending', className: 'bg-yellow-100 text-yellow-700' },
      approved: { label: 'Approved', className: 'bg-green-100 text-green-700' },
      declined: { label: 'Declined', className: 'bg-red-100 text-red-700' }
    };
    const statusConfig = config[status] || config['pending'];
    return <Badge className={statusConfig.className}>{statusConfig.label}</Badge>;
  };

  const pendingRequests = requests?.filter(r => r.status === 'pending') || [];
  const reviewedRequests = requests?.filter(r => r.status !== 'pending') || [];

  if (!user) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Move Requests</h1>
          <p className="text-zinc-500 mt-2">Review and approve move in/out requests</p>
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={() => queryClient.invalidateQueries({ queryKey: ['move-requests'] })}
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Truck className="w-5 h-5" />
            Pending Requests
            {pendingRequests.length > 0 && (
              <Badge variant="outline">{pendingRequests.length}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-zinc-500 text-center py-8">Loading...</p>
          ) : pendingRequests.length === 0 ? (
            <p className="text-zinc-400 text-center py-8">No pending requests</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resident</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Purpose</TableHead>
                  <TableHead>Date & Time</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingRequests.map((request) => (
                  <TableRow key={request.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{request.residentName}</p>
                        <p className="text-xs text-zinc-500">
                          Unit {request.unitNumber} • Tower {request.tower}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      {request.requestType === 'move_in' ? 'Move In' : 'Move Out'}
                    </TableCell>
                    <TableCell>
                      <p className="text-sm text-zinc-700 max-w-xs">
                        {request.purpose ?
                          request.purpose.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
                          : '-'}
                      </p>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {format(new Date(request.date + 'T00:00:00'), 'MMM d, yyyy')}
                        </div>
                        <div className="flex items-center gap-1 text-zinc-500">
                          <Clock className="w-3 h-3" />
                          {request.startTime} - {request.endTime}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <p className="text-xs text-zinc-600 max-w-xs truncate">
                        {request.notes || '-'}
                      </p>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => approveMutation.mutate(request)}
                          disabled={approveMutation.isPending}
                        >
                          <CheckCircle2 className="w-4 h-4 mr-1" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDeclineClick(request)}
                          disabled={declineMutation.isPending}
                        >
                          <XCircle className="w-4 h-4 mr-1" />
                          Decline
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reviewed Requests</CardTitle>
        </CardHeader>
        <CardContent>
          {reviewedRequests.length === 0 ? (
            <p className="text-zinc-400 text-center py-8">No reviewed requests</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Resident</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Purpose</TableHead>
                  <TableHead>Date & Time</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reviewed By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reviewedRequests.slice(0, 20).map((request) => (
                  <TableRow key={request.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{request.residentName}</p>
                        <p className="text-xs text-zinc-500">Unit {request.unitNumber}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      {request.requestType === 'move_in' ? 'Move In' : 'Move Out'}
                    </TableCell>
                    <TableCell>
                      <p className="text-sm text-zinc-700 max-w-xs">
                        {request.purpose ?
                          request.purpose.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
                          : '-'}
                      </p>
                    </TableCell>
                    <TableCell className="text-sm">
                      {format(new Date(request.date + 'T00:00:00'), 'MMM d, yyyy')}
                      <br />
                      <span className="text-xs text-zinc-500">
                        {request.startTime} - {request.endTime}
                      </span>
                    </TableCell>
                    <TableCell>{getStatusBadge(request.status)}</TableCell>
                    <TableCell className="text-sm text-zinc-600">
                      {request.reviewedByName || '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={declineModalOpen} onOpenChange={setDeclineModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Decline Move Request</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Reason for Decline *</Label>
              <Textarea
                placeholder="Please explain why this request cannot be approved (e.g., scheduling conflict, maintenance, policy restriction)."
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeclineModalOpen(false);
                setDeclineReason('');
                setSelectedRequest(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleDeclineConfirm}
              disabled={!declineReason.trim() || declineMutation.isPending}
            >
              Confirm Decline
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

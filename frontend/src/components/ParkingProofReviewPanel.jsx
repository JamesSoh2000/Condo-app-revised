import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Car, FileText, ExternalLink, CheckCircle, XCircle, Clock, User, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';

function StatusBadge({ status }) {
  if (status === 'pending') return <Badge className="bg-amber-100 text-amber-800 border-amber-200"><Clock className="w-3 h-3 mr-1" />Pending</Badge>;
  if (status === 'approved') return <Badge className="bg-green-100 text-green-800 border-green-200"><CheckCircle className="w-3 h-3 mr-1" />Approved</Badge>;
  if (status === 'rejected') return <Badge className="bg-red-100 text-red-800 border-red-200"><XCircle className="w-3 h-3 mr-1" />Rejected</Badge>;
  return null;
}

export default function ParkingProofReviewPanel() {
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const queryClient = useQueryClient();

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ['parking-proof-requests-management'],
    queryFn: async () => {
      return await base44.entities.ParkingProofRequest.list('-created_date', 100);
    },
    refetchInterval: 30000
  });

  const pendingRequests = requests.filter(r => r.status === 'pending');
  const reviewedRequests = requests.filter(r => r.status !== 'pending');

  const approveMutation = useMutation({
    mutationFn: async (request) => {
      const reviewer = await base44.auth.me();

      // Update the request
      await base44.entities.ParkingProofRequest.update(request.id, {
        status: 'approved',
        reviewed_by_user_id: reviewer.id,
        reviewed_by_name: reviewer.full_name,
        reviewed_at: new Date().toISOString(),
        internal_note: internalNote
      });

      // Update parking spot on Profile
      const profiles = await base44.entities.Profile.filter({ userId: request.resident_user_id });
      if (profiles.length > 0) {
        const profile = profiles[0];
        const updatedVehicles = (profile.vehicles || []).map((v, i) =>
          i === 0 ? { ...v, parking_spot: request.requested_parking_spot } : v
        );
        // If no vehicles, just update parking_spot field directly
        await base44.entities.Profile.update(profile.id, {
          vehicles: updatedVehicles.length > 0 ? updatedVehicles : profile.vehicles,
          parking_spot: request.requested_parking_spot
        });
      }

      // Notify resident
      await base44.entities.Notification.create({
        title: 'Parking Space Request Approved',
        message: `Your parking space verification request for spot ${request.requested_parking_spot} has been approved. Your account has been updated.`,
        type: 'announcement',
        target_user_id: request.resident_user_id
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['parking-proof-requests-management'] });
      toast.success('Parking request approved and resident profile updated.');
      setDetailOpen(false);
      setSelectedRequest(null);
      setInternalNote('');
    },
    onError: (err) => toast.error('Failed to approve: ' + err.message)
  });

  const rejectMutation = useMutation({
    mutationFn: async (request) => {
      const reviewer = await base44.auth.me();

      await base44.entities.ParkingProofRequest.update(request.id, {
        status: 'rejected',
        reviewed_by_user_id: reviewer.id,
        reviewed_by_name: reviewer.full_name,
        reviewed_at: new Date().toISOString(),
        rejection_reason: rejectionReason,
        internal_note: internalNote
      });

      // Notify resident
      await base44.entities.Notification.create({
        title: 'Parking Space Request Rejected',
        message: `Your parking space verification request for spot ${request.requested_parking_spot} was not approved. Reason: ${rejectionReason}`,
        type: 'announcement',
        target_user_id: request.resident_user_id
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['parking-proof-requests-management'] });
      toast.success('Parking request rejected.');
      setRejectDialogOpen(false);
      setDetailOpen(false);
      setSelectedRequest(null);
      setRejectionReason('');
      setInternalNote('');
    },
    onError: (err) => toast.error('Failed to reject: ' + err.message)
  });

  const openDetail = (req) => {
    setSelectedRequest(req);
    setInternalNote(req.internal_note || '');
    setDetailOpen(true);
  };

  if (isLoading) {
    return <div className="text-center py-8 text-zinc-400">Loading parking requests...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Car className="w-5 h-5 text-zinc-600" />
        <h2 className="text-xl font-bold">Parking Space Verification Requests</h2>
        {pendingRequests.length > 0 && (
          <Badge className="bg-amber-500 text-white">{pendingRequests.length} pending</Badge>
        )}
      </div>

      {/* Pending */}
      {pendingRequests.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-amber-700 uppercase tracking-wider">Pending Review</p>
          {pendingRequests.map(req => (
            <Card key={req.id} className="border-amber-200 bg-amber-50/40 cursor-pointer hover:shadow-md transition-shadow" onClick={() => openDetail(req)}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <User className="w-4 h-4 text-zinc-400" />
                      <span className="font-semibold">{req.resident_name}</span>
                      <span className="text-zinc-400 text-sm">Unit {req.unit_number}</span>
                      {req.tower && <Badge variant="outline" className="text-xs">{req.tower}</Badge>}
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <span className="text-zinc-500">Current: <strong>{req.current_parking_spot || 'None'}</strong></span>
                      <span className="text-zinc-900">→ Requested: <strong className="text-blue-700">{req.requested_parking_spot}</strong></span>
                    </div>
                    <p className="text-xs text-zinc-400">Submitted {format(new Date(req.created_date), 'MMM d, yyyy h:mm a')}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={req.status} />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Reviewed history */}
      {reviewedRequests.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">History</p>
          {reviewedRequests.map(req => (
            <Card key={req.id} className="cursor-pointer hover:shadow-sm transition-shadow" onClick={() => openDetail(req)}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{req.resident_name}</span>
                      <span className="text-zinc-400 text-sm">Unit {req.unit_number}</span>
                    </div>
                    <div className="text-sm text-zinc-500">
                      {req.current_parking_spot || 'None'} → <strong>{req.requested_parking_spot}</strong>
                    </div>
                    <p className="text-xs text-zinc-400">Reviewed {req.reviewed_at ? format(new Date(req.reviewed_at), 'MMM d, yyyy') : '—'} by {req.reviewed_by_name || '—'}</p>
                  </div>
                  <StatusBadge status={req.status} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {requests.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="p-8 text-center text-zinc-400">
            <Car className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p>No parking verification requests yet.</p>
          </CardContent>
        </Card>
      )}

      {/* Detail Dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Car className="w-5 h-5" /> Parking Verification Request
            </DialogTitle>
          </DialogHeader>
          {selectedRequest && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-zinc-500">Resident</p>
                  <p className="font-semibold">{selectedRequest.resident_name}</p>
                </div>
                <div>
                  <p className="text-zinc-500">Unit</p>
                  <p className="font-semibold">{selectedRequest.unit_number} {selectedRequest.tower && <span className="ml-1 px-1.5 py-0.5 bg-zinc-100 rounded text-xs font-bold">{selectedRequest.tower}</span>}</p>
                </div>
                <div>
                  <p className="text-zinc-500">Current Parking</p>
                  <p className="font-semibold">{selectedRequest.current_parking_spot || 'None on file'}</p>
                </div>
                <div>
                  <p className="text-zinc-500">Requested Spot</p>
                  <p className="font-bold text-blue-700">{selectedRequest.requested_parking_spot}</p>
                </div>
                <div>
                  <p className="text-zinc-500">Submitted</p>
                  <p className="font-medium">{format(new Date(selectedRequest.created_date), 'MMM d, yyyy h:mm a')}</p>
                </div>
                <div>
                  <p className="text-zinc-500">Status</p>
                  <StatusBadge status={selectedRequest.status} />
                </div>
              </div>

              {selectedRequest.resident_note && (
                <div className="p-3 bg-zinc-50 rounded-lg">
                  <p className="text-xs text-zinc-500 mb-1">Resident Note</p>
                  <p className="text-sm">{selectedRequest.resident_note}</p>
                </div>
              )}

              {selectedRequest.proof_document_url && (
                <a
                  href={selectedRequest.proof_document_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 p-3 border border-blue-200 bg-blue-50 rounded-lg text-blue-700 hover:bg-blue-100 transition-colors"
                >
                  <FileText className="w-5 h-5" />
                  <div className="flex-1">
                    <p className="text-sm font-semibold">View Proof Document</p>
                    <p className="text-xs opacity-70">{selectedRequest.proof_document_name || 'Proof file'}</p>
                  </div>
                  <ExternalLink className="w-4 h-4" />
                </a>
              )}

              {selectedRequest.status === 'rejected' && selectedRequest.rejection_reason && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-xs font-semibold text-red-700 mb-1">Rejection Reason</p>
                  <p className="text-sm text-red-800">{selectedRequest.rejection_reason}</p>
                </div>
              )}

              {selectedRequest.status === 'pending' && (
                <>
                  <div>
                    <p className="text-sm font-medium mb-1">Internal Note (Optional)</p>
                    <Textarea
                      placeholder="Add an internal note..."
                      value={internalNote}
                      onChange={(e) => setInternalNote(e.target.value)}
                      rows={2}
                      className="resize-none"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      className="flex-1"
                      onClick={() => { setRejectDialogOpen(true); setDetailOpen(false); }}
                    >
                      <XCircle className="w-4 h-4 mr-2" /> Reject
                    </Button>
                    <Button
                      className="flex-1 bg-green-600 hover:bg-green-700"
                      onClick={() => approveMutation.mutate(selectedRequest)}
                      disabled={approveMutation.isPending}
                    >
                      <CheckCircle className="w-4 h-4 mr-2" />
                      {approveMutation.isPending ? 'Approving...' : 'Approve'}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-red-500" /> Reject Parking Request
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-zinc-600">Please provide a reason for rejecting this parking verification request.</p>
            <Textarea
              placeholder="Rejection reason (visible to resident)..."
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRejectDialogOpen(false); setDetailOpen(true); }}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => rejectMutation.mutate(selectedRequest)}
              disabled={!rejectionReason.trim() || rejectMutation.isPending}
            >
              {rejectMutation.isPending ? 'Rejecting...' : 'Confirm Rejection'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
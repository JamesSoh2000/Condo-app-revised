import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Users, Search, CheckCircle, XCircle, FileText, Car, Home, Calendar, AlertCircle, Edit, Trash2, Trash } from 'lucide-react';
import ParkingProofReviewPanel from '@/components/ParkingProofReviewPanel';
import { toast } from 'sonner';
import { format } from 'date-fns';
import ManagementEditDialog from '@/components/ManagementEditDialog';
import SecureDocumentViewer from '@/components/SecureDocumentViewer';

export default function ResidentsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState('all'); // 'all', 'pending', 'approved', or 'parking'
  const [selectedResident, setSelectedResident] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [pendingActionResident, setPendingActionResident] = useState(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingResident, setEditingResident] = useState(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [permDeleteDialogOpen, setPermDeleteDialogOpen] = useState(false);
  const [pendingDeleteResident, setPendingDeleteResident] = useState(null);
  const [docViewer, setDocViewer] = useState({ open: false, url: null, label: null });
  const queryClient = useQueryClient();

  // Fetch approved residents from Profile
  const { data: approvedProfiles = [] } = useQuery({
    queryKey: ['approved-residents'],
    queryFn: async () => {
      const profiles = await base44.entities.Profile.list('-created_date', 500);
      return profiles;
    }
  });

  // Fetch pending residents from ResidentProfile
  const { data: pendingResidents = [] } = useQuery({
    queryKey: ['pending-residents'],
    queryFn: async () => {
      const pending = await base44.entities.ResidentProfile.list('-created_date', 200);
      return pending;
    }
  });

  const approveMutation = useMutation({
    mutationFn: async (residentId) => {
      console.log('[APPROVAL] Starting approval for ResidentProfile ID:', residentId);
      const user = await base44.auth.me();
      const residentProfile = await base44.entities.ResidentProfile.filter({ id: residentId });

      if (residentProfile.length === 0) {
        throw new Error('ResidentProfile not found');
      }

      const resident = residentProfile[0];
      console.log('[APPROVAL] ResidentProfile found:', {
        id: resident.id,
        user_id: resident.user_id,
        unit_id: resident.unit_id,
        full_name: resident.full_name,
        unit_number: resident.unit_number
      });

      // Update ResidentProfile to approved
      await base44.entities.ResidentProfile.update(residentId, {
        status: 'approved',
        approved_by: user.id,
        approved_at: new Date().toISOString()
      });
      console.log('[APPROVAL] ResidentProfile updated to approved');

      // Check if Profile already exists
      const existingProfiles = await base44.entities.Profile.filter({ userId: resident.user_id });
      if (existingProfiles.length > 0) {
        console.log('[APPROVAL] Profile already exists, skipping creation');
        return { success: true, profileExists: true };
      }

      // Create Profile record (this is what My Packages looks for)
      const newProfile = await base44.entities.Profile.create({
        userId: resident.user_id,
        unit_id: resident.unit_id,
        full_name: resident.full_name,
        unit_number: resident.unit_number,
        move_in_date: resident.move_in_date || '',
        parking_spot: resident.parking_spot || '',
        vehicles: resident.vehicles || [],
        lease_document_url: resident.lease_document_url || '',
        insurance_info_url: resident.insurance_document_url || ''
      });

      console.log('[APPROVAL] Profile created:', {
        id: newProfile.id,
        userId: newProfile.userId,
        unit_id: newProfile.unit_id,
        full_name: newProfile.full_name
      });

      return { success: true, profileCreated: true };
    },
    onSuccess: (result) => {
      console.log('[APPROVAL] Success, invalidating queries...');
      queryClient.invalidateQueries({ queryKey: ['pending-residents'] });
      queryClient.invalidateQueries({ queryKey: ['approved-residents'] });
      toast.success('Resident approved and profile created');
      setDrawerOpen(false);
    },
    onError: (error) => {
      console.error('[APPROVAL] Error:', error);
      toast.error('Failed to approve resident: ' + error.message);
    }
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ residentId, reason }) => {
      const user = await base44.auth.me();
      return await base44.entities.ResidentProfile.update(residentId, {
        status: 'rejected',
        rejected_by: user.id,
        rejected_at: new Date().toISOString(),
        rejection_reason: reason
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pending-residents'] });
      toast.success('Resident rejected');
      setRejectDialogOpen(false);
      setDrawerOpen(false);
      setPendingActionResident(null);
      setRejectReason('');
    }
  });

  const allPendingMapped = pendingResidents.map(r => ({ ...r, isPending: r.status === 'pending_approval', isApproved: r.status === 'approved' }));
  const allApprovedMapped = approvedProfiles.map(p => ({ ...p, isPending: false, isApproved: true }));

  // Single source of truth for true pending count (not deleted, not approved, not rejected)
  const truePendingCount = allPendingMapped.filter(r => !r.is_deleted && r.isPending).length;

  const allResidents = viewMode === 'trash'
    ? [
        ...allApprovedMapped.filter(r => r.is_deleted),
        ...allPendingMapped.filter(r => r.is_deleted)
      ]
    : viewMode === 'pending'
    ? allPendingMapped.filter(r => !r.is_deleted && r.isPending)
    : viewMode === 'approved'
    ? allApprovedMapped.filter(r => !r.is_deleted)
    : [
        ...allApprovedMapped.filter(r => !r.is_deleted),
        ...allPendingMapped.filter(r => !r.is_deleted)
      ];

  const filteredResidents = allResidents
    .filter(r => {
      const query = searchQuery.toLowerCase();
      return (
        r.full_name?.toLowerCase().includes(query) ||
        r.unit_number?.toLowerCase().includes(query) ||
        r.vehicles?.some(v => v.plate_number?.toLowerCase().includes(query))
      );
    })
    .sort((a, b) => new Date(b.created_date || 0) - new Date(a.created_date || 0));

  const trashedCount = [
    ...allApprovedMapped.filter(r => r.is_deleted),
    ...allPendingMapped.filter(r => r.is_deleted)
  ].length;

  const handleApprove = (resident) => {
    approveMutation.mutate(resident.id);
  };

  const handleReject = (resident) => {
    setPendingActionResident(resident);
    setRejectDialogOpen(true);
  };

  const submitRejection = () => {
    if (pendingActionResident) {
      rejectMutation.mutate({
        residentId: pendingActionResident.id,
        reason: rejectReason
      });
    }
  };

  const softDeleteMutation = useMutation({
    mutationFn: async ({ id, isProfile }) => {
      if (isProfile) {
        return await base44.entities.Profile.update(id, { is_deleted: true, deleted_at: new Date().toISOString() });
      } else {
        return await base44.entities.ResidentProfile.update(id, { is_deleted: true, deleted_at: new Date().toISOString() });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['approved-residents'] });
      queryClient.invalidateQueries({ queryKey: ['pending-residents'] });
      toast.success('Item moved to trash');
      setDeleteDialogOpen(false);
      setDrawerOpen(false);
      setPendingDeleteResident(null);
    }
  });

  const restoreMutation = useMutation({
    mutationFn: async ({ id, isProfile }) => {
      if (isProfile) {
        return await base44.entities.Profile.update(id, { is_deleted: false, deleted_at: null });
      } else {
        return await base44.entities.ResidentProfile.update(id, { is_deleted: false, deleted_at: null });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['approved-residents'] });
      queryClient.invalidateQueries({ queryKey: ['pending-residents'] });
      toast.success('Item restored');
    }
  });

  const permDeleteMutation = useMutation({
    mutationFn: async ({ id, isProfile }) => {
      if (isProfile) {
        return await base44.entities.Profile.delete(id);
      } else {
        return await base44.entities.ResidentProfile.delete(id);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['approved-residents'] });
      queryClient.invalidateQueries({ queryKey: ['pending-residents'] });
      toast.success('Item permanently deleted');
      setPermDeleteDialogOpen(false);
      setPendingDeleteResident(null);
    }
  });

  const editMutation = useMutation({
    mutationFn: async ({ residentId, data, isProfile }) => {
      if (isProfile) {
        return await base44.entities.Profile.update(residentId, data);
      } else {
        return await base44.entities.ResidentProfile.update(residentId, data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['approved-residents'] });
      queryClient.invalidateQueries({ queryKey: ['pending-residents'] });
      toast.success('Resident updated');
      setEditDialogOpen(false);
      setDrawerOpen(false);
    }
  });

  const handleEdit = (resident) => {
    setEditingResident(resident);
    setEditDialogOpen(true);
  };

  const handleSaveEdit = (data) => {
    if (editingResident) {
      editMutation.mutate({
        residentId: editingResident.id,
        data,
        isProfile: editingResident.isApproved
      });
    }
  };

  const openDetails = (resident) => {
    setSelectedResident(resident);
    setDrawerOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-zinc-900 flex items-center gap-2">
            <Users className="w-8 h-8" />
            Residents
          </h1>
          <p className="text-zinc-500 mt-1">View and manage resident information</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={viewMode === 'all' ? 'default' : 'outline'}
            onClick={() => setViewMode('all')}
          >
            All
            <Badge className="ml-2 bg-zinc-500">{allApprovedMapped.filter(r => !r.is_deleted).length + allPendingMapped.filter(r => !r.is_deleted).length}</Badge>
          </Button>
          <Button
            variant={viewMode === 'approved' ? 'default' : 'outline'}
            onClick={() => setViewMode('approved')}
          >
            Approved
            <Badge className="ml-2 bg-green-600">{approvedProfiles.length}</Badge>
          </Button>
          <Button
            variant={viewMode === 'pending' ? 'default' : 'outline'}
            onClick={() => setViewMode('pending')}
          >
            Pending
            {truePendingCount > 0 && (
              <Badge className="ml-2 bg-amber-500">{truePendingCount}</Badge>
            )}
          </Button>
          <Button
            variant={viewMode === 'parking' ? 'default' : 'outline'}
            onClick={() => setViewMode('parking')}
          >
            <Car className="w-4 h-4 mr-1" />
            Parking Requests
          </Button>
          <Button
            variant={viewMode === 'trash' ? 'default' : 'outline'}
            onClick={() => setViewMode('trash')}
            className={viewMode !== 'trash' ? 'text-zinc-500' : ''}
          >
            <Trash className="w-4 h-4 mr-1" />
            Trash
            {trashedCount > 0 && (
              <Badge className="ml-2 bg-zinc-400">{trashedCount}</Badge>
            )}
          </Button>
        </div>
      </div>

      {viewMode === 'parking' && <ParkingProofReviewPanel />}

      {viewMode !== 'parking' && (<Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Search className="w-4 h-4 text-zinc-400" />
            <Input
              placeholder="Search by name, unit, or plate number..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1"
            />
          </div>

          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Unit</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Move-in Date</TableHead>
                  <TableHead>Parking</TableHead>
                  <TableHead>Vehicles</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date Received</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredResidents.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-zinc-400">
                      No residents found
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredResidents.map((resident) => (
                    <TableRow
                      key={resident.id}
                      className="cursor-pointer hover:bg-zinc-50"
                      onClick={() => openDetails(resident)}
                    >
                      <TableCell className="font-medium">
                        {resident.unit_number}
                        {resident.unit_number && (
                          <span className="ml-1 px-1.5 py-0.5 bg-zinc-100 text-zinc-700 rounded text-xs font-bold">
                            {resident.unit_number.toString().startsWith('1') ? 'E' : 'W'}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>{resident.full_name}</TableCell>
                      <TableCell>
                        {resident.move_in_date ? format(new Date(resident.move_in_date), 'MMM d, yyyy') : '—'}
                      </TableCell>
                      <TableCell>
                        {resident.parking_spot || resident.vehicles?.[0]?.parking_spot || '—'}
                      </TableCell>
                      <TableCell>
                        {resident.vehicles?.length > 0 ? (
                          <span className="text-sm">{resident.vehicles.length} vehicle(s)</span>
                        ) : '—'}
                      </TableCell>
                      <TableCell>
                        {resident.isPending ? (
                          <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                            <AlertCircle className="w-3 h-3 mr-1" />
                            Pending
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                            <CheckCircle className="w-3 h-3 mr-1" />
                            Approved
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-zinc-500 whitespace-nowrap">
                        {resident.created_date
                          ? format(new Date(resident.created_date), 'MMM d, yyyy h:mm a')
                          : '—'}
                      </TableCell>
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {viewMode === 'trash' ? (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-zinc-600 hover:text-zinc-900"
                                onClick={() => restoreMutation.mutate({ id: resident.id, isProfile: resident.isApproved })}
                              >
                                Restore
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                                onClick={() => { setPendingDeleteResident(resident); setPermDeleteDialogOpen(true); }}
                              >
                                <Trash2 className="w-4 h-4 mr-1" />
                                Delete Forever
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openDetails(resident)}
                              >
                                View
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-red-500 hover:text-red-700 hover:bg-red-50"
                                onClick={() => { setPendingDeleteResident(resident); setDeleteDialogOpen(true); }}
                              >
                                <Trash className="w-4 h-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>)}

      {/* Resident Details Drawer */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
          {selectedResident && (
            <>
              <SheetHeader>
                <div className="flex items-center justify-between">
                  <SheetTitle className="flex items-center gap-2">
                    <Home className="w-5 h-5" />
                    Resident Details
                  </SheetTitle>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleEdit(selectedResident)}
                  >
                    <Edit className="w-4 h-4 mr-1" />
                    Edit
                  </Button>
                </div>
              </SheetHeader>

              <div className="mt-6 space-y-6">
                {/* Status Banner */}
                {selectedResident.isPending && (
                  <Card className="bg-amber-50 border-amber-200">
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="w-5 h-5 text-amber-600" />
                          <span className="font-semibold text-amber-900">Pending Approval</span>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            className="bg-green-600 hover:bg-green-700"
                            onClick={() => handleApprove(selectedResident)}
                          >
                            <CheckCircle className="w-4 h-4 mr-1" />
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleReject(selectedResident)}
                          >
                            <XCircle className="w-4 h-4 mr-1" />
                            Reject
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Basic Info */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm text-zinc-500">Unit Number</label>
                    <p className="font-semibold text-lg">
                      {selectedResident.unit_number}
                      {selectedResident.unit_number && (
                        <span className="ml-2 px-2 py-0.5 bg-zinc-100 text-zinc-700 rounded text-sm font-bold">
                          {selectedResident.unit_number.toString().startsWith('1') ? 'E' : 'W'}
                        </span>
                      )}
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-zinc-500">Resident Name</label>
                    <p className="font-semibold text-lg">{selectedResident.full_name}</p>
                  </div>
                  <div>
                    <label className="text-sm text-zinc-500">Move-in Date</label>
                    <p className="font-medium">
                      {selectedResident.move_in_date ? (
                        <>
                          <Calendar className="w-4 h-4 inline mr-1" />
                          {format(new Date(selectedResident.move_in_date), 'MMMM d, yyyy')}
                        </>
                      ) : '—'}
                    </p>
                  </div>
                  <div>
                    <label className="text-sm text-zinc-500">Parking Spot</label>
                    <p className="font-medium">
                      {selectedResident.parking_spot || selectedResident.vehicles?.[0]?.parking_spot || '—'}
                    </p>
                  </div>
                  <div className="col-span-2">
                    <label className="text-sm text-zinc-500">Date Received</label>
                    <p className="font-medium flex items-center gap-1.5">
                      <Calendar className="w-4 h-4 text-zinc-400" />
                      {selectedResident.created_date
                        ? format(new Date(selectedResident.created_date), 'MMMM d, yyyy · h:mm a')
                        : '—'}
                    </p>
                  </div>
                </div>

                {/* Vehicles */}
                <div>
                  <h3 className="font-semibold mb-3 flex items-center gap-2">
                    <Car className="w-5 h-5" />
                    Vehicles
                  </h3>
                  {selectedResident.vehicles?.length > 0 ? (
                    <div className="space-y-2">
                      {selectedResident.vehicles.map((vehicle, idx) => (
                        <Card key={idx}>
                          <CardContent className="p-4">
                            <div className="grid grid-cols-2 gap-2 text-sm">
                              <div>
                                <span className="text-zinc-500">Plate:</span>
                                <span className="ml-2 font-mono font-semibold">{vehicle.plate_number}</span>
                              </div>
                              <div>
                                <span className="text-zinc-500">Model:</span>
                                <span className="ml-2 font-medium">{vehicle.model || vehicle.vehicle_type || '—'}</span>
                              </div>
                              {vehicle.parking_spot && (
                                <div>
                                  <span className="text-zinc-500">Parking:</span>
                                  <span className="ml-2 font-medium">{vehicle.parking_spot}</span>
                                </div>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  ) : (
                    <p className="text-zinc-400 text-sm">No vehicles registered</p>
                  )}
                </div>

                {/* Documents */}
                <div>
                  <h3 className="font-semibold mb-3 flex items-center gap-2">
                    <FileText className="w-5 h-5" />
                    Documents
                  </h3>
                  <div className="space-y-2">
                    {selectedResident.lease_document_url ? (
                      <Button
                        variant="outline"
                        className="w-full justify-start"
                        onClick={() => setDocViewer({ open: true, url: selectedResident.lease_document_url, label: 'Lease Document' })}
                      >
                        <FileText className="w-4 h-4 mr-2 text-blue-600" />
                        View Lease Document
                      </Button>
                    ) : (
                      <div className="text-sm text-zinc-400 p-4 border border-dashed rounded-lg">
                        No lease document uploaded
                      </div>
                    )}

                    {(selectedResident.insurance_document_url || selectedResident.insurance_info_url) ? (
                      <Button
                        variant="outline"
                        className="w-full justify-start"
                        onClick={() => setDocViewer({ open: true, url: selectedResident.insurance_document_url || selectedResident.insurance_info_url, label: 'Insurance Document' })}
                      >
                        <FileText className="w-4 h-4 mr-2 text-green-600" />
                        View Insurance Document
                      </Button>
                    ) : (
                      <div className="text-sm text-zinc-400 p-4 border border-dashed rounded-lg">
                        No insurance document uploaded
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Reject Dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Resident Application</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-zinc-600">
              Please provide a reason for rejecting this resident application.
            </p>
            <Textarea
              placeholder="Rejection reason..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={submitRejection}
              disabled={!rejectReason.trim()}
            >
              Reject Application
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Management Edit Dialog */}
      {editingResident && (
        <ManagementEditDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          resident={editingResident}
          onSave={handleSaveEdit}
        />
      )}

      {/* Soft Delete Confirmation */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move to Trash</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-zinc-600">
            Are you sure you want to delete <strong>{pendingDeleteResident?.full_name}</strong>? This item will be moved to Trash and can be restored later.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => softDeleteMutation.mutate({ id: pendingDeleteResident.id, isProfile: pendingDeleteResident.isApproved })}
              disabled={softDeleteMutation.isPending}
            >
              Move to Trash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Secure Document Viewer */}
      <SecureDocumentViewer
        open={docViewer.open}
        onClose={() => setDocViewer({ open: false, url: null, label: null })}
        url={docViewer.url}
        label={docViewer.label}
      />

      {/* Permanent Delete Confirmation */}
      <Dialog open={permDeleteDialogOpen} onOpenChange={setPermDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-red-600">Permanently Delete</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-zinc-600">
            This will <strong>permanently remove</strong> <strong>{pendingDeleteResident?.full_name}</strong> and cannot be undone. All associated data will be lost.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPermDeleteDialogOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => permDeleteMutation.mutate({ id: pendingDeleteResident.id, isProfile: pendingDeleteResident.isApproved })}
              disabled={permDeleteMutation.isPending}
            >
              Delete Permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

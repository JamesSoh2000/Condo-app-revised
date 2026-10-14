import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, FileText, ClipboardList, Eye, Trash2, RotateCcw, Circle, Send } from 'lucide-react';
import { format, addDays, differenceInDays } from 'date-fns';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function ManagementReports() {
  const [selectedReport, setSelectedReport] = useState(null);
  const [filter, setFilter] = useState('all');
  const [user, setUser] = useState(null);
  const [localUnreadCount, setLocalUnreadCount] = useState(0);
  const queryClient = useQueryClient();

  React.useEffect(() => {
    const load = async () => {
      const u = await base44.auth.me();
      setUser(u);
    };
    load();
  }, []);

  const { data: allReports, isLoading } = useQuery({
    queryKey: ['management-reports'],
    queryFn: async () => {
      const reports = await base44.entities.Report.list('-created_date', 200);
      
      // Auto-cleanup: permanently delete reports past purge date
      // Also auto-archive reviewed reports after 7 days
      const now = new Date();
      for (const report of reports) {
        if (report.isDeleted && report.purgeAt && new Date(report.purgeAt) <= now) {
          await base44.entities.Report.delete(report.id);
        }
        
        // Auto-archive reviewed reports after 7 days
        if (report.status === 'reviewed' && report.autoArchiveAt && new Date(report.autoArchiveAt) <= now) {
          await base44.entities.Report.update(report.id, {
            status: 'archived',
            archivedAt: now.toISOString()
          });
        }
      }
      
      return reports;
    },
    refetchInterval: 2000
  });

  // Fetch read status for all reports
  const { data: readRecords = [] } = useQuery({
    queryKey: ['report-reads', user?.id],
    queryFn: async () => {
      if (!user) return [];
      return await base44.entities.ReportRead.filter({ userId: user.id });
    },
    enabled: !!user,
    refetchInterval: 2000
  });

  const readReportIds = new Set(readRecords.map(r => r.reportId));

  // Fetch all users to determine account types
  const { data: allUsers = [] } = useQuery({
    queryKey: ['all-users'],
    queryFn: () => base44.entities.User.list('-created_date', 500),
    enabled: !!user
  });

  // Fetch all profiles to enrich report data
  const { data: allProfiles = [] } = useQuery({
    queryKey: ['all-profiles'],
    queryFn: () => base44.entities.Profile.list('-updated_date', 500)
  });

  const profileMap = useMemo(() => {
    const map = {};
    allProfiles.forEach(p => {
      map[p.userId] = p;
    });
    return map;
  }, [allProfiles]);

  // Filter reports by user role
  const filteredReportsByRole = useMemo(() => {
    if (!allReports) return [];
    
    const effectiveRole = user?.management_role || user?.app_role;
    
    // Security: only sees incident reports from residents
    if (effectiveRole === 'security' && allUsers && allUsers.length > 0) {
      const residentUserIds = new Set(
        allUsers.filter(u => u.account_type === 'resident').map(u => u.id)
      );
      
      const securityReports = allReports.filter(r => 
        r.type === 'incident' && residentUserIds.has(r.createdByUserId)
      );
      
      console.log('Security filter applied:', {
        totalReports: allReports.length,
        incidentReports: allReports.filter(r => r.type === 'incident').length,
        residentCount: residentUserIds.size,
        filteredCount: securityReports.length
      });
      
      return securityReports;
    }
    
    // Property management and board: see all reports
    return allReports;
  }, [allReports, allUsers, user]);

  // Separate reports by status
  const activeReports = filteredReportsByRole?.filter(r => !r.isDeleted && r.status === 'submitted') || [];
  const reviewedReports = filteredReportsByRole?.filter(r => !r.isDeleted && r.status === 'reviewed') || [];
  const archivedReports = filteredReportsByRole?.filter(r => !r.isDeleted && r.status === 'archived') || [];
  const deletedReports = filteredReportsByRole?.filter(r => r.isDeleted && (!r.purgeAt || new Date(r.purgeAt) > new Date())) || [];

  const [newResolutionNote, setNewResolutionNote] = React.useState('');

  const markAsReviewed = useMutation({
    mutationFn: (id) => {
      const now = new Date();
      const autoArchiveDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      return base44.entities.Report.update(id, {
        status: 'reviewed',
        reviewedAt: now.toISOString(),
        reviewedByUserId: user.id,
        autoArchiveAt: autoArchiveDate.toISOString()
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['management-reports']);
      setSelectedReport(null);
      toast.success('Report marked as reviewed');
    }
  });

  const archiveReport = useMutation({
    mutationFn: (id) => base44.entities.Report.update(id, {
      status: 'archived',
      archivedAt: new Date().toISOString()
    }),
    onSuccess: () => {
      queryClient.invalidateQueries(['management-reports']);
      setSelectedReport(null);
      toast.success('Report archived');
    }
  });

  const addResolutionNote = useMutation({
    mutationFn: async (content) => {
      return base44.entities.MaintenanceNote.create({
        ticket_id: selectedReport.id,
        content,
        created_by_name: user?.full_name || 'Staff'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['report-resolution-notes', selectedReport?.id]);
      setNewResolutionNote('');
      toast.success('Note added');
    }
  });

  const { data: resolutionNotes } = useQuery({
    queryKey: ['report-resolution-notes', selectedReport?.id],
    queryFn: () => selectedReport ? base44.entities.MaintenanceNote.filter({ ticket_id: selectedReport.id }, '-created_date', 100) : Promise.resolve([]),
    enabled: !!selectedReport
  });

  const deleteReport = useMutation({
    mutationFn: async (report) => {
      const purgeDate = addDays(new Date(), 7);
      await base44.entities.Report.update(report.id, {
        isDeleted: true,
        deletedAt: new Date().toISOString(),
        deletedByUserId: user.id,
        deletedByName: user.full_name,
        purgeAt: purgeDate.toISOString()
      });
      
      return { reportId: report.id, purgeDate };
    },
    onMutate: async (report) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries(['management-reports']);
      
      // Snapshot the previous value
      const previousReports = queryClient.getQueryData(['management-reports']);
      
      // Optimistically update to the new value
      queryClient.setQueryData(['management-reports'], (old) => {
        if (!old) return old;
        return old.map(r => 
          r.id === report.id 
            ? { 
                ...r, 
                isDeleted: true,
                deletedAt: new Date().toISOString(),
                deletedByUserId: user.id,
                deletedByName: user.full_name,
                purgeAt: addDays(new Date(), 7).toISOString()
              }
            : r
        );
      });
      
      // Close dialog and show instant feedback
      setSelectedReport(null);
      toast.success('Report moved to Deleted Reports');
      
      return { previousReports };
    },
    onError: (err, report, context) => {
      // Rollback on error
      queryClient.setQueryData(['management-reports'], context.previousReports);
      toast.error('Delete failed — try again');
    },
    onSettled: () => {
      // Refetch in background to ensure consistency
      queryClient.invalidateQueries(['management-reports']);
    }
  });

  const restoreReport = useMutation({
    mutationFn: (id) => base44.entities.Report.update(id, {
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deletedByName: null,
      deleteReason: null,
      purgeAt: null
    }),
    onSuccess: () => {
      queryClient.invalidateQueries(['management-reports']);
      toast.success('Report restored');
    }
  });

  const filteredActiveReports = activeReports.filter(r => filter === 'all' || r.type === filter);
  const filteredReviewedReports = reviewedReports.filter(r => filter === 'all' || r.type === filter);
  const filteredArchivedReports = archivedReports.filter(r => filter === 'all' || r.type === filter);
  const filteredDeletedReports = deletedReports.filter(r => filter === 'all' || r.type === filter);

  const canDelete = user && (user.management_role === 'property_management' || user.management_role === 'board' || user.app_role === 'board');

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-bold">Security Reports Inbox</h2>
          <Button size="sm" variant="outline" disabled>
            <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Loading...
          </Button>
        </div>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Submitted By</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[1, 2, 3].map(i => (
                <TableRow key={i}>
                  <TableCell><div className="h-6 w-20 bg-zinc-100 rounded animate-pulse" /></TableCell>
                  <TableCell><div className="h-4 w-48 bg-zinc-100 rounded animate-pulse" /></TableCell>
                  <TableCell><div className="h-4 w-32 bg-zinc-100 rounded animate-pulse" /></TableCell>
                  <TableCell><div className="h-4 w-32 bg-zinc-100 rounded animate-pulse" /></TableCell>
                  <TableCell><div className="h-6 w-20 bg-zinc-100 rounded animate-pulse" /></TableCell>
                  <TableCell className="text-right"><div className="h-8 w-8 bg-zinc-100 rounded animate-pulse ml-auto" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Security Reports Inbox</h2>
        <Button size="sm" variant="outline" onClick={() => queryClient.invalidateQueries(['management-reports'])}>
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh
        </Button>
      </div>

      <div className="flex gap-2">
        <Button
          variant={filter === 'all' ? 'default' : 'outline'}
          onClick={() => setFilter('all')}
          size="sm"
        >
          All Reports
        </Button>
        <Button
          variant={filter === 'incident' ? 'default' : 'outline'}
          onClick={() => setFilter('incident')}
          size="sm"
        >
          <FileText className="w-4 h-4 mr-2" />
          Incidents
        </Button>
        <Button
          variant={filter === 'shift' ? 'default' : 'outline'}
          onClick={() => setFilter('shift')}
          size="sm"
        >
          <ClipboardList className="w-4 h-4 mr-2" />
          Shift Reports
        </Button>
      </div>

      <Tabs defaultValue="active" className="w-full">
        <TabsList>
          <TabsTrigger value="active">Active Reports</TabsTrigger>
          <TabsTrigger value="reviewed">
            Reviewed Reports ({reviewedReports.length})
          </TabsTrigger>
          <TabsTrigger value="archived">
            Archived Reports ({archivedReports.length})
          </TabsTrigger>
          <TabsTrigger value="deleted">
            Deleted Reports ({deletedReports.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="active">
          <Card>
            <Table>
          <TableHeader>
              <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Submitted By</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
              </TableRow>
          </TableHeader>
          <TableBody>
              {filteredActiveReports.map(r => {
                const isUnread = !readReportIds.has(r.id);
                return (
                  <TableRow key={r.id} className={isUnread ? 'bg-blue-50/30' : ''}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {isUnread && <Circle className="w-2 h-2 fill-blue-600 text-blue-600" />}
                          <Badge variant="outline" className={r.type === 'incident' ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-700"}>
                            {r.type.toUpperCase()}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className={isUnread ? "font-bold" : "font-medium"}>{r.subject}</TableCell>
                      <TableCell>{profileMap[r.createdByUserId]?.full_name || r.createdByName}</TableCell>
                      <TableCell className="text-sm text-zinc-500">
                        {format(new Date(r.created_date), 'MMM d, yyyy h:mm a')}
                      </TableCell>
                      <TableCell>
                        <Badge className='bg-amber-100 text-amber-800'>
                          submitted
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            setSelectedReport(r);
                            // Mark as read in DB immediately
                            if (user && isUnread) {
                              await base44.entities.ReportRead.create({
                                userId: user.id,
                                reportId: r.id,
                                readAt: new Date().toISOString()
                              });
                              queryClient.invalidateQueries(['report-reads']);
                            }
                          }}
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                      </TableCell>
                  </TableRow>
                );
              })}
              {filteredActiveReports.length === 0 && (
                  <TableRow>
                      <TableCell colSpan={6} className="text-center py-8">
                        <div className="text-zinc-400">No active reports found.</div>
                        {user && (user.management_role === 'security' || user.app_role === 'security') && (
                          <div className="text-xs text-zinc-400 mt-2">Security users only see incident reports from residents.</div>
                        )}
                      </TableCell>
                  </TableRow>
              )}
          </TableBody>
          </Table>
          </Card>
          </TabsContent>

          <TabsContent value="reviewed">
          <Card>
          <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Submitted By</TableHead>
              <TableHead>Reviewed</TableHead>
              <TableHead>Auto-Archive In</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredReviewedReports.map(r => {
              const autoArchiveDate = r.autoArchiveAt ? new Date(r.autoArchiveAt) : null;
              const daysUntilArchive = autoArchiveDate ? Math.max(0, Math.ceil((autoArchiveDate - new Date()) / (1000 * 60 * 60 * 24))) : 0;
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    <Badge variant="outline" className={r.type === 'incident' ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-700"}>
                      {r.type.toUpperCase()}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium">{r.subject}</TableCell>
                  <TableCell>{profileMap[r.createdByUserId]?.full_name || r.createdByName}</TableCell>
                  <TableCell className="text-sm text-zinc-500">
                    {r.reviewedAt ? format(new Date(r.reviewedAt), 'MMM d, h:mm a') : '-'}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="bg-blue-50 text-blue-700">
                      {daysUntilArchive} day{daysUntilArchive !== 1 ? 's' : ''}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-2 justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelectedReport(r)}
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => archiveReport.mutate(r.id)}
                        disabled={archiveReport.isPending}
                      >
                        Archive
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {filteredReviewedReports.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-zinc-400 py-8">
                  No reviewed reports.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          </Table>
          </Card>
          </TabsContent>

          <TabsContent value="archived">
          <Card>
          <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Submitted By</TableHead>
              <TableHead>Archived</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredArchivedReports.map(r => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Badge variant="outline" className={r.type === 'incident' ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-700"}>
                      {r.type.toUpperCase()}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium text-zinc-400">{r.subject}</TableCell>
                  <TableCell className="text-zinc-400">{profileMap[r.createdByUserId]?.full_name || r.createdByName}</TableCell>
                  <TableCell className="text-sm text-zinc-400">
                    {r.archivedAt ? format(new Date(r.archivedAt), 'MMM d, h:mm a') : '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelectedReport(r)}
                    >
                      <Eye className="w-4 h-4" />
                    </Button>
                  </TableCell>
                </TableRow>
            ))}
            {filteredArchivedReports.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-zinc-400 py-8">
                  No archived reports.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          </Table>
          </Card>
          </TabsContent>

          <TabsContent value="deleted">
          <Card>
          <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Submitted By</TableHead>
              <TableHead>Deleted By</TableHead>
              <TableHead>Days Remaining</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredDeletedReports.map(r => {
              const daysRemaining = r.purgeAt ? Math.max(0, differenceInDays(new Date(r.purgeAt), new Date())) : 0;
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    <Badge variant="outline" className={r.type === 'incident' ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-700"}>
                      {r.type.toUpperCase()}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium text-zinc-400">{r.subject}</TableCell>
                  <TableCell className="text-zinc-400">{profileMap[r.createdByUserId]?.full_name || r.createdByName}</TableCell>
                  <TableCell className="text-sm text-zinc-400">
                    {r.deletedByName}<br />
                    <span className="text-xs">{r.deletedAt && format(new Date(r.deletedAt), 'MMM d, h:mm a')}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="bg-red-50 text-red-700">
                      {daysRemaining} day{daysRemaining !== 1 ? 's' : ''}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-2 justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelectedReport(r)}
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                      {canDelete && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => restoreReport.mutate(r.id)}
                          disabled={restoreReport.isPending}
                        >
                          <RotateCcw className="w-4 h-4 text-green-600" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {filteredDeletedReports.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-zinc-400 py-8">
                  No deleted reports.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          </Table>
          </Card>
          </TabsContent>
          </Tabs>

      {selectedReport && (
        <Dialog open={!!selectedReport} onOpenChange={() => setSelectedReport(null)}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Badge className={selectedReport.type === 'incident' ? "bg-red-100 text-red-800" : "bg-blue-100 text-blue-800"}>
                  {selectedReport.type.toUpperCase()}
                </Badge>
                {selectedReport.subject}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-zinc-500">Submitted By</p>
                  <p className="font-medium">{profileMap[selectedReport.createdByUserId]?.full_name || selectedReport.createdByName}</p>
                </div>
                <div>
                  <p className="text-zinc-500">Date</p>
                  <p className="font-medium">{format(new Date(selectedReport.created_date), 'MMM d, yyyy h:mm a')}</p>
                </div>
                {(selectedReport.unit || profileMap[selectedReport.createdByUserId]?.unit_number) && (
                  <div>
                    <p className="text-zinc-500">Unit</p>
                    <p className="font-medium">{profileMap[selectedReport.createdByUserId]?.unit_number || selectedReport.unit}</p>
                  </div>
                )}
                {(profileMap[selectedReport.createdByUserId]?.primary_phone || selectedReport.createdByPhone) && (
                  <div>
                    <p className="text-zinc-500">Contact</p>
                    <p className="font-medium">{profileMap[selectedReport.createdByUserId]?.primary_phone || selectedReport.createdByPhone}</p>
                  </div>
                )}
                {selectedReport.tower && (
                  <div>
                    <p className="text-zinc-500">Tower</p>
                    <p className="font-medium">{selectedReport.tower}</p>
                  </div>
                )}
              </div>
              <div>
                <p className="text-zinc-500 mb-2">Description</p>
                <p className="text-sm whitespace-pre-wrap bg-zinc-50 p-4 rounded">{selectedReport.description}</p>
              </div>
              {selectedReport.photos && selectedReport.photos.length > 0 && (
                <div>
                  <p className="text-zinc-500 mb-2">Photos</p>
                  <div className="grid grid-cols-3 gap-2">
                    {selectedReport.photos.map((url, i) => (
                      <img key={i} src={url} alt="" className="w-full h-32 object-cover rounded" />
                    ))}
                  </div>
                </div>
              )}
              {user && (user.management_role === 'security' || user.app_role === 'security') && (
                <div className="space-y-2 bg-blue-50 p-3 rounded-lg">
                  <label className="text-xs text-blue-700 font-medium">Resolution Notes</label>
                  <div className="max-h-48 overflow-y-auto space-y-2 mb-2">
                    {resolutionNotes && resolutionNotes.length > 0 ? (
                      resolutionNotes.map(note => (
                        <div key={note.id} className="bg-white p-2 rounded border border-blue-200">
                          <div className="flex justify-between items-start mb-1">
                            <span className="text-xs font-medium text-blue-700">{note.created_by_name}</span>
                            <span className="text-xs text-zinc-400">{format(new Date(note.created_date), 'MMM d, h:mm a')}</span>
                          </div>
                          <p className="text-sm text-zinc-700">{note.content}</p>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-blue-600 italic">No notes yet</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Textarea 
                      placeholder="Add resolution note..." 
                      value={newResolutionNote}
                      onChange={(e) => setNewResolutionNote(e.target.value)}
                      className="text-sm resize-none h-16"
                    />
                    <Button 
                      size="icon" 
                      onClick={() => {
                        if (newResolutionNote.trim()) {
                          addResolutionNote.mutate(newResolutionNote.trim());
                        }
                      }}
                      disabled={!newResolutionNote.trim() || addResolutionNote.isPending}
                      className="self-end"
                    >
                      <Send className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}
              <div className="flex gap-3">
               {selectedReport.status === 'submitted' && !selectedReport.isDeleted && (
                 <>
                   <Button
                     onClick={() => markAsReviewed.mutate(selectedReport.id)}
                     disabled={markAsReviewed.isPending}
                     className="flex-1"
                   >
                     Mark as Reviewed
                   </Button>
                   {canDelete && (
                     <Button
                       variant="destructive"
                       onClick={() => deleteReport.mutate(selectedReport)}
                       disabled={deleteReport.isPending}
                       className="flex-1"
                     >
                       <Trash2 className="w-4 h-4 mr-2" />
                       Delete
                     </Button>
                   )}
                 </>
               )}
               {selectedReport.status === 'reviewed' && !selectedReport.isDeleted && (
                 <>
                   <Button
                     variant="outline"
                     onClick={() => archiveReport.mutate(selectedReport.id)}
                     disabled={archiveReport.isPending}
                     className="flex-1"
                   >
                     Archive
                   </Button>
                   {canDelete && (
                     <Button
                       variant="destructive"
                       onClick={() => deleteReport.mutate(selectedReport)}
                       disabled={deleteReport.isPending}
                       className="flex-1"
                     >
                       <Trash2 className="w-4 h-4 mr-2" />
                       Delete
                     </Button>
                   )}
                 </>
               )}
               {canDelete && selectedReport.isDeleted && (
                 <Button
                   variant="outline"
                   onClick={() => restoreReport.mutate(selectedReport.id)}
                   disabled={restoreReport.isPending}
                   className="flex-1"
                 >
                   <RotateCcw className="w-4 h-4 mr-2" />
                   Restore Report
                 </Button>
               )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
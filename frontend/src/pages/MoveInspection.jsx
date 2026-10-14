import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { Camera, Upload, CheckCircle2, AlertCircle, Clock, History, Eye, X } from 'lucide-react';
import { format } from 'date-fns';
import PhotoViewer from '@/components/PhotoViewer';

export default function MoveInspection() {
  const [user, setUser] = useState(null);
  const [selectedMove, setSelectedMove] = useState(null);
  const [activeTab, setActiveTab] = useState('list');
  const [inspectionData, setInspectionData] = useState(null);
  const [uploadProgress, setUploadProgress] = useState({});
  const [photoViewerOpen, setPhotoViewerOpen] = useState(false);
  const [viewerPhotos, setViewerPhotos] = useState([]);
  const queryClient = useQueryClient();

  useEffect(() => {
    const fetchUser = async () => {
      const currentUser = await base44.auth.me();
      // Set isAdmin for board members
      if (currentUser.management_role === 'board' || currentUser.app_role === 'board') {
        currentUser.isAdmin = true;
      }
      setUser(currentUser);
    };
    fetchUser();
  }, []);

  // Fetch confirmed moves
  const { data: confirmedMoves = [] } = useQuery({
    queryKey: ['confirmed-moves'],
    queryFn: async () => {
      const all = await base44.entities.MoveRequest.list('-date', 100);
      return all.filter(m => m.status === 'approved');
    },
    enabled: !!user
  });

  // Fetch all inspections
  const { data: allInspections = [] } = useQuery({
    queryKey: ['all-inspections'],
    queryFn: () => base44.entities.MoveInspection.list('-created_date', 200),
    enabled: !!user
  });

  // Fetch photos for selected inspection
  const { data: photos = [] } = useQuery({
    queryKey: ['inspection-photos', inspectionData?.id],
    queryFn: () => base44.entities.MoveInspectionPhoto.filter({ inspection_id: inspectionData.id }),
    enabled: !!inspectionData?.id
  });

  const createInspectionMutation = useMutation({
    mutationFn: async (moveRequest) => {
      return await base44.entities.MoveInspection.create({
        move_request_id: moveRequest.id,
        unit_number: moveRequest.unitNumber,
        tower: moveRequest.tower,
        move_date: moveRequest.date,
        created_by_user_id: user.id,
        created_by_name: user.full_name,
        status: 'not_started',
        move_outcome: 'clean',
        post_damage_found: false,
        pre_damage_found: false
      });
    },
    onSuccess: (newInspection, moveRequest) => {
      setInspectionData(newInspection);
      setSelectedMove(moveRequest);
      queryClient.invalidateQueries({ queryKey: ['all-inspections'] });
      toast.success('Inspection started');
    }
  });

  const updateInspectionMutation = useMutation({
    mutationFn: async (updates) => {
      // Add edit tracking
      const updatesWithTracking = {
        ...updates,
        last_edited_at: new Date().toISOString(),
        last_edited_by_user_id: user.id,
        last_edited_by_name: user.full_name
      };
      return await base44.entities.MoveInspection.update(inspectionData.id, updatesWithTracking);
    },
    onSuccess: (updated) => {
      setInspectionData(updated);
      queryClient.invalidateQueries({ queryKey: ['all-inspections'] });
    }
  });

  const deletePhotoMutation = useMutation({
    mutationFn: async (photoId) => {
      return await base44.entities.MoveInspectionPhoto.delete(photoId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inspection-photos'] });
      toast.success('Photo deleted');
    },
    onError: () => {
      toast.error('Failed to delete photo');
    }
  });

  const submitInspectionMutation = useMutation({
    mutationFn: async () => {
      // Debug logging
      console.log('📋 Submitting inspection with move_outcome:', inspectionData.move_outcome);
      
      // Validate photos
      const prePhotos = photos.filter(p => p.phase === 'pre');
      const postPhotos = photos.filter(p => p.phase === 'post');
      
      const preAreas = new Set(prePhotos.map(p => p.area));
      const postAreas = new Set(postPhotos.map(p => p.area));
      
      if (!preAreas.has('hallway') || !preAreas.has('elevator') || !preAreas.has('garage')) {
        throw new Error('Pre-move photos required for all areas (hallway, elevator, garage)');
      }
      
      if (!postAreas.has('hallway') || !postAreas.has('elevator') || !postAreas.has('garage')) {
        throw new Error('Post-move photos required for all areas (hallway, elevator, garage)');
      }
      
      if (inspectionData.move_outcome === 'non_clean' && !inspectionData.post_damage_notes?.trim()) {
        throw new Error('Post-damage notes required for non-clean moves');
      }
      
      toast.info(`Submitting as: ${inspectionData.move_outcome === 'clean' ? 'Clean Move' : 'Non-Clean Move'}`);
      
      return await base44.entities.MoveInspection.update(inspectionData.id, {
        status: 'submitted',
        submitted_at: new Date().toISOString()
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['all-inspections'] });
      toast.success('Inspection submitted and locked');
      setSelectedMove(null);
      setInspectionData(null);
      setActiveTab('history');
    },
    onError: (error) => {
      toast.error(error.message);
    }
  });

  const handleStartInspection = (move) => {
    const existing = allInspections.find(i => i.move_request_id === move.id);
    if (existing) {
      // Ensure old inspections have default outcome if missing
      if (!existing.move_outcome) {
        updateInspectionMutation.mutate({ 
          move_outcome: 'clean', 
          post_damage_found: false 
        });
      }
      setInspectionData(existing);
      setSelectedMove(move);
    } else {
      // For new inspections, mutation onSuccess will set both selectedMove and inspectionData
      createInspectionMutation.mutate(move);
    }
  };

  const handleViewInspection = (inspection) => {
    const move = confirmedMoves.find(m => m.id === inspection.move_request_id);
    if (move) {
      setInspectionData(inspection);
      setSelectedMove(move);
    }
  };

  const handleFileUpload = async (files, phase, area) => {
    if (!files || files.length === 0) return;
    
    const fileArray = Array.from(files);
    const uploadKey = `${phase}-${area}`;
    
    // Initialize progress tracking
    setUploadProgress(prev => ({
      ...prev,
      [uploadKey]: {
        total: fileArray.length,
        completed: 0,
        uploading: true
      }
    }));

    // Upload files in parallel (limit to 3 concurrent uploads)
    const uploadBatch = async (fileBatch) => {
      return Promise.all(
        fileBatch.map(async (file) => {
          try {
            const { file_url } = await base44.integrations.Core.UploadFile({ file });
            await base44.entities.MoveInspectionPhoto.create({
              inspection_id: inspectionData.id,
              phase,
              area,
              photo_url: file_url,
              captured_at: new Date().toISOString()
            });
            
            setUploadProgress(prev => ({
              ...prev,
              [uploadKey]: {
                ...prev[uploadKey],
                completed: prev[uploadKey].completed + 1
              }
            }));
          } catch (error) {
            console.error('Failed to upload photo:', error);
            throw error;
          }
        })
      );
    };

    try {
      // Process in batches of 3
      for (let i = 0; i < fileArray.length; i += 3) {
        const batch = fileArray.slice(i, i + 3);
        await uploadBatch(batch);
      }
      
      queryClient.invalidateQueries({ queryKey: ['inspection-photos'] });
      toast.success(`${fileArray.length} photo${fileArray.length > 1 ? 's' : ''} uploaded successfully`);
    } catch (error) {
      toast.error('Some photos failed to upload');
    } finally {
      setUploadProgress(prev => {
        const newProgress = { ...prev };
        delete newProgress[uploadKey];
        return newProgress;
      });
    }
  };

  const getPhotosByPhaseArea = (phase, area) => {
    return photos.filter(p => p.phase === phase && p.area === area);
  };

  const getInspectionStatus = (move) => {
    const inspection = allInspections.find(i => i.move_request_id === move.id);
    if (!inspection) return { label: 'Not started', color: 'bg-zinc-200 text-zinc-700', icon: Clock };
    if (inspection.status === 'submitted') return { label: 'Submitted', color: 'bg-green-100 text-green-700', icon: CheckCircle2 };
    if (inspection.status === 'pre_completed') return { label: 'Pre done', color: 'bg-blue-100 text-blue-700', icon: Camera };
    return { label: 'In progress', color: 'bg-yellow-100 text-yellow-700', icon: Clock };
  };

  const canEdit = () => {
    if (!inspectionData || !user) return false;
    const isSecurity = user.management_role === 'security' || user.app_role === 'security';
    // Security can edit all inspections (including submitted ones)
    return isSecurity;
  };

  const PhotoUploadArea = ({ phase, area, label }) => {
    const areaPhotos = getPhotosByPhaseArea(phase, area);
    const uploadKey = `${phase}-${area}`;
    const progress = uploadProgress[uploadKey];
    const isUploading = progress?.uploading;
    const disabled = !canEdit() || isUploading;
    const [isDragging, setIsDragging] = useState(false);

    const handleDragOver = (e) => {
      e.preventDefault();
      if (!disabled) setIsDragging(true);
    };

    const handleDragLeave = (e) => {
      e.preventDefault();
      setIsDragging(false);
    };

    const handleDrop = (e) => {
      e.preventDefault();
      setIsDragging(false);
      if (!disabled && e.dataTransfer.files) {
        handleFileUpload(e.dataTransfer.files, phase, area);
      }
    };

    return (
      <div className="border rounded-lg p-4 bg-white">
        <div className="flex items-center justify-between mb-3">
          <Label className="text-sm font-semibold">{label}</Label>
          <Badge variant="outline">{areaPhotos.length} photos</Badge>
        </div>
        
        {areaPhotos.length > 0 && (
          <div className="grid grid-cols-3 gap-2 mb-3">
            {areaPhotos.map(photo => (
              <div 
                key={photo.id} 
                className="relative aspect-square rounded overflow-hidden group"
              >
                <img 
                  src={photo.photo_url} 
                  alt={area} 
                  className="w-full h-full object-cover cursor-pointer hover:opacity-80 transition"
                  onClick={() => {
                    setViewerPhotos([photo.photo_url]);
                    setPhotoViewerOpen(true);
                  }}
                />
                {canEdit() && (
                  <button
                    onClick={() => deletePhotoMutation.mutate(photo.id)}
                    className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition hover:bg-red-600"
                    disabled={deletePhotoMutation.isPending}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {canEdit() && (
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`rounded-lg border-2 border-dashed transition ${
              isDragging 
                ? 'border-blue-400 bg-blue-50' 
                : disabled 
                ? 'opacity-50 cursor-not-allowed border-zinc-200' 
                : 'hover:bg-zinc-50 hover:border-zinc-400 cursor-pointer border-zinc-300'
            }`}
          >
            <label className={`flex flex-col items-center justify-center gap-2 py-3 px-4 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
              <input 
                type="file" 
                accept="image/*"
                multiple
                className="hidden" 
                onChange={(e) => handleFileUpload(e.target.files, phase, area)}
                disabled={disabled}
              />
              {isUploading ? (
                <>
                  <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-900 rounded-full animate-spin" />
                  <span className="text-xs text-zinc-600">
                    Uploading {progress.completed}/{progress.total}...
                  </span>
                  <div className="w-full bg-zinc-200 rounded-full h-1.5 mt-1">
                    <div 
                      className="bg-blue-600 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${(progress.completed / progress.total) * 100}%` }}
                    />
                  </div>
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4 text-zinc-500" />
                  <div className="text-center">
                    <span className="text-sm text-zinc-700 block">Upload Photos</span>
                    <span className="text-xs text-zinc-500">Click or drag & drop multiple images</span>
                  </div>
                </>
              )}
            </label>
          </div>
        )}
      </div>
    );
  };

  if (!user) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  const isSecurity = user.management_role === 'security' || user.app_role === 'security';
  const canViewHistory = isSecurity || user.management_role === 'property_management' || user.isAdmin;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Move Inspection</h1>
          <p className="text-zinc-500 mt-1">Document move areas with photos and damage reports</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="list">
            <Camera className="w-4 h-4 mr-2" />
            Inspections
          </TabsTrigger>
          {canViewHistory && (
            <TabsTrigger value="history">
              <History className="w-4 h-4 mr-2" />
              History
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="list" className="space-y-4 mt-6">
          {createInspectionMutation.isPending ? (
            <Card>
              <CardContent className="py-12">
                <div className="flex flex-col items-center justify-center gap-4">
                  <div className="w-8 h-8 border-4 border-zinc-200 border-t-zinc-900 rounded-full animate-spin" />
                  <p className="text-zinc-500">Creating inspection...</p>
                </div>
              </CardContent>
            </Card>
          ) : !selectedMove ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Confirmed Moves Needing Inspection</CardTitle>
                </CardHeader>
                <CardContent>
                  {confirmedMoves.filter(move => {
                    const inspection = allInspections.find(i => i.move_request_id === move.id);
                    return !inspection || inspection.status !== 'submitted';
                  }).length === 0 ? (
                    <p className="text-zinc-500 text-center py-8">No confirmed moves to inspect</p>
                  ) : (
                    <div className="space-y-3">
                      {confirmedMoves
                        .filter(move => {
                          const inspection = allInspections.find(i => i.move_request_id === move.id);
                          return !inspection || inspection.status !== 'submitted';
                        })
                        .map(move => {
                          const status = getInspectionStatus(move);
                          const StatusIcon = status.icon;
                          return (
                            <div key={move.id} className="flex items-center justify-between p-4 border rounded-lg hover:bg-zinc-50 transition">
                              <div className="flex-1">
                                <div className="flex items-center gap-3">
                                  <span className="font-semibold">Unit {move.unitNumber}</span>
                                  <Badge className="bg-zinc-800 text-white">{move.tower}</Badge>
                                  <Badge variant="outline">{move.requestType.replace('_', ' ')}</Badge>
                                </div>
                                <div className="text-sm text-zinc-500 mt-1">
                                  {format(new Date(move.date), 'PPP')} • {move.startTime} - {move.endTime}
                                </div>
                              </div>
                              <div className="flex items-center gap-3">
                                <Badge className={status.color}>
                                  <StatusIcon className="w-3 h-3 mr-1" />
                                  {status.label}
                                </Badge>
                                <Button 
                                  size="sm" 
                                  onClick={() => handleStartInspection(move)}
                                  disabled={!isSecurity}
                                >
                                  {status.label === 'Not started' ? 'Start Inspection' : 'Continue'}
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          ) : (
            <div className="space-y-6">
              <Button variant="outline" onClick={() => { setSelectedMove(null); setInspectionData(null); }}>
                ← Back to List
              </Button>

              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>Inspection: Unit {selectedMove.unitNumber} {selectedMove.tower}</CardTitle>
                      <p className="text-sm text-zinc-500 mt-1">
                        {format(new Date(selectedMove.date), 'PPP')} • {selectedMove.startTime} - {selectedMove.endTime}
                      </p>
                      {inspectionData?.last_edited_at && (
                        <p className="text-xs text-zinc-400 mt-1">
                          Last edited by {inspectionData.last_edited_by_name} • {format(new Date(inspectionData.last_edited_at), 'PPp')}
                        </p>
                      )}
                    </div>
                    {inspectionData?.status === 'submitted' && (
                      <Badge className="bg-green-100 text-green-700">
                        <CheckCircle2 className="w-3 h-3 mr-1" />
                        Submitted
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-8">
                  {/* Pre-Move Section */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 pb-2 border-b">
                      <Camera className="w-5 h-5 text-blue-600" />
                      <h3 className="text-lg font-semibold">Pre-Move Inspection</h3>
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <PhotoUploadArea phase="pre" area="hallway" label="Hallway" />
                      <PhotoUploadArea phase="pre" area="elevator" label="Elevator" />
                      <PhotoUploadArea phase="pre" area="garage" label="Garage" />
                    </div>

                    <div className="space-y-2">
                      <Label>Do you see any damages beforehand?</Label>
                      {canEdit() ? (
                        <div className="flex gap-2">
                          <Button
                            variant={inspectionData?.pre_damage_found === true ? 'default' : 'outline'}
                            onClick={() => updateInspectionMutation.mutate({ pre_damage_found: true })}
                          >
                            Yes
                          </Button>
                          <Button
                            variant={inspectionData?.pre_damage_found === false ? 'default' : 'outline'}
                            onClick={() => updateInspectionMutation.mutate({ pre_damage_found: false })}
                          >
                            No
                          </Button>
                        </div>
                      ) : (
                        <Badge variant="outline">
                          {inspectionData?.pre_damage_found ? 'Yes' : 'No'}
                        </Badge>
                      )}
                    </div>

                    {inspectionData?.pre_damage_found && (
                      <div className="space-y-2">
                        <Label>Pre-Damage Notes</Label>
                        {canEdit() ? (
                          <Textarea
                            value={inspectionData.pre_damage_notes || ''}
                            onChange={(e) => updateInspectionMutation.mutate({ pre_damage_notes: e.target.value })}
                            placeholder="Describe any pre-existing damage..."
                            rows={3}
                          />
                        ) : (
                          <p className="text-sm p-3 bg-zinc-50 rounded border">{inspectionData.pre_damage_notes || 'None'}</p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Post-Move Section */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 pb-2 border-b">
                      <Camera className="w-5 h-5 text-green-600" />
                      <h3 className="text-lg font-semibold">Post-Move Inspection</h3>
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <PhotoUploadArea phase="post" area="hallway" label="Hallway" />
                      <PhotoUploadArea phase="post" area="elevator" label="Elevator" />
                      <PhotoUploadArea phase="post" area="garage" label="Garage" />
                    </div>

                    <div className="space-y-2">
                      <Label>Move Outcome</Label>
                      {canEdit() ? (
                        <div className="flex gap-2">
                          <Button
                            variant={inspectionData?.move_outcome === 'clean' ? 'default' : 'outline'}
                            onClick={() => updateInspectionMutation.mutate({ move_outcome: 'clean', post_damage_found: false })}
                            className={inspectionData?.move_outcome === 'clean' ? 'bg-green-600 hover:bg-green-700 text-white' : ''}
                          >
                            <CheckCircle2 className="w-4 h-4 mr-2" />
                            Clean Move
                          </Button>
                          <Button
                            variant={inspectionData?.move_outcome === 'non_clean' ? 'destructive' : 'outline'}
                            onClick={() => updateInspectionMutation.mutate({ move_outcome: 'non_clean', post_damage_found: true })}
                          >
                            <AlertCircle className="w-4 h-4 mr-2" />
                            Non-Clean Move
                          </Button>
                        </div>
                      ) : (
                        <Badge className={inspectionData?.move_outcome === 'clean' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}>
                          {inspectionData?.move_outcome === 'clean' ? 'Clean Move' : 'Non-Clean Move'}
                        </Badge>
                      )}
                    </div>

                    {inspectionData?.move_outcome === 'non_clean' && (
                      <div className="space-y-2">
                        <Label>Post-Damage Notes (Required)</Label>
                        {canEdit() ? (
                          <Textarea
                            value={inspectionData.post_damage_notes || ''}
                            onChange={(e) => updateInspectionMutation.mutate({ post_damage_notes: e.target.value })}
                            placeholder="Describe any damage found after the move..."
                            rows={4}
                            required
                          />
                        ) : (
                          <p className="text-sm p-3 bg-red-50 rounded border border-red-200">{inspectionData.post_damage_notes}</p>
                        )}
                      </div>
                    )}
                  </div>

                  {canEdit() && inspectionData?.status !== 'submitted' && (
                    <div className="flex justify-end pt-4 border-t">
                      <Button 
                        size="lg"
                        onClick={() => submitInspectionMutation.mutate()}
                        disabled={submitInspectionMutation.isPending}
                        className="bg-zinc-900 hover:bg-zinc-800"
                      >
                        {submitInspectionMutation.isPending ? 'Submitting...' : 'Submit & Lock Inspection'}
                      </Button>
                    </div>
                  )}
                  
                  {inspectionData?.status === 'submitted' && (
                    <div className="flex items-center justify-between pt-4 border-t">
                      <p className="text-sm text-zinc-500">
                        This inspection has been submitted and is viewable in History.
                        {isSecurity && ' You can still edit if needed.'}
                      </p>
                      {isSecurity && (
                        <Button 
                          variant="outline"
                          onClick={() => toast.success('Changes saved automatically')}
                        >
                          Changes Auto-Saved
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-6">
          {!selectedMove ? (
            <Card>
              <CardHeader>
                <CardTitle>Inspection History</CardTitle>
              </CardHeader>
              <CardContent>
                {allInspections.filter(i => i.status === 'submitted').length === 0 ? (
                  <p className="text-zinc-500 text-center py-8">No submitted inspections yet</p>
                ) : (
                  <div className="space-y-3">
                    {allInspections
                      .filter(i => i.status === 'submitted')
                      .map(inspection => (
                        <div key={inspection.id} className="flex items-center justify-between p-4 border rounded-lg hover:bg-zinc-50 transition">
                          <div className="flex-1">
                            <div className="flex items-center gap-3">
                              <span className="font-semibold">Unit {inspection.unit_number}</span>
                              <Badge className="bg-zinc-800 text-white">{inspection.tower}</Badge>
                              <Badge className={inspection.move_outcome === 'clean' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}>
                                {inspection.move_outcome === 'clean' ? 'Clean' : 'Non-Clean'}
                              </Badge>
                            </div>
                            <div className="text-sm text-zinc-500 mt-1">
                              {format(new Date(inspection.move_date), 'PPP')} • Submitted by {inspection.created_by_name}
                              {inspection.last_edited_at && (
                                <span className="ml-2">• Last edited {format(new Date(inspection.last_edited_at), 'PPp')}</span>
                              )}
                            </div>
                          </div>
                          <Button 
                            size="sm"
                            variant="outline"
                            onClick={() => handleViewInspection(inspection)}
                          >
                            <Eye className="w-4 h-4 mr-2" />
                            {isSecurity ? 'View / Edit' : 'View Details'}
                          </Button>
                        </div>
                      ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-6">
              <Button variant="outline" onClick={() => { setSelectedMove(null); setInspectionData(null); }}>
                ← Back to History
              </Button>

              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>Inspection: Unit {selectedMove.unitNumber} {selectedMove.tower}</CardTitle>
                      <p className="text-sm text-zinc-500 mt-1">
                        {format(new Date(selectedMove.date), 'PPP')} • {selectedMove.startTime} - {selectedMove.endTime}
                      </p>
                      {inspectionData?.last_edited_at && (
                        <p className="text-xs text-zinc-400 mt-1">
                          Last edited by {inspectionData.last_edited_by_name} • {format(new Date(inspectionData.last_edited_at), 'PPp')}
                        </p>
                      )}
                    </div>
                    <Badge className="bg-green-100 text-green-700">
                      <CheckCircle2 className="w-3 h-3 mr-1" />
                      Submitted
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-8">
                  {/* Pre-Move Section */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 pb-2 border-b">
                      <Camera className="w-5 h-5 text-blue-600" />
                      <h3 className="text-lg font-semibold">Pre-Move Inspection</h3>
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <PhotoUploadArea phase="pre" area="hallway" label="Hallway" />
                      <PhotoUploadArea phase="pre" area="elevator" label="Elevator" />
                      <PhotoUploadArea phase="pre" area="garage" label="Garage" />
                    </div>

                    <div className="space-y-2">
                      <Label>Do you see any damages beforehand?</Label>
                      {canEdit() ? (
                        <div className="flex gap-2">
                          <Button
                            variant={inspectionData?.pre_damage_found === true ? 'default' : 'outline'}
                            onClick={() => updateInspectionMutation.mutate({ pre_damage_found: true })}
                          >
                            Yes
                          </Button>
                          <Button
                            variant={inspectionData?.pre_damage_found === false ? 'default' : 'outline'}
                            onClick={() => updateInspectionMutation.mutate({ pre_damage_found: false })}
                          >
                            No
                          </Button>
                        </div>
                      ) : (
                        <Badge variant="outline">
                          {inspectionData?.pre_damage_found ? 'Yes' : 'No'}
                        </Badge>
                      )}
                    </div>

                    {inspectionData?.pre_damage_found && (
                      <div className="space-y-2">
                        <Label>Pre-Damage Notes</Label>
                        {canEdit() ? (
                          <Textarea
                            value={inspectionData.pre_damage_notes || ''}
                            onChange={(e) => updateInspectionMutation.mutate({ pre_damage_notes: e.target.value })}
                            placeholder="Describe any pre-existing damage..."
                            rows={3}
                          />
                        ) : (
                          <p className="text-sm p-3 bg-zinc-50 rounded border">{inspectionData.pre_damage_notes || 'None'}</p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Post-Move Section */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 pb-2 border-b">
                      <Camera className="w-5 h-5 text-green-600" />
                      <h3 className="text-lg font-semibold">Post-Move Inspection</h3>
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <PhotoUploadArea phase="post" area="hallway" label="Hallway" />
                      <PhotoUploadArea phase="post" area="elevator" label="Elevator" />
                      <PhotoUploadArea phase="post" area="garage" label="Garage" />
                    </div>

                    <div className="space-y-2">
                      <Label>Move Outcome</Label>
                      {canEdit() ? (
                        <div className="flex gap-2">
                          <Button
                            variant={inspectionData?.move_outcome === 'clean' ? 'default' : 'outline'}
                            onClick={() => updateInspectionMutation.mutate({ move_outcome: 'clean', post_damage_found: false })}
                            className={inspectionData?.move_outcome === 'clean' ? 'bg-green-600 hover:bg-green-700 text-white' : ''}
                          >
                            <CheckCircle2 className="w-4 h-4 mr-2" />
                            Clean Move
                          </Button>
                          <Button
                            variant={inspectionData?.move_outcome === 'non_clean' ? 'destructive' : 'outline'}
                            onClick={() => updateInspectionMutation.mutate({ move_outcome: 'non_clean', post_damage_found: true })}
                          >
                            <AlertCircle className="w-4 h-4 mr-2" />
                            Non-Clean Move
                          </Button>
                        </div>
                      ) : (
                        <Badge className={inspectionData?.move_outcome === 'clean' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}>
                          {inspectionData?.move_outcome === 'clean' ? 'Clean Move' : 'Non-Clean Move'}
                        </Badge>
                      )}
                    </div>

                    {inspectionData?.move_outcome === 'non_clean' && (
                      <div className="space-y-2">
                        <Label>Post-Damage Notes (Required)</Label>
                        {canEdit() ? (
                          <Textarea
                            value={inspectionData.post_damage_notes || ''}
                            onChange={(e) => updateInspectionMutation.mutate({ post_damage_notes: e.target.value })}
                            placeholder="Describe any damage found after the move..."
                            rows={4}
                            required
                          />
                        ) : (
                          <p className="text-sm p-3 bg-red-50 rounded border border-red-200">{inspectionData.post_damage_notes}</p>
                        )}
                      </div>
                    )}
                  </div>

                  {isSecurity && (
                    <div className="flex items-center justify-between pt-4 border-t">
                      <p className="text-sm text-zinc-500">
                        Editing a submitted inspection. Changes are saved automatically.
                      </p>
                      <Button 
                        variant="outline"
                        onClick={() => toast.success('Changes saved automatically')}
                      >
                        Changes Auto-Saved
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {photoViewerOpen && (
        <PhotoViewer 
          photos={viewerPhotos}
          onClose={() => setPhotoViewerOpen(false)}
        />
      )}
    </div>
  );
}
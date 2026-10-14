import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import UnitCombobox from '@/components/UnitCombobox';
import PhotoViewer from '@/components/PhotoViewer';
import { ScanLine, RefreshCw, Upload, X, CheckCircle, Search, Filter, ZoomIn } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from "sonner";
import { motion, AnimatePresence } from 'framer-motion';

export default function SecurityPackages() {
  const [selectedTower, setSelectedTower] = useState('');
  const [selectedUnitId, setSelectedUnitId] = useState('');
  const [selectedUnit, setSelectedUnit] = useState(null);
  const [selectedRecipientId, setSelectedRecipientId] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [notes, setNotes] = useState('');
  const [packagePhotos, setPackagePhotos] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [showSuccessAnimation, setShowSuccessAnimation] = useState(false);
  const [successPackageId, setSuccessPackageId] = useState(null);
  
  // Recent Activity filters
  const [filterTower, setFilterTower] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterDateRange, setFilterDateRange] = useState('7');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('date');
  const [selectedPackage, setSelectedPackage] = useState(null);
  const [photoViewerPhotos, setPhotoViewerPhotos] = useState(null);
  const [photoViewerIndex, setPhotoViewerIndex] = useState(0);
  
  const queryClient = useQueryClient();

  const { data: packages } = useQuery({
    queryKey: ['all-packages'],
    queryFn: () => base44.entities.Package.list('-created_date', 200),
  });

  // Get all users for "Logged by" display
  const { data: allUsers } = useQuery({
    queryKey: ['all-users'],
    queryFn: () => base44.entities.User.list(),
    staleTime: 10 * 60 * 1000,
  });

  // Filter and sort packages
  const filteredPackages = React.useMemo(() => {
    if (!packages) return [];
    
    let filtered = [...packages];
    
    // Date range filter
    const now = new Date();
    const daysAgo = parseInt(filterDateRange);
    const cutoffDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    filtered = filtered.filter(pkg => new Date(pkg.created_date) >= cutoffDate);
    
    // Tower filter
    if (filterTower) {
      filtered = filtered.filter(pkg => pkg.tower === filterTower);
    }
    
    // Status filter
    if (filterStatus) {
      filtered = filtered.filter(pkg => pkg.status === filterStatus);
    }
    
    // Search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(pkg => 
        pkg.unit_number?.toLowerCase().includes(query) ||
        pkg.recipient_name?.toLowerCase().includes(query) ||
        pkg.notes?.toLowerCase().includes(query)
      );
    }
    
    // Sort
    if (sortBy === 'date') {
      filtered.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
    } else if (sortBy === 'unit') {
      filtered.sort((a, b) => (a.unit_number || '').localeCompare(b.unit_number || ''));
    } else if (sortBy === 'recipient') {
      filtered.sort((a, b) => (a.recipient_name || '').localeCompare(b.recipient_name || ''));
    }
    
    return filtered;
  }, [packages, filterTower, filterStatus, filterDateRange, searchQuery, sortBy]);

  const { data: units } = useQuery({
    queryKey: ['units', selectedTower],
    queryFn: async () => {
      if (!selectedTower) return [];
      return await base44.entities.Unit.filter({ tower: selectedTower, active: true }, 'unit_number', 500);
    },
    enabled: !!selectedTower,
    staleTime: 5 * 60 * 1000,
  });

  const { data: residentsForUnit } = useQuery({
    queryKey: ['residents-for-unit', selectedUnitId],
    queryFn: async () => {
      if (!selectedUnitId) return [];
      const profiles = await base44.entities.Profile.filter({ unit_id: selectedUnitId });
      return profiles.filter(p => p.userId); // Only approved residents with user accounts
    },
    enabled: !!selectedUnitId,
    staleTime: 5 * 60 * 1000,
  });

  React.useEffect(() => {
    if (selectedUnitId && units) {
      const unit = units.find(u => u.id === selectedUnitId);
      setSelectedUnit(unit);
      setSelectedRecipientId('');
      setRecipientName('');
    }
  }, [selectedUnitId, units]);

  const handleTowerChange = (tower) => {
    setSelectedTower(tower);
    setSelectedUnitId('');
    setSelectedUnit(null);
    setSelectedRecipientId('');
    setRecipientName('');
  };

  const handleUnitChange = (unitId) => {
    setSelectedUnitId(unitId);
    setSelectedRecipientId('');
    setRecipientName('');
  };

  const handleRecipientChange = (value) => {
    if (value === 'unknown') {
      setSelectedRecipientId('');
      setRecipientName('Unknown Recipient');
    } else {
      setSelectedRecipientId(value);
      const resident = residentsForUnit?.find(r => r.id === value);
      setRecipientName(resident?.full_name || '');
    }
  };

  const handlePhotoUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    
    setUploading(true);
    try {
      const uploadPromises = files.map(file => base44.integrations.Core.UploadFile({ file }));
      const results = await Promise.all(uploadPromises);
      const urls = results.map(r => r.file_url);
      setPackagePhotos(prev => [...prev, ...urls]);
      toast.success(`${files.length} photo(s) uploaded`);
    } catch (error) {
      toast.error('Failed to upload photos');
    } finally {
      setUploading(false);
    }
  };

  const removePhoto = (urlToRemove) => {
    setPackagePhotos(prev => prev.filter(url => url !== urlToRemove));
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      console.log('🔍 MUTATION START - Validating fields...');
      console.log('Selected Unit ID:', selectedUnitId);
      console.log('Recipient Name:', recipientName);
      console.log('Package Photos:', packagePhotos.length);
      
      if (!selectedUnitId) {
        throw new Error('❌ Validation failed: Please select a unit');
      }
      if (!recipientName) {
        throw new Error('❌ Validation failed: Please select a recipient');
      }
      if (packagePhotos.length === 0) {
        throw new Error('❌ Validation failed: At least one photo is required');
      }

      console.log('✅ Validation passed, fetching current user...');
      const currentUser = await base44.auth.me();
      console.log('Current user:', currentUser?.id, currentUser?.email);
      
      if (!currentUser?.id) {
        throw new Error('❌ Authentication failed: User not logged in');
      }
      
      console.log('📦 Fetching unit details...');
      const units = await base44.entities.Unit.filter({ id: selectedUnitId });
      console.log('Units found:', units.length);
      
      if (!units || units.length === 0) {
        throw new Error(`❌ Unit not found with ID: ${selectedUnitId}`);
      }
      
      const unit = units[0];
      console.log('Unit data:', unit);
      
      const packageData = {
        unit_id: selectedUnitId,
        recipient_profile_id: selectedRecipientId || null,
        recipient_name: recipientName,
        status: 'ready_for_pickup',
        notes: notes || '',
        packagePhotoUrls: packagePhotos,
        photoUploadedAt: new Date().toISOString(),
        photoUploadedBySecurityUserId: currentUser.id,
        // Legacy fields for backward compatibility
        unit_number: unit.unit_number,
        tower: unit.tower
      };
      
      console.log('📤 Attempting to create Package with data:', JSON.stringify(packageData, null, 2));
      
      let pkg;
      try {
        pkg = await base44.entities.Package.create(packageData);
        console.log('✅ Package created successfully:', pkg.id);
      } catch (createError) {
        console.error('❌ Package.create() failed:', createError);
        console.error('Error details:', {
          message: createError.message,
          stack: createError.stack,
          response: createError.response
        });
        throw new Error(`Database insert failed: ${createError.message || 'Unknown error'}`);
      }
      
      console.log('📧 Sending notifications...');
      
      // Send notifications
      try {
        if (selectedRecipientId) {
          // Notify specific recipient
          const profiles = await base44.entities.Profile.filter({ id: selectedRecipientId });
          const profile = profiles[0];
          if (profile?.userId) {
            const users = await base44.entities.User.filter({ id: profile.userId });
            const user = users[0];
            if (user?.id) {
              await base44.entities.Notification.create({
                title: 'Package Arrived',
                message: `A package has arrived for you. Pick it up at the front desk.`,
                type: 'package',
                target_user_id: user.id,
                link: 'packages'
              });
            }
          }
        } else {
          // Unknown recipient - notify all residents in the unit
          const residentsInUnit = await base44.entities.Profile.filter({ unit_id: selectedUnitId });
          for (const resident of residentsInUnit) {
            if (resident.userId) {
              await base44.entities.Notification.create({
                title: 'Package Arrived',
                message: `A package has arrived for Unit ${unit.display_unit}. Pick it up at the front desk.`,
                type: 'package',
                target_user_id: resident.userId,
                link: 'packages'
              });
            }
          }
        }
      } catch (notificationError) {
        console.warn('⚠️ Notification sending failed (non-critical):', notificationError);
      }
      
      // Send email if recipient has profile
      try {
        if (selectedRecipientId) {
          const profiles = await base44.entities.Profile.filter({ id: selectedRecipientId });
          const profile = profiles[0];
          if (profile?.userId) {
            const users = await base44.entities.User.filter({ id: profile.userId });
            const user = users[0];
            if (user?.email) {
              await base44.integrations.Core.SendEmail({
                to: user.email,
                subject: 'EstWest: Package Delivery',
                body: `
                  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <div style="background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); padding: 30px; text-align: center;">
                      <h1 style="color: white; margin: 0; font-size: 24px;">📦 Package Arrived</h1>
                    </div>
                    <div style="padding: 30px; background: #ffffff;">
                      <h2 style="color: #18181b; margin-top: 0;">Hello ${recipientName}!</h2>
                      <p style="color: #52525b; line-height: 1.6; font-size: 16px;">
                        A package has arrived for you at the front desk.
                      </p>
                      <div style="background: #f4f4f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <p style="margin: 5px 0;"><strong>Unit:</strong> ${unit.display_unit}</p>
                        ${notes ? `<p style="margin: 5px 0;"><strong>Notes:</strong> ${notes}</p>` : ''}
                      </div>
                      <p style="color: #71717a; font-size: 14px;">Please pick up your package at your earliest convenience.</p>
                    </div>
                  </div>
                `
              });
            }
          }
        }
      } catch (error) {
        console.warn('⚠️ Email sending failed (non-critical):', error);
      }
      
      console.log('✅ MUTATION COMPLETE - Returning package:', pkg.id);
      return pkg;
    },
    onSuccess: (newPackage) => {
      console.log('🎉 SUCCESS CALLBACK FIRED - Package created:', newPackage.id);
      
      // Store package ID for display
      setSuccessPackageId(newPackage.id);
      
      // Show animated success overlay
      setShowSuccessAnimation(true);
      
      // DEBUG: Confirm success callback fired
      toast.success(`✅ Success UI triggered: ${newPackage.id}`, { duration: 3000 });
      
      // Auto-hide after 2 seconds
      setTimeout(() => {
        console.log('🎉 Hiding success overlay');
        setShowSuccessAnimation(false);
        setSuccessPackageId(null);
      }, 2000);
      
      // Immediately refetch to update Recent Activity
      queryClient.invalidateQueries(['all-packages']);
      
      // Reset form
      setSelectedTower('');
      setSelectedUnitId('');
      setSelectedUnit(null);
      setSelectedRecipientId('');
      setRecipientName('');
      setNotes('');
      setPackagePhotos([]);
    },
    onError: (error) => {
      console.error('❌ ========== PACKAGE LOGGING ERROR ==========');
      console.error('Error object:', error);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      console.error('===========================================');
      
      // Show detailed error to user
      const errorMessage = error.message || 'Unknown error occurred';
      toast.error(
        <div>
          <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>Failed to log package</div>
          <div style={{ fontSize: '14px' }}>{errorMessage}</div>
        </div>, 
        { 
          duration: 8000,
          style: { 
            background: '#fef2f2', 
            color: '#991b1b',
            border: '2px solid #fca5a5',
            padding: '16px'
          }
        }
      );
    }
  });

  const pickupMutation = useMutation({
    mutationFn: async (id) => {
      const currentUser = await base44.auth.me();
      return base44.entities.Package.update(id, { 
        status: 'picked_up', 
        picked_up_at: new Date().toISOString(),
        picked_up_by_user_id: currentUser.id,
        pickup_method: 'security'
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['all-packages']);
      toast.success("Package marked as picked up");
    },
    onError: () => {
      toast.error("Failed to mark package as picked up");
    }
  });

  const handleLog = (e) => {
    e.preventDefault();
    console.log('========================================');
    console.log('🚀 LOG PACKAGE BUTTON CLICKED');
    console.log('========================================');
    console.log('Form state at submission:');
    console.log('- selectedTower:', selectedTower);
    console.log('- selectedUnitId:', selectedUnitId);
    console.log('- selectedUnit:', selectedUnit);
    console.log('- selectedRecipientId:', selectedRecipientId);
    console.log('- recipientName:', recipientName);
    console.log('- notes:', notes);
    console.log('- packagePhotos count:', packagePhotos.length);
    console.log('========================================');
    console.log('Starting mutation...');
    
    try {
      createMutation.mutate();
    } catch (error) {
      console.error('❌ Error calling mutate():', error);
      toast.error(`Failed to start mutation: ${error.message}`);
    }
  };

  return (
    <>
      {/* Full-Screen Success Overlay - IMPOSSIBLE TO MISS */}
      {showSuccessAnimation && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            backgroundColor: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            zIndex: 99999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <AnimatePresence>
            <motion.div
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.5, opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 20 }}
              style={{
                backgroundColor: 'white',
                borderRadius: '24px',
                padding: '48px',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '24px',
                maxWidth: '90vw',
              }}
            >
              {/* Animated Green Check Circle */}
              <motion.div
                initial={{ scale: 0, rotate: -180 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ 
                  type: "spring", 
                  stiffness: 400, 
                  damping: 15,
                  delay: 0.1
                }}
                style={{
                  width: '120px',
                  height: '120px',
                  borderRadius: '50%',
                  backgroundColor: '#22c55e',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 10px 30px rgba(34, 197, 94, 0.3)',
                }}
              >
                <CheckCircle 
                  className="text-white" 
                  style={{ width: '80px', height: '80px', strokeWidth: 2.5 }}
                />
              </motion.div>

              {/* Success Text */}
              <motion.h2
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                style={{
                  fontSize: '40px',
                  fontWeight: 'bold',
                  color: '#18181b',
                  textAlign: 'center',
                  margin: 0,
                }}
              >
                Package Logged!
              </motion.h2>

              {/* Package ID Display */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                style={{
                  fontSize: '18px',
                  color: '#71717a',
                  textAlign: 'center',
                  backgroundColor: '#f4f4f5',
                  padding: '12px 24px',
                  borderRadius: '12px',
                  fontFamily: 'monospace',
                }}
              >
                <div style={{ fontSize: '14px', opacity: 0.7, marginBottom: '4px' }}>Package ID:</div>
                <div style={{ fontWeight: 'bold', fontSize: '20px' }}>{successPackageId}</div>
              </motion.div>

              {/* Debug Fallback - Plain Text */}
              <div style={{ 
                fontSize: '100px', 
                lineHeight: 1,
                position: 'absolute',
                opacity: 0.05,
                pointerEvents: 'none'
              }}>
                ✅
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      )}

      <div className="space-y-8">
      <div className="grid lg:grid-cols-3 gap-8">
        <Card className="lg:col-span-1 h-fit sticky top-8 border-zinc-200 shadow-lg shadow-zinc-100">
            <CardHeader className="bg-zinc-50 border-b border-zinc-100">
                <CardTitle className="flex items-center gap-2 text-lg">
                    <ScanLine className="w-5 h-5 text-blue-600" /> Log Incoming Package
                </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
                <form onSubmit={handleLog} className="space-y-4">
                    <div>
                        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Tower</label>
                        <Select value={selectedTower} onValueChange={handleTowerChange} required>
                          <SelectTrigger>
                            <SelectValue placeholder="Select tower" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="E">E (EST)</SelectItem>
                            <SelectItem value="W">W (WEST)</SelectItem>
                          </SelectContent>
                        </Select>
                    </div>

                    <div>
                        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Unit Number</label>
                        <UnitCombobox
                          units={units || []}
                          value={selectedUnitId}
                          onChange={handleUnitChange}
                          placeholder="Type to search units..."
                          disabled={!selectedTower}
                        />
                        {!selectedTower && (
                          <p className="text-xs text-zinc-400 mt-1">Select a tower first</p>
                        )}
                    </div>

                    <div>
                        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Recipient</label>
                        {!selectedUnitId ? (
                          <div className="text-sm text-zinc-400 p-3 border border-dashed rounded-lg">
                            Select a unit first
                          </div>
                        ) : residentsForUnit && residentsForUnit.length === 0 ? (
                          <Select value={recipientName ? 'unknown' : ''} onValueChange={handleRecipientChange} required>
                            <SelectTrigger>
                              <SelectValue placeholder="No residents linked" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="unknown">Unknown Recipient</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Select value={selectedRecipientId || (recipientName === 'Unknown Recipient' ? 'unknown' : '')} onValueChange={handleRecipientChange} required>
                            <SelectTrigger>
                              <SelectValue placeholder="Select recipient" />
                            </SelectTrigger>
                            <SelectContent>
                              {residentsForUnit?.map((resident) => (
                                <SelectItem key={resident.id} value={resident.id}>
                                  {resident.full_name} - Unit {selectedUnit?.display_unit}
                                </SelectItem>
                              ))}
                              <SelectItem value="unknown">Unknown Recipient</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                        {residentsForUnit && residentsForUnit.length === 0 && (
                          <p className="text-xs text-amber-600 mt-1">⚠️ No residents linked to this unit. Notify management.</p>
                        )}
                    </div>
                    <div>
                        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex items-center gap-1">
                            Package Photo <span className="text-red-500">*</span>
                        </label>
                        <div className="space-y-3">
                            <div className="relative">
                                <input
                                    type="file"
                                    accept="image/*"
                                    multiple
                                    onChange={handlePhotoUpload}
                                    className="hidden"
                                    id="package-photo-upload"
                                    disabled={uploading}
                                />
                                <label
                                    htmlFor="package-photo-upload"
                                    className="flex items-center justify-center gap-2 w-full p-3 border-2 border-dashed border-zinc-300 rounded-lg hover:border-blue-400 hover:bg-blue-50 transition-colors cursor-pointer"
                                >
                                    <Upload className="w-4 h-4 text-zinc-500" />
                                    <span className="text-sm text-zinc-600">
                                        {uploading ? 'Uploading...' : 'Upload Package Photo'}
                                    </span>
                                </label>
                            </div>
                            {packagePhotos.length > 0 && (
                                <div className="grid grid-cols-2 gap-2">
                                    {packagePhotos.map((url, idx) => (
                                        <div key={idx} className="relative group">
                                            <img src={url} alt="Package" className="w-full h-24 object-cover rounded-lg border border-zinc-200" />
                                            <button
                                                type="button"
                                                onClick={() => removePhoto(url)}
                                                className="absolute top-1 right-1 p-1 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                                            >
                                                <X className="w-3 h-3" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                    <div>
                        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Notes</label>
                        <Textarea 
                            placeholder="Damage, location, etc." 
                            value={notes}
                            onChange={e => setNotes(e.target.value)}
                        />
                    </div>
                    <Button 
                        type="submit" 
                        className="w-full bg-blue-600 hover:bg-blue-700" 
                        disabled={createMutation.isPending || packagePhotos.length === 0 || !selectedUnitId || !recipientName || showSuccessAnimation}
                    >
                        {createMutation.isPending ? 'Logging...' : 'Log Package'}
                    </Button>
                    {packagePhotos.length === 0 && (
                        <p className="text-xs text-amber-600 text-center">📸 At least 1 photo required</p>
                    )}
                    {(!selectedUnitId || !recipientName) && packagePhotos.length > 0 && (
                        <p className="text-xs text-amber-600 text-center">⚠️ Select tower, unit, and recipient</p>
                    )}
                </form>
            </CardContent>
        </Card>

        <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold">Recent Activity</h2>
                <Button variant="ghost" size="sm" onClick={() => queryClient.invalidateQueries(['all-packages'])}>
                    <RefreshCw className="w-4 h-4 mr-2" /> Refresh
                </Button>
            </div>

            {/* Filters and Search */}
            <Card className="border-zinc-200">
              <CardContent className="p-4">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
                    <Input
                      placeholder="Search unit, recipient..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                  
                  <Select value={sortBy} onValueChange={setSortBy}>
                    <SelectTrigger>
                      <SelectValue placeholder="Sort by" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="date">Date (Newest)</SelectItem>
                      <SelectItem value="unit">Unit Number</SelectItem>
                      <SelectItem value="recipient">Recipient Name</SelectItem>
                    </SelectContent>
                  </Select>

                  <Select value={filterTower} onValueChange={setFilterTower}>
                    <SelectTrigger>
                      <SelectValue placeholder="All Towers" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={null}>All Towers</SelectItem>
                      <SelectItem value="E">Tower E (EST)</SelectItem>
                      <SelectItem value="W">Tower W (WEST)</SelectItem>
                    </SelectContent>
                  </Select>

                  <Select value={filterStatus} onValueChange={setFilterStatus}>
                    <SelectTrigger>
                      <SelectValue placeholder="All Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={null}>All Status</SelectItem>
                      <SelectItem value="ready_for_pickup">Ready for Pickup</SelectItem>
                      <SelectItem value="picked_up">Picked Up</SelectItem>
                    </SelectContent>
                  </Select>

                  <Select value={filterDateRange} onValueChange={setFilterDateRange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Date Range" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">Today</SelectItem>
                      <SelectItem value="7">Last 7 Days</SelectItem>
                      <SelectItem value="30">Last 30 Days</SelectItem>
                      <SelectItem value="90">Last 90 Days</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
                  <Filter className="w-3 h-3" />
                  Showing {filteredPackages.length} of {packages?.length || 0} packages
                </div>
              </CardContent>
            </Card>

            <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
                <Table>
                    <TableHeader>
                        <TableRow className="bg-zinc-50">
                            <TableHead>Time</TableHead>
                            <TableHead>Unit</TableHead>
                            <TableHead>Recipient</TableHead>
                            <TableHead>Photo</TableHead>
                            <TableHead>Logged By</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Action</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {filteredPackages.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={7} className="text-center py-8 text-zinc-400">
                              No packages found matching your filters
                            </TableCell>
                          </TableRow>
                        ) : (
                          filteredPackages.map(pkg => {
                            const loggedByUser = allUsers?.find(u => u.id === pkg.photoUploadedBySecurityUserId);
                            return (
                              <TableRow key={pkg.id} className="hover:bg-zinc-50/50">
                                <TableCell className="text-zinc-500">
                                    {format(new Date(pkg.created_date), 'MMM d, HH:mm')}
                                </TableCell>
                                <TableCell>
                                  <div className="font-medium">{pkg.unit_number}</div>
                                  <div className="text-xs text-zinc-400">Tower {pkg.tower}</div>
                                </TableCell>
                                <TableCell>
                                  <div className="font-medium">{pkg.recipient_name}</div>
                                  {pkg.notes && (
                                    <div className="text-xs text-zinc-400 mt-1 max-w-[200px] truncate" title={pkg.notes}>
                                      {pkg.notes}
                                    </div>
                                  )}
                                </TableCell>
                                <TableCell>
                                    {pkg.packagePhotoUrls && pkg.packagePhotoUrls.length > 0 ? (
                                        <button
                                          onClick={() => {
                                            setPhotoViewerPhotos(pkg.packagePhotoUrls);
                                            setPhotoViewerIndex(0);
                                          }}
                                          className="relative group"
                                        >
                                          <img 
                                            src={pkg.packagePhotoUrls[0]} 
                                            alt="Package" 
                                            className="w-12 h-12 object-cover rounded border border-zinc-200 group-hover:border-blue-400 transition-colors" 
                                          />
                                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 rounded flex items-center justify-center transition-colors">
                                            <ZoomIn className="w-4 h-4 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                                          </div>
                                          {pkg.packagePhotoUrls.length > 1 && (
                                            <div className="absolute -top-1 -right-1 bg-blue-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold">
                                              {pkg.packagePhotoUrls.length}
                                            </div>
                                          )}
                                        </button>
                                    ) : (
                                        <span className="text-xs text-zinc-400">No photo</span>
                                    )}
                                </TableCell>
                                <TableCell className="text-xs text-zinc-500">
                                  {loggedByUser?.full_name || 'Security'}
                                </TableCell>
                                <TableCell>
                                    {pkg.status === 'ready_for_pickup' ? (
                                        <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-200 border-amber-200">Ready</Badge>
                                    ) : pkg.status === 'picked_up' ? (
                                        <Badge className="bg-green-100 text-green-800 hover:bg-green-200 border-green-200">Picked Up</Badge>
                                    ) : (
                                        <Badge className="bg-zinc-100 text-zinc-500 hover:bg-zinc-200 border-zinc-200">{pkg.status}</Badge>
                                    )}
                                </TableCell>
                                <TableCell className="text-right">
                                    {pkg.status === 'ready_for_pickup' && (
                                        <Button 
                                            size="sm" 
                                            variant="outline"
                                            className="text-green-600 hover:text-green-700 hover:bg-green-50 border-green-200"
                                            onClick={() => pickupMutation.mutate(pkg.id)}
                                            disabled={pickupMutation.isPending}
                                        >
                                            Mark Picked Up
                                        </Button>
                                    )}
                                    {pkg.status === 'picked_up' && (
                                        <div className="text-xs text-zinc-500">
                                            <div>Picked up</div>
                                            <div>{pkg.picked_up_at && format(new Date(pkg.picked_up_at), 'MMM d, HH:mm')}</div>
                                        </div>
                                    )}
                                </TableCell>
                              </TableRow>
                            );
                          })
                        )}
                    </TableBody>
                </Table>
            </div>
        </div>
      </div>
    </div>

    {/* Package Details Dialog */}
    <Dialog open={!!selectedPackage} onOpenChange={() => setSelectedPackage(null)}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Package Details</DialogTitle>
        </DialogHeader>
        {selectedPackage && (
          <div className="space-y-6">
            {/* Package Photos */}
            {selectedPackage.packagePhotoUrls && selectedPackage.packagePhotoUrls.length > 0 && (
              <div className="space-y-2">
                <h3 className="font-semibold text-sm text-zinc-700">Package Photos</h3>
                <div className="grid grid-cols-2 gap-3">
                  {selectedPackage.packagePhotoUrls.map((url, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        setPhotoViewerPhotos(selectedPackage.packagePhotoUrls);
                        setPhotoViewerIndex(idx);
                      }}
                      className="block relative group"
                    >
                      <img 
                        src={url} 
                        alt={`Package photo ${idx + 1}`} 
                        className="w-full h-48 object-cover rounded-lg border border-zinc-200 hover:border-blue-400 transition-colors" 
                      />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 rounded-lg flex items-center justify-center transition-colors">
                        <ZoomIn className="w-8 h-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Package Info */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Unit</div>
                <div className="font-semibold">{selectedPackage.unit_number} {selectedPackage.tower}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Recipient</div>
                <div className="font-semibold">{selectedPackage.recipient_name}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Status</div>
                <div>
                  {selectedPackage.status === 'ready_for_pickup' ? (
                    <Badge className="bg-amber-100 text-amber-800 border-amber-200">Ready for Pickup</Badge>
                  ) : (
                    <Badge className="bg-green-100 text-green-800 border-green-200">Picked Up</Badge>
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Logged At</div>
                <div className="text-sm">{format(new Date(selectedPackage.created_date), 'MMM d, yyyy HH:mm')}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Logged By</div>
                <div className="text-sm">
                  {allUsers?.find(u => u.id === selectedPackage.photoUploadedBySecurityUserId)?.full_name || 'Security Staff'}
                </div>
              </div>
              {selectedPackage.status === 'picked_up' && selectedPackage.picked_up_at && (
                <div>
                  <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Picked Up At</div>
                  <div className="text-sm">{format(new Date(selectedPackage.picked_up_at), 'MMM d, yyyy HH:mm')}</div>
                </div>
              )}
            </div>

            {/* Notes */}
            {selectedPackage.notes && (
              <div>
                <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Notes</div>
                <div className="bg-zinc-50 p-3 rounded-lg text-sm">{selectedPackage.notes}</div>
              </div>
            )}

            {/* Action Button */}
            {selectedPackage.status === 'ready_for_pickup' && (
              <Button
                className="w-full bg-green-600 hover:bg-green-700"
                onClick={() => {
                  pickupMutation.mutate(selectedPackage.id);
                  setSelectedPackage(null);
                }}
                disabled={pickupMutation.isPending}
              >
                Mark as Picked Up
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>

    {/* Photo Viewer */}
    {photoViewerPhotos && (
      <PhotoViewer
        photos={photoViewerPhotos}
        initialIndex={photoViewerIndex}
        onClose={() => setPhotoViewerPhotos(null)}
      />
    )}
    </>
  );
}
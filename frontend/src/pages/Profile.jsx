import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { User, Phone, Home, Car, Settings, Upload, Plus, Trash2, Save, Moon } from 'lucide-react';
import ParkingProofRequestSection from '@/components/ParkingProofRequestSection';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { useLanguage } from '@/lib/LanguageContext';
import { useDarkMode } from '@/lib/useDarkMode';

export default function ProfilePage() {
  const { t, lang, setLang, LANGUAGES } = useLanguage();
  const { colorScheme, setColorScheme } = useDarkMode();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [user, setUser] = useState(null);
  const [formData, setFormData] = useState({
    full_name: '',
    additional_occupants: [],
    preferred_name: '',
    primary_phone: '',
    secondary_phone: '',
    emergency_contact_name: '',
    emergency_contact_phone: '',
    language_preference: 'English',
    unit_number: '',
    residency_type: 'owner',
    move_in_date: '',
    lease_end_date: '',
    vehicles: [],
    notification_settings: {
      maintenance: true,
      packages: true,
      announcements: true
    },
    preferred_contact_method: 'email',
    lease_document_url: '',
    insurance_info_url: ''
  });
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [unitLocked, setUnitLocked] = useState(false);
  const [residentProfile, setResidentProfile] = useState(null);

  const queryClient = useQueryClient();

  useEffect(() => {
    const loadUser = async () => {
      const currentUser = await base44.auth.me();
      setUser(currentUser);
    };
    loadUser();
  }, []);

  const { data: profile, isLoading } = useQuery({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const profiles = await base44.entities.Profile.filter({ userId: user.id });
      return profiles.length > 0 ? profiles[0] : null;
    },
    enabled: !!user?.id
  });

  const { data: residentProfileData } = useQuery({
    queryKey: ['resident-profile', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const profiles = await base44.entities.ResidentProfile.filter({ user_id: user.id });
      return profiles.length > 0 ? profiles[0] : null;
    },
    enabled: !!user?.id
  });

  useEffect(() => {
    if (profile) {
      setFormData({
        full_name: profile.full_name || user?.full_name || '',
        additional_occupants: profile.additional_occupants || [],
        preferred_name: profile.preferred_name || '',
        primary_phone: profile.primary_phone || '',
        secondary_phone: profile.secondary_phone || '',
        emergency_contact_name: profile.emergency_contact_name || '',
        emergency_contact_phone: profile.emergency_contact_phone || '',
        language_preference: profile.language_preference || 'English',
        unit_number: profile.unit_number || '',
        residency_type: profile.residency_type || 'owner',
        move_in_date: profile.move_in_date || '',
        lease_end_date: profile.lease_end_date || '',
        vehicles: profile.vehicles || [],
        notification_settings: profile.notification_settings || {
          maintenance: true,
          packages: true,
          announcements: true
        },
        preferred_contact_method: profile.preferred_contact_method || 'email',
        lease_document_url: profile.lease_document_url || '',
        insurance_info_url: profile.insurance_info_url || ''
      });
      // Lock unit number immediately for residents when profile exists
      setUnitLocked(true);
    } else if (residentProfileData) {
      // No Profile yet but ResidentProfile exists - populate from ResidentProfile
      setFormData({
        full_name: residentProfileData.full_name || user?.full_name || '',
        additional_occupants: [],
        preferred_name: '',
        primary_phone: '',
        secondary_phone: '',
        emergency_contact_name: '',
        emergency_contact_phone: '',
        language_preference: 'English',
        unit_number: residentProfileData.unit_number || '',
        residency_type: 'owner',
        move_in_date: residentProfileData.move_in_date || '',
        lease_end_date: '',
        vehicles: residentProfileData.vehicles || [],
        notification_settings: {
          maintenance: true,
          packages: true,
          announcements: true
        },
        preferred_contact_method: 'email',
        lease_document_url: residentProfileData.lease_document_url || '',
        insurance_info_url: residentProfileData.insurance_document_url || ''
      });
      // Lock unit number for pending residents too
      setUnitLocked(true);
    }
  }, [profile, residentProfileData, user]);

  useEffect(() => {
    if (residentProfileData) {
      setResidentProfile(residentProfileData);
    }
  }, [residentProfileData]);

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      // Validate unique plate numbers within unit
      const plates = data.vehicles.map(v => v.plate_number).filter(Boolean);
      if (plates.length !== new Set(plates).size) {
        throw new Error('Vehicle plate numbers must be unique');
      }

      // Prevent unit number changes for residents after initial save
      if (user.account_type === 'resident' && profile?.unit_number && data.unit_number !== profile.unit_number) {
        throw new Error('Unit number cannot be changed. Contact management for assistance.');
      }

      const payload = {
        userId: user.id,
        full_name: profile?.full_name || data.full_name,
        additional_occupants: data.additional_occupants,
        preferred_name: data.preferred_name,
        primary_phone: data.primary_phone,
        secondary_phone: data.secondary_phone,
        emergency_contact_name: data.emergency_contact_name,
        emergency_contact_phone: data.emergency_contact_phone,
        language_preference: data.language_preference,
        unit_number: data.unit_number,
        residency_type: data.residency_type,
        move_in_date: data.move_in_date,
        lease_end_date: data.lease_end_date,
        vehicles: data.vehicles,
        notification_settings: data.notification_settings,
        preferred_contact_method: data.preferred_contact_method,
        lease_document_url: data.lease_document_url,
        insurance_info_url: data.insurance_info_url
      };

      // Save profile
      let savedProfile;
      if (profile) {
        savedProfile = await base44.entities.Profile.update(profile.id, payload);
      } else {
        savedProfile = await base44.entities.Profile.create(payload);
      }

      // Submit for approval if both documents uploaded and no ResidentProfile exists
      if (user.account_type === 'resident' && data.lease_document_url && data.insurance_info_url && !residentProfile) {
        await base44.entities.ResidentProfile.create({
          user_id: user.id,
          full_name: data.full_name,
          unit_number: data.unit_number,
          move_in_date: data.move_in_date,
          parking_spot: data.vehicles?.[0]?.parking_spot || '',
          vehicles: data.vehicles,
          lease_document_url: data.lease_document_url,
          insurance_document_url: data.insurance_info_url,
          status: 'pending_approval',
          submitted_for_approval_at: new Date().toISOString()
        });
        toast.success('Profile submitted for approval');
      }

      // Note: Name changes are handled by management/security only

      return savedProfile;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      queryClient.invalidateQueries({ queryKey: ['resident-profile'] });
      toast.success('Profile saved successfully');
      setTimeout(() => window.location.reload(), 500);
    },
    onError: (error) => {
      console.error('Save error:', error);
      toast.error(error.message || 'Failed to save profile');
    }
  });

  const handleSave = async () => {
    console.log('Save button clicked, formData:', formData);
    try {
      await saveMutation.mutateAsync(formData);
    } catch (error) {
      console.error('Save error:', error);
    }
  };

  const handleDeleteAccount = async () => {
    try {
      if (profile) {
        await base44.entities.Profile.update(profile.id, { is_deleted: true, deleted_at: new Date().toISOString() });
      }
      if (residentProfile) {
        await base44.entities.ResidentProfile.update(residentProfile.id, { is_deleted: true, deleted_at: new Date().toISOString() });
      }
      toast.success('Account deletion requested. You will be signed out.');
      setTimeout(() => base44.auth.logout(), 1500);
    } catch (err) {
      toast.error('Failed to request account deletion. Please contact management.');
    }
  };

  const handleFileUpload = async (file, type) => {
    setUploadingDoc(true);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      setFormData(prev => ({
        ...prev,
        [type === 'lease' ? 'lease_document_url' : 'insurance_info_url']: file_url
      }));
      toast.success('Document uploaded successfully');
    } catch (error) {
      toast.error('Failed to upload document');
    } finally {
      setUploadingDoc(false);
    }
  };

  const addVehicle = () => {
    setFormData(prev => ({
      ...prev,
      vehicles: [...prev.vehicles, { plate_number: '', region: '', vehicle_type: '', parking_spot: '' }]
    }));
  };

  const removeVehicle = (index) => {
    setFormData(prev => ({
      ...prev,
      vehicles: prev.vehicles.filter((_, i) => i !== index)
    }));
  };

  const updateVehicle = (index, field, value) => {
    setFormData(prev => ({
      ...prev,
      vehicles: prev.vehicles.map((v, i) => i === index ? { ...v, [field]: value } : v)
    }));
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-zinc-200 border-t-zinc-900 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-zinc-500">{t('Loading profile...')}</p>
        </div>
      </div>
    );
  }

  const isResident = user?.account_type === 'resident';
  // If Profile exists, user is already approved (existing resident)
  const approvalStatus = profile ? 'approved' : (residentProfile?.status || 'pending_approval');

  return (
    <div className="space-y-6">
      {isResident && !profile && approvalStatus === 'pending_approval' && (
        <Card className="bg-amber-50 border-amber-200">
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
              <span className="font-semibold text-amber-900">{t('Pending Approval')}</span>
            </div>
            <p className="text-sm text-amber-700 mt-1">
              {t('Upload your lease and insurance documents to complete your profile. Full access will be granted after approval.')}
            </p>
          </CardContent>
        </Card>
      )}

      {isResident && !profile && approvalStatus === 'rejected' && (
        <Card className="bg-red-50 border-red-200">
          <CardContent className="p-4">
            <span className="font-semibold text-red-900">{t('Application Rejected')}</span>
            <p className="text-sm text-red-700 mt-1">
              {residentProfile?.rejection_reason || 'Your application was not approved. Please update your documents and resubmit.'}
            </p>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-zinc-900">{t('My Profile')}</h1>
          <p className="text-zinc-500 mt-1">{t('Manage your personal information and preferences')}</p>
        </div>
        <Button onClick={handleSave} disabled={saveMutation.isPending} className="dark:bg-black dark:text-white">
          <Save className="w-4 h-4 mr-2" />
          {t('Save Changes')}
        </Button>
      </div>

      {/* Personal Information */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="w-5 h-5" />
            {t('Personal Information')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>{t('Full Name (Read-only)')}</Label>
              <Input
                value={formData.full_name}
                disabled
                className="bg-zinc-50 cursor-not-allowed"
              />
              <p className="text-xs text-zinc-500 mt-1">{t('Contact management to change your name')}</p>
            </div>
            <div>
              <Label>{t('Preferred Name')}</Label>
              <Input
                value={formData.preferred_name}
                onChange={(e) => setFormData({ ...formData, preferred_name: e.target.value })}
                placeholder="John"
              />
            </div>
            <div>
              <Label>{t('Email')}</Label>
              <Input
                type="email"
                value={user?.email || ''}
                onChange={async (e) => {
                  await base44.auth.updateMe({ email: e.target.value });
                  setUser({ ...user, email: e.target.value });
                }}
                placeholder="john@example.com"
              />
            </div>
            <div>
              <Label>{t('Role (Read-only)')}</Label>
              <Input value={user?.management_role || user?.app_role || 'resident'} disabled className="bg-zinc-50" />
            </div>
            <div>
              <Label>{t('Language Preference')}</Label>
              <Select value={lang} onValueChange={(value) => setLang(value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map(l => (
                    <SelectItem key={l.code} value={l.code}>{l.flag} {l.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Additional Occupants */}
          <div className="pt-4 border-t">
            <div className="flex items-center justify-between mb-3">
              <Label>{t('Additional Occupants (Max 2)')}</Label>
              {formData.additional_occupants.length < 2 && (
                <Button 
                  type="button"
                  variant="outline" 
                  size="sm"
                  onClick={() => setFormData({
                    ...formData,
                    additional_occupants: [...formData.additional_occupants, { name: '', relationship: '' }]
                  })}
                >
                  <Plus className="w-4 h-4 mr-1" />
                  {t('Add')}
                </Button>
              )}
            </div>
            {formData.additional_occupants.length === 0 ? (
              <p className="text-sm text-zinc-400">{t('No additional occupants added')}</p>
            ) : (
              <div className="space-y-3">
                {formData.additional_occupants.map((occupant, index) => (
                  <div key={index} className="flex gap-2 items-start p-3 border border-zinc-200 rounded-lg">
                    <div className="flex-1 grid grid-cols-2 gap-2">
                      <Input
                       placeholder={t('Full Name (Read-only)')}
                       value={occupant.name}
                        onChange={(e) => {
                          const updated = [...formData.additional_occupants];
                          updated[index].name = e.target.value;
                          setFormData({ ...formData, additional_occupants: updated });
                        }}
                      />
                      <Input
                        placeholder={t('Relationship (e.g., Spouse, Roommate)')}
                        value={occupant.relationship}
                        onChange={(e) => {
                          const updated = [...formData.additional_occupants];
                          updated[index].relationship = e.target.value;
                          setFormData({ ...formData, additional_occupants: updated });
                        }}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        const updated = formData.additional_occupants.filter((_, i) => i !== index);
                        setFormData({ ...formData, additional_occupants: updated });
                      }}
                    >
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Contact Information */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Phone className="w-5 h-5" />
            {t('Contact Information')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>{t('Primary Phone')}</Label>
              <Input
                type="tel"
                value={formData.primary_phone}
                onChange={(e) => setFormData({ ...formData, primary_phone: e.target.value })}
                placeholder={t('(555) 123-4567')}
              />
            </div>
            <div>
              <Label>{t('Secondary Phone')}</Label>
              <Input
                type="tel"
                value={formData.secondary_phone}
                onChange={(e) => setFormData({ ...formData, secondary_phone: e.target.value })}
                placeholder={t('(555) 987-6543')}
              />
            </div>
            <div>
              <Label>{t('Emergency Contact Name')}</Label>
              <Input
                value={formData.emergency_contact_name}
                onChange={(e) => setFormData({ ...formData, emergency_contact_name: e.target.value })}
                placeholder={t('Jane Doe')}
              />
            </div>
            <div>
              <Label>{t('Emergency Contact Phone')}</Label>
              <Input
                type="tel"
                value={formData.emergency_contact_phone}
                onChange={(e) => setFormData({ ...formData, emergency_contact_phone: e.target.value })}
                placeholder={t('(555) 111-2222')}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Residency Information */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Home className="w-5 h-5" />
            {t('Residency Information')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>{unitLocked && isResident ? t('Unit Number (Locked)') : t('Unit Number')}</Label>
              <Input
                value={formData.unit_number}
                onChange={(e) => setFormData({ ...formData, unit_number: e.target.value })}
                placeholder="101"
                disabled={unitLocked && isResident}
                className={unitLocked && isResident ? 'bg-zinc-100 cursor-not-allowed' : ''}
              />
              {unitLocked && isResident && (
                <p className="text-xs text-zinc-500 mt-1">{t('Unit number cannot be changed. Contact management if needed.')}</p>
              )}
            </div>
            <div>
              <Label>{t('Residency Type')}</Label>
              <Select value={formData.residency_type} onValueChange={(value) => setFormData({ ...formData, residency_type: value })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="owner">{t('Owner')}</SelectItem>
                  <SelectItem value="tenant">{t('Tenant')}</SelectItem>
                  <SelectItem value="staff">{t('Staff')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t('Move-in Date')}</Label>
              <Input
                type="date"
                value={formData.move_in_date}
                onChange={(e) => setFormData({ ...formData, move_in_date: e.target.value })}
              />
            </div>
            <div>
              <Label>{t('Lease End Date (if applicable)')}</Label>
              <Input
                type="date"
                value={formData.lease_end_date}
                onChange={(e) => setFormData({ ...formData, lease_end_date: e.target.value })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Vehicles */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <div className="flex items-center gap-2">
            <Car className="w-5 h-5" />
            {t('Vehicles')}
            </div>
            <Button variant="outline" size="sm" onClick={addVehicle}>
            <Plus className="w-4 h-4 mr-1" />
            {t('Add Vehicle')}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {formData.vehicles.length === 0 ? (
            <p className="text-zinc-400 text-sm text-center py-4">{t('No vehicles registered. Click "Add Vehicle" to register one.')}</p>
          ) : (
            formData.vehicles.map((vehicle, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-4 border border-zinc-200 rounded-lg space-y-3"
              >
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-semibold text-sm">{t('Vehicle')} {index + 1}</h4>
                  <Button variant="ghost" size="sm" onClick={() => removeVehicle(index)}>
                    <Trash2 className="w-4 h-4 text-red-500" />
                  </Button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label>{t('Plate Number')}</Label>
                    <Input
                      value={vehicle.plate_number}
                      onChange={(e) => updateVehicle(index, 'plate_number', e.target.value)}
                      placeholder={t('ABC 1234')}
                    />
                  </div>
                  <div>
                    <Label>{t('Region')}</Label>
                    <Input
                      value={vehicle.region}
                      onChange={(e) => updateVehicle(index, 'region', e.target.value)}
                      placeholder={t('ON, CA, NY')}
                    />
                  </div>
                  <div>
                    <Label>{t('Vehicle Type')}</Label>
                    <Input
                      value={vehicle.vehicle_type}
                      onChange={(e) => updateVehicle(index, 'vehicle_type', e.target.value)}
                      placeholder={t('Sedan, SUV, Truck')}
                    />
                  </div>
                  <div>
                    <Label>{t('Parking Spot (Read-only)')}</Label>
                    <Input
                      value={vehicle.parking_spot}
                      disabled
                      className="bg-zinc-100 cursor-not-allowed"
                      placeholder={t('No spot assigned')}
                    />
                    <p className="text-xs text-zinc-400 mt-1">{t('Submit a parking verification request to change this.')}</p>
                  </div>
                </div>
              </motion.div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Parking Space Verification */}
      {isResident && <ParkingProofRequestSection user={user} profile={profile || residentProfileData} />}

      {/* Preferences */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5" />
            {t('Preferences')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="mb-3 block">{t('Notification Settings')}</Label>
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={formData.notification_settings.maintenance}
                  onCheckedChange={(checked) => setFormData({
                    ...formData,
                    notification_settings: { ...formData.notification_settings, maintenance: checked }
                  })}
                />
                <label className="text-sm">{t('Maintenance Updates')}</label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={formData.notification_settings.packages}
                  onCheckedChange={(checked) => setFormData({
                    ...formData,
                    notification_settings: { ...formData.notification_settings, packages: checked }
                  })}
                />
                <label className="text-sm">{t('Package Notifications')}</label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={formData.notification_settings.announcements}
                  onCheckedChange={(checked) => setFormData({
                    ...formData,
                    notification_settings: { ...formData.notification_settings, announcements: checked }
                  })}
                />
                <label className="text-sm">{t('Announcements')}</label>
              </div>
            </div>
          </div>

          <div>
            <Label>{t('Preferred Contact Method')}</Label>
              <Select value={formData.preferred_contact_method} onValueChange={(value) => setFormData({ ...formData, preferred_contact_method: value })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">{t('Email')}</SelectItem>
                <SelectItem value="phone">{t('Phone')}</SelectItem>
                <SelectItem value="sms">{t('SMS')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Documents */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5" />
            {t('Documents')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>{t('Lease Document')}</Label>
            <div className="flex items-center gap-2 mt-1">
              <Input
                type="file"
                accept=".pdf,.doc,.docx"
                onChange={(e) => e.target.files[0] && handleFileUpload(e.target.files[0], 'lease')}
                disabled={uploadingDoc}
              />
              {formData.lease_document_url && (
                <Button variant="outline" size="sm" asChild>
                  <a href={formData.lease_document_url} target="_blank" rel="noopener noreferrer">
                    {t('View')}
                  </a>
                </Button>
              )}
            </div>
          </div>
          <div>
            <Label>{t('Insurance Info')}</Label>
            <div className="flex items-center gap-2 mt-1">
              <Input
                type="file"
                accept=".pdf,.doc,.docx,image/*"
                onChange={(e) => e.target.files[0] && handleFileUpload(e.target.files[0], 'insurance')}
                disabled={uploadingDoc}
              />
              {formData.insurance_info_url && (
                <Button variant="outline" size="sm" asChild>
                  <a href={formData.insurance_info_url} target="_blank" rel="noopener noreferrer">
                    {t('View')}
                  </a>
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saveMutation.isPending} size="lg" className="dark:bg-black dark:text-white">
          <Save className="w-4 h-4 mr-2" />
          {t('Save All Changes')}
        </Button>
      </div>

      {/* Appearance */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Moon className="w-5 h-5" />
            {t('Appearance')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>{t('Color Scheme')}</Label>
            <Select value={colorScheme} onValueChange={setColorScheme}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">☀️ {t('Light')}</SelectItem>
                <SelectItem value="dark">🌙 {t('Dark')}</SelectItem>
                <SelectItem value="system">⚙️ {t('System Default')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-zinc-500 mt-1">{t('Changes apply immediately and are saved to this device.')}</p>
          </div>
        </CardContent>
      </Card>

      {/* Account / Danger Zone */}
      {isResident && (
        <Card className="border-red-100">
          <CardHeader>
            <CardTitle className="text-red-700 text-base">{t('Account')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-zinc-500 mb-4">{t('Deleting your account will remove your profile data and access. This action cannot be undone.')}</p>
            <Button variant="outline" className="border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => setShowDeleteDialog(true)}>
              <Trash2 className="w-4 h-4 mr-2" />
              {t('Delete Account')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Delete Account Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-red-700">{t('Delete Account')}</DialogTitle>
            <DialogDescription>
              {t('This action is permanent and cannot be undone. Your profile, documents, and all associated data will be marked for deletion. You will be signed out immediately.')}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Label className="text-sm font-medium">{t('Type DELETE to confirm')}</Label>
            <Input
              className="mt-2"
              placeholder="DELETE"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowDeleteDialog(false); setDeleteConfirmText(''); }}>
              {t('Cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={deleteConfirmText !== 'DELETE'}
              onClick={() => { setShowDeleteDialog(false); handleDeleteAccount(); }}
            >
              {t('Permanently Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
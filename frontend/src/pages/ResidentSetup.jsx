import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Home, Upload, CheckCircle } from 'lucide-react';
import UnitCombobox from '@/components/UnitCombobox';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';

export default function ResidentSetup() {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState(null);
  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    full_name: '',
    unit_id: '',
    tower: 'E',
    parking_spot: '',
    plate_number: '',
    residency_type: 'owner'
  });

  const [units, setUnits] = useState([]);
  const [filteredUnits, setFilteredUnits] = useState([]);

  const [documents, setDocuments] = useState({
    lease_document_url: '',
    insurance_document_url: ''
  });

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const currentUser = await base44.auth.me();
        setUser(currentUser);
        
        // Check if already has profile
        const profiles = await base44.entities.Profile.filter({ userId: currentUser.id });
        if (profiles.length > 0) {
          navigate(createPageUrl('Dashboard'));
          return;
        }

        // Load all units
        const allUnits = await base44.entities.Unit.filter({ active: true }, 'unit_number', 1000);
        setUnits(allUnits);
        setFilteredUnits(allUnits.filter(u => u.tower === 'E'));
      } catch (error) {
        base44.auth.redirectToLogin();
      }
    };
    checkAuth();
  }, [navigate]);

  useEffect(() => {
    // Filter units when tower changes
    setFilteredUnits(units.filter(u => u.tower === formData.tower));
  }, [formData.tower, units]);

  const handleInputChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleFileUpload = async (e, fieldName) => {
    const file = e.target.files[0];
    if (!file) return;

    setLoading(true);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      setDocuments(prev => ({ ...prev, [fieldName]: file_url }));
      toast.success('Document uploaded');
    } catch (error) {
      toast.error('Failed to upload document');
    } finally {
      setLoading(false);
    }
  };

  const handleNext = async () => {
    if (step === 1) {
      if (!formData.full_name || !formData.unit_id) {
        toast.error('Please fill in all required fields');
        return;
      }
      setStep(2);
    } else if (step === 2) {
      setStep(3);
    }
  };

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const selectedUnit = units.find(u => u.id === formData.unit_id);
      
      // Create ResidentProfile for approval (NOT Profile yet)
      await base44.entities.ResidentProfile.create({
        user_id: user.id,
        full_name: formData.full_name,
        unit_id: formData.unit_id,
        unit_number: selectedUnit?.unit_number || '',
        move_in_date: '',
        parking_spot: formData.parking_spot || '',
        status: 'pending_approval',
        submitted_for_approval_at: new Date().toISOString(),
        vehicles: formData.plate_number ? [{
          plate_number: formData.plate_number,
          model: '',
          parking_spot: formData.parking_spot || ''
        }] : [],
        lease_document_url: documents.lease_document_url,
        insurance_document_url: documents.insurance_document_url
      });

      // Update user with name only (not unit until approved)
      await base44.auth.updateMe({
        full_name: formData.full_name
      });

      toast.success('Profile submitted for approval!');
      window.location.href = createPageUrl('Dashboard');
    } catch (error) {
      toast.error('Failed to complete setup. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-zinc-50 to-zinc-100 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-zinc-200 border-t-zinc-900 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-zinc-500">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-50 to-zinc-100 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <img 
            src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/6931cd960917c204b2b4808b/9780cdd25_logo-footer-estwest-r.png" 
            alt="EstWest Condominiums" 
            className="h-16 w-auto object-contain mx-auto mb-4" 
          />
          <h1 className="text-3xl font-bold text-zinc-900">Resident Profile Setup</h1>
          <p className="text-zinc-500 mt-2">Step {step} of 3</p>
        </div>

        <Card>
          <CardContent className="p-8">
            {step === 1 && (
              <div className="space-y-6">
                <div className="text-center mb-6">
                  <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Home className="w-8 h-8 text-blue-600" />
                  </div>
                  <h2 className="text-xl font-semibold">Basic Information</h2>
                </div>

                <div className="space-y-4">
                  <div>
                    <Label className="text-base font-semibold">What's your full name? *</Label>
                    <p className="text-sm text-zinc-500 mb-2">Enter your legal name as it appears on official documents</p>
                    <Input
                      value={formData.full_name}
                      onChange={(e) => handleInputChange('full_name', e.target.value)}
                      placeholder="e.g., John Smith"
                      className="h-12 text-base"
                      autoFocus
                    />
                  </div>

                  <div className="pt-4">
                    <Label className="text-base font-semibold">Are you an owner or tenant? *</Label>
                    <p className="text-sm text-zinc-500 mb-2">Select your residency type</p>
                    <Select value={formData.residency_type} onValueChange={(value) => handleInputChange('residency_type', value)}>
                      <SelectTrigger className="h-12">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="owner">Owner</SelectItem>
                        <SelectItem value="tenant">Tenant</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="pt-4">
                    <Label className="text-base font-semibold">Where do you live? *</Label>
                    <p className="text-sm text-zinc-500 mb-2">Select your tower and unit</p>
                    <div className="space-y-3">
                      <div>
                        <Label className="text-sm">Tower</Label>
                        <Select value={formData.tower} onValueChange={(value) => {
                          handleInputChange('tower', value);
                          handleInputChange('unit_id', '');
                        }}>
                          <SelectTrigger className="h-12">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="E">East Tower (E)</SelectItem>
                            <SelectItem value="W">West Tower (W)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-sm">Unit</Label>
                        <UnitCombobox
                          units={filteredUnits}
                          value={formData.unit_id}
                          onChange={(value) => handleInputChange('unit_id', value)}
                          placeholder="Type to search (e.g., 1314)..."
                        />
                      </div>
                    </div>
                  </div>

                  <Button onClick={handleNext} className="w-full h-12 mt-6 text-base">
                    Continue to Parking Info →
                  </Button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-6">
                <div className="text-center mb-6">
                  <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Home className="w-8 h-8 text-blue-600" />
                  </div>
                  <h2 className="text-xl font-semibold">Parking & Vehicle (Optional)</h2>
                  <p className="text-sm text-zinc-500 mt-2">You can skip this and add it later</p>
                </div>

                <div className="space-y-4">
                  <div>
                    <Label className="text-base font-semibold">Do you have a parking spot?</Label>
                    <p className="text-sm text-zinc-500 mb-2">This is optional - you can add it later in your profile</p>
                    <Input
                      value={formData.parking_spot}
                      onChange={(e) => handleInputChange('parking_spot', e.target.value)}
                      placeholder="e.g., P1-045"
                      className="h-12 text-base"
                    />
                  </div>

                  <div className="pt-4">
                    <Label className="text-base font-semibold">What's your vehicle's license plate?</Label>
                    <p className="text-sm text-zinc-500 mb-2">Also optional - for security and parking management</p>
                    <Input
                      value={formData.plate_number}
                      onChange={(e) => handleInputChange('plate_number', e.target.value)}
                      placeholder="e.g., ABC 1234"
                      className="h-12 text-base"
                    />
                  </div>

                  <div className="flex gap-3 mt-6">
                    <Button variant="outline" onClick={() => setStep(1)} className="flex-1 h-12">
                      ← Back
                    </Button>
                    <Button onClick={handleNext} className="flex-1 h-12">
                      Continue to Documents →
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-6">
                <div className="text-center mb-6">
                  <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Upload className="w-8 h-8 text-blue-600" />
                  </div>
                  <h2 className="text-xl font-semibold">Upload Your Documents</h2>
                  <p className="text-sm text-zinc-500 mt-2">These are optional but recommended for faster verification</p>
                </div>

                <div className="space-y-4">
                  <div>
                    <Label>Lease Agreement</Label>
                    <div className="mt-2">
                      <label className="flex items-center justify-center w-full h-32 border-2 border-dashed border-zinc-300 rounded-lg cursor-pointer hover:border-blue-500 hover:bg-blue-50 transition-colors">
                        <div className="text-center">
                          {documents.lease_document_url ? (
                            <div className="flex items-center gap-2 text-green-600">
                              <CheckCircle className="w-5 h-5" />
                              <span className="text-sm font-medium">Uploaded</span>
                            </div>
                          ) : (
                            <>
                              <Upload className="w-8 h-8 text-zinc-400 mx-auto mb-2" />
                              <p className="text-sm text-zinc-500">Click to upload</p>
                            </>
                          )}
                        </div>
                        <input
                          type="file"
                          className="hidden"
                          accept=".pdf,.jpg,.jpeg,.png"
                          onChange={(e) => handleFileUpload(e, 'lease_document_url')}
                        />
                      </label>
                    </div>
                  </div>

                  <div>
                    <Label>Insurance Document</Label>
                    <div className="mt-2">
                      <label className="flex items-center justify-center w-full h-32 border-2 border-dashed border-zinc-300 rounded-lg cursor-pointer hover:border-blue-500 hover:bg-blue-50 transition-colors">
                        <div className="text-center">
                          {documents.insurance_document_url ? (
                            <div className="flex items-center gap-2 text-green-600">
                              <CheckCircle className="w-5 h-5" />
                              <span className="text-sm font-medium">Uploaded</span>
                            </div>
                          ) : (
                            <>
                              <Upload className="w-8 h-8 text-zinc-400 mx-auto mb-2" />
                              <p className="text-sm text-zinc-500">Click to upload</p>
                            </>
                          )}
                        </div>
                        <input
                          type="file"
                          className="hidden"
                          accept=".pdf,.jpg,.jpeg,.png"
                          onChange={(e) => handleFileUpload(e, 'insurance_document_url')}
                        />
                      </label>
                    </div>
                  </div>

                  <div className="flex gap-3 mt-6">
                    <Button variant="outline" onClick={() => setStep(2)} className="flex-1 h-12">
                      ← Back
                    </Button>
                    <Button 
                      onClick={handleSubmit} 
                      className="flex-1 h-12 bg-blue-600 hover:bg-blue-700 text-base"
                      disabled={loading}
                    >
                      {loading ? 'Creating Profile...' : 'Complete Setup ✓'}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
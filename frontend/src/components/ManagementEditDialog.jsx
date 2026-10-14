import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import { toast } from 'sonner';

export default function ManagementEditDialog({ open, onOpenChange, resident, onSave }) {
  const [password, setPassword] = useState('');
  const [verified, setVerified] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [editData, setEditData] = useState({
    unit_number: resident?.unit_number || '',
    parking_spot: resident?.parking_spot || '',
    vehicles: resident?.vehicles || []
  });

  const verifyPassword = () => {
    // Simple verification - in production this would be server-side
    if (password === 'admin2026') {
      setVerified(true);
      toast.success('Access granted');
    } else {
      setAttempts(prev => prev + 1);
      if (attempts >= 2) {
        toast.error('Too many failed attempts');
        onOpenChange(false);
      } else {
        toast.error('Invalid password');
      }
      setPassword('');
    }
  };

  const handleSave = () => {
    onSave(editData);
    onOpenChange(false);
    setVerified(false);
    setPassword('');
    setAttempts(0);
  };

  const updateVehicle = (index, field, value) => {
    setEditData(prev => ({
      ...prev,
      vehicles: prev.vehicles.map((v, i) => i === index ? { ...v, [field]: value } : v)
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Resident Information</DialogTitle>
        </DialogHeader>

        {!verified ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <AlertCircle className="w-5 h-5 text-amber-600" />
              <p className="text-sm text-amber-900">
                Management override password required to edit resident data
              </p>
            </div>
            <div>
              <Label>Override Password</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && verifyPassword()}
                placeholder="Enter management password"
                autoFocus
              />
            </div>
            <Button onClick={verifyPassword} className="w-full">
              Verify & Continue
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Unit Number</Label>
                <Input
                  value={editData.unit_number}
                  onChange={(e) => setEditData({ ...editData, unit_number: e.target.value })}
                />
              </div>
              <div>
                <Label>Parking Spot</Label>
                <Input
                  value={editData.parking_spot}
                  onChange={(e) => setEditData({ ...editData, parking_spot: e.target.value })}
                />
              </div>
            </div>

            <div>
              <Label className="mb-2 block">Vehicles</Label>
              <div className="space-y-2">
                {editData.vehicles.map((vehicle, idx) => (
                  <div key={idx} className="grid grid-cols-2 gap-2 p-3 border rounded-lg">
                    <div>
                      <Label className="text-xs">Plate Number</Label>
                      <Input
                        value={vehicle.plate_number}
                        onChange={(e) => updateVehicle(idx, 'plate_number', e.target.value)}
                        placeholder="ABC 1234"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Model</Label>
                      <Input
                        value={vehicle.model || vehicle.vehicle_type || ''}
                        onChange={(e) => updateVehicle(idx, 'model', e.target.value)}
                        placeholder="Honda Civic"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave}>
                Save Changes
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { User, Shield, Building, ShieldAlert, Home } from 'lucide-react';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';

const MANAGEMENT_PASSWORD = 'EWSBM13IsNtHere';

export default function Onboarding() {
  const [step, setStep] = useState(1);
  const [accountType, setAccountType] = useState(null);
  const [managementRole, setManagementRole] = useState(null);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    // Check if user is already onboarded
    const checkOnboarding = async () => {
      try {
        const user = await base44.auth.me();
        if (user.account_type) {
          navigate(createPageUrl('Dashboard'));
        }
      } catch (error) {
        // User not logged in, redirect to login
        base44.auth.redirectToLogin();
      }
    };
    checkOnboarding();
  }, [navigate]);

  const handleAccountTypeSelect = (type) => {
    setAccountType(type);
    if (type === 'resident') {
      // Redirect to resident setup page
      completeOnboarding(type, null);
    } else {
      setStep(2);
    }
  };

  const handleManagementRoleSelect = (role) => {
    setManagementRole(role);
    setStep(3);
  };

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    if (password !== MANAGEMENT_PASSWORD) {
      toast.error('Incorrect management password. Access denied.');
      return;
    }
    await completeOnboarding('management', managementRole);
  };

  const completeOnboarding = async (type, role) => {
    setLoading(true);
    try {
      const updates = {
        account_type: type,
      };

      if (type === 'management') {
        updates.management_role = role;
        updates.app_role = role; // Keep legacy field in sync
        
        // Set appropriate unit number based on role
        if (role === 'security') updates.unit_number = 'SEC-01';
        if (role === 'property_management') updates.unit_number = 'HQ';
        if (role === 'board') updates.unit_number = 'PH-01';
        
        await base44.auth.updateMe(updates);
        toast.success('Account setup complete!');
        window.location.href = createPageUrl('Dashboard');
      } else {
        // Resident - just set account type and redirect to setup
        updates.app_role = 'resident';
        await base44.auth.updateMe(updates);
        window.location.href = createPageUrl('ResidentSetup');
      }
    } catch (error) {
      toast.error('Failed to complete setup. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-50 to-zinc-100 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <img 
            src="https://qtrypzzcjebvfcihiynt.supabase.co/storage/v1/object/public/base44-prod/public/6931cd960917c204b2b4808b/9780cdd25_logo-footer-estwest-r.png" 
            alt="EstWest Condominiums" 
            className="h-16 w-auto object-contain mx-auto mb-4" 
          />
          <h1 className="text-3xl font-bold text-zinc-900">Welcome to EstWest</h1>
          <p className="text-zinc-500 mt-2">Let's set up your account</p>
        </div>

        {step === 1 && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold text-center mb-6">Select Account Type</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card 
                className="cursor-pointer hover:shadow-xl hover:border-blue-500 transition-all duration-300 border-2"
                onClick={() => handleAccountTypeSelect('resident')}
              >
                <CardContent className="p-8 text-center space-y-4">
                  <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto">
                    <Home className="w-8 h-8 text-blue-600" />
                  </div>
                  <h3 className="text-xl font-bold">Resident</h3>
                  <p className="text-sm text-zinc-500">
                    Access to resident features: packages, amenities, maintenance requests
                  </p>
                </CardContent>
              </Card>

              <Card 
                className="cursor-pointer hover:shadow-xl hover:border-purple-500 transition-all duration-300 border-2"
                onClick={() => handleAccountTypeSelect('management')}
              >
                <CardContent className="p-8 text-center space-y-4">
                  <div className="w-16 h-16 bg-purple-50 rounded-full flex items-center justify-center mx-auto">
                    <Shield className="w-8 h-8 text-purple-600" />
                  </div>
                  <h3 className="text-xl font-bold">Management</h3>
                  <p className="text-sm text-zinc-500">
                    Staff access for security, board members, and property management
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <Button 
              variant="ghost" 
              onClick={() => setStep(1)}
              className="mb-4"
            >
              ← Back
            </Button>
            <h2 className="text-xl font-semibold text-center mb-6">Choose Management Role</h2>
            <div className="space-y-4">
              <Card 
                className="cursor-pointer hover:shadow-lg hover:border-red-500 transition-all border-2"
                onClick={() => handleManagementRoleSelect('security')}
              >
                <CardContent className="p-6 flex items-center gap-4">
                  <div className="w-12 h-12 bg-red-50 rounded-lg flex items-center justify-center">
                    <ShieldAlert className="w-6 h-6 text-red-600" />
                  </div>
                  <div>
                    <h3 className="font-bold">Security</h3>
                    <p className="text-sm text-zinc-500">Manage packages, gameroom, speakeasy operations</p>
                  </div>
                </CardContent>
              </Card>

              <Card 
                className="cursor-pointer hover:shadow-lg hover:border-amber-500 transition-all border-2"
                onClick={() => handleManagementRoleSelect('board')}
              >
                <CardContent className="p-6 flex items-center gap-4">
                  <div className="w-12 h-12 bg-amber-50 rounded-lg flex items-center justify-center">
                    <User className="w-6 h-6 text-amber-600" />
                  </div>
                  <div>
                    <h3 className="font-bold">Board Member</h3>
                    <p className="text-sm text-zinc-500">Oversight access to all operations</p>
                  </div>
                </CardContent>
              </Card>

              <Card 
                className="cursor-pointer hover:shadow-lg hover:border-blue-500 transition-all border-2"
                onClick={() => handleManagementRoleSelect('property_management')}
              >
                <CardContent className="p-6 flex items-center gap-4">
                  <div className="w-12 h-12 bg-blue-50 rounded-lg flex items-center justify-center">
                    <Building className="w-6 h-6 text-blue-600" />
                  </div>
                  <div>
                    <h3 className="font-bold">Management</h3>
                    <p className="text-sm text-zinc-500">Maintenance, speakeasy approvals, daily notices</p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {step === 3 && (
          <Card>
            <CardContent className="p-8">
              <Button 
                variant="ghost" 
                onClick={() => setStep(2)}
                className="mb-4"
              >
                ← Back
              </Button>
              <div className="space-y-6">
                <div className="text-center">
                  <div className="w-16 h-16 bg-purple-50 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Shield className="w-8 h-8 text-purple-600" />
                  </div>
                  <h2 className="text-xl font-semibold">Management Verification</h2>
                  <p className="text-sm text-zinc-500 mt-2">Enter the management password to continue</p>
                </div>

                <form onSubmit={handlePasswordSubmit} className="space-y-4">
                  <div>
                    <Input 
                      type="password"
                      placeholder="Management Password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="text-center text-lg"
                      autoFocus
                    />
                  </div>
                  <Button 
                    type="submit"
                    className="w-full h-12 text-lg bg-purple-600 hover:bg-purple-700"
                    disabled={loading || !password}
                  >
                    {loading ? 'Verifying...' : 'Complete Setup'}
                  </Button>
                </form>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
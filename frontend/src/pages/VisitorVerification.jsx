import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { UserCheck, Car, Calendar, CheckCircle, XCircle, AlertCircle, Eye, EyeOff, Search, RefreshCw } from 'lucide-react';
import { format, isToday, isWithinInterval, isPast } from 'date-fns';
import { toast } from 'sonner';
import { motion } from 'framer-motion';

export default function VisitorVerification() {
  const [codeInput, setCodeInput] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [verificationResult, setVerificationResult] = useState(null);
  const [selectedPass, setSelectedPass] = useState(null);
  const [showCode, setShowCode] = useState({});
  const queryClient = useQueryClient();

  const { data: todaysPasses, refetch: refetchPasses } = useQuery({
    queryKey: ['todays-visitor-passes'],
    queryFn: async () => {
      const allPasses = await base44.entities.VisitorAccessPass.list('-created_date', 200);
      const today = new Date();
      return allPasses.filter(pass => {
        const validFrom = new Date(pass.validFrom);
        const validUntil = pass.validUntil ? new Date(pass.validUntil) : null;

        if (pass.type === 'one_time') {
          return isToday(validFrom);
        }

        if (pass.type === 'time_limited' && validUntil) {
          return isWithinInterval(today, { start: validFrom, end: validUntil });
        }

        return false;
      });
    },
    refetchInterval: 30000,
  });

  const { data: todaysParking, refetch: refetchParking } = useQuery({
    queryKey: ['todays-parking'],
    queryFn: async () => {
      const allReservations = await base44.entities.VisitorParkingReservation.filter({ status: 'active' }, '-created_date', 100);
      const today = new Date();
      return allReservations.filter(res => {
        const start = new Date(res.startTime);
        const end = new Date(res.endTime);
        return isWithinInterval(today, { start, end });
      });
    },
    refetchInterval: 30000,
  });

  const verifyMutation = useMutation({
    mutationFn: async (code) => {
      const passes = await base44.entities.VisitorAccessPass.filter({ code6: code });

      if (passes.length === 0) {
        throw new Error('Invalid code.');
      }

      const pass = passes[0];
      const now = new Date();

      // Check status
      if (pass.status === 'revoked') {
        throw new Error('Code revoked.');
      }
      if (pass.status === 'used') {
        throw new Error('Code already used.');
      }
      if (pass.status === 'expired') {
        throw new Error('Code expired.');
      }

      // Check time validity
      const validFrom = new Date(pass.validFrom);
      const validUntil = pass.validUntil ? new Date(pass.validUntil) : null;

      if (now < validFrom) {
        throw new Error('Code not yet valid.');
      }

      if (validUntil && now > validUntil) {
        // Auto-expire
        await base44.entities.VisitorAccessPass.update(pass.id, { status: 'expired' });
        throw new Error('Code expired.');
      }

      // Get parking reservation if exists
      const parkingRes = await base44.entities.VisitorParkingReservation.filter({ accessPassId: pass.id });

      // If one-time, mark as used
      if (pass.type === 'one_time') {
        await base44.entities.VisitorAccessPass.update(pass.id, {
          status: 'used',
          usedAt: now.toISOString()
        });
      }

      return {
        pass: { ...pass, status: pass.type === 'one_time' ? 'used' : pass.status },
        parking: parkingRes.length > 0 ? parkingRes[0] : null
      };
    },
    onSuccess: (data) => {
      setVerificationResult(data);
      queryClient.invalidateQueries(['todays-visitor-passes']);
      toast.success('Access verified ✅', { duration: 3000 });
    },
    onError: (error) => {
      setVerificationResult({ error: error.message });
      toast.error(error.message);
    }
  });

  const handleVerify = () => {
    if (!codeInput || codeInput.length !== 6) {
      toast.error('Please enter a 6-digit code');
      return;
    }
    verifyMutation.mutate(codeInput);
  };

  const handleClear = () => {
    setCodeInput('');
    setSearchInput('');
    setVerificationResult(null);
  };

  const filteredPasses = todaysPasses?.filter(pass => {
    if (!searchInput) return true;
    const search = searchInput.toLowerCase();
    return (
      pass.visitorName?.toLowerCase().includes(search) ||
      pass.residentUnit?.toLowerCase().includes(search) ||
      pass.code6?.includes(search)
    );
  });

  const getStatusBadge = (status) => {
    const config = {
      active: { label: 'Active', icon: CheckCircle, className: 'bg-green-100 text-green-700 border-green-200' },
      used: { label: 'Used', icon: CheckCircle, className: 'bg-blue-100 text-blue-700 border-blue-200' },
      expired: { label: 'Expired', icon: XCircle, className: 'bg-zinc-100 text-zinc-600 border-zinc-200' },
      revoked: { label: 'Revoked', icon: AlertCircle, className: 'bg-red-100 text-red-700 border-red-200' }
    };
    const c = config[status] || config.active;
    const Icon = c.icon;
    return (
      <Badge variant="outline" className={c.className}>
        <Icon className="w-3 h-3 mr-1" />
        {c.label}
      </Badge>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 bg-indigo-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-indigo-600/20">
            <UserCheck className="w-7 h-7" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Visitor Verification</h1>
            <p className="text-zinc-500">Verify access codes and monitor visitor parking</p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            refetchPasses();
            refetchParking();
          }}
        >
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Verify a Visitor - Top Card */}
      <Card className="bg-white border-2 border-indigo-100 shadow-lg shadow-indigo-100">
        <CardHeader className="bg-indigo-50 border-b border-indigo-100">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Search className="w-5 h-5 text-indigo-600" />
            Verify a Visitor
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 block">
                6-Digit Access Code
              </label>
              <Input
                placeholder="Enter 6-digit code"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                maxLength={6}
                className="text-lg font-mono tracking-widest"
                onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 block">
                Or Search by Name/Unit
              </label>
              <Input
                placeholder="Search visitor name or unit"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>
          </div>

          <div className="flex gap-3">
            <Button
              onClick={handleVerify}
              disabled={verifyMutation.isPending || codeInput.length !== 6}
              className="bg-indigo-600 hover:bg-indigo-700"
            >
              {verifyMutation.isPending ? 'Verifying...' : 'Verify Access'}
            </Button>
            <Button variant="outline" onClick={handleClear}>
              Clear
            </Button>
          </div>

          {/* Verification Result */}
          {verificationResult && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-6"
            >
              {verificationResult.error ? (
                <div className="bg-red-50 border-2 border-red-200 rounded-lg p-4 flex items-center gap-3">
                  <XCircle className="w-6 h-6 text-red-600 flex-shrink-0" />
                  <div>
                    <p className="font-semibold text-red-900">Verification Failed</p>
                    <p className="text-sm text-red-700">{verificationResult.error}</p>
                  </div>
                </div>
              ) : (
                <div className="bg-green-50 border-2 border-green-200 rounded-lg p-6 space-y-4">
                  <div className="flex items-center gap-3 mb-4">
                    <CheckCircle className="w-8 h-8 text-green-600" />
                    <div>
                      <p className="text-xl font-bold text-green-900">Access Verified ✅</p>
                      <p className="text-sm text-green-700">Visitor may enter the building</p>
                    </div>
                  </div>

                  <div className="grid md:grid-cols-2 gap-4 bg-white rounded-lg p-4 border border-green-200">
                    <div>
                      <p className="text-xs text-zinc-500 uppercase tracking-wider">Visitor Name</p>
                      <p className="font-semibold text-lg">{verificationResult.pass.visitorName}</p>
                    </div>
                    <div>
                      <p className="text-xs text-zinc-500 uppercase tracking-wider">Unit</p>
                      <p className="font-semibold">
                        {verificationResult.pass.residentUnit}{' '}
                        <Badge variant="outline">{verificationResult.pass.residentTower}</Badge>
                      </p>
                      <p className="text-xs text-zinc-500">{verificationResult.pass.createdByResidentName}</p>
                    </div>
                    <div>
                      <p className="text-xs text-zinc-500 uppercase tracking-wider">Access Type</p>
                      <Badge variant="outline" className="capitalize">
                        {verificationResult.pass.type.replace('_', ' ')}
                      </Badge>
                    </div>
                    <div>
                      <p className="text-xs text-zinc-500 uppercase tracking-wider">Validity</p>
                      <p className="text-sm">
                        {format(new Date(verificationResult.pass.validFrom), 'MMM d, h:mm a')}
                        {verificationResult.pass.validUntil && (
                          <> → {format(new Date(verificationResult.pass.validUntil), 'h:mm a')}</>
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-zinc-500 uppercase tracking-wider">Status</p>
                      {getStatusBadge(verificationResult.pass.status)}
                    </div>
                    {verificationResult.parking && (
                      <>
                        <div className="md:col-span-2 border-t pt-3 mt-2">
                          <div className="flex items-center gap-2 mb-2">
                            <Car className="w-4 h-4 text-indigo-600" />
                            <p className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">
                              Parking Reserved
                            </p>
                          </div>
                          <div className="grid grid-cols-3 gap-3 text-sm">
                            <div>
                              <p className="text-xs text-zinc-500">Spot</p>
                              <Badge>{verificationResult.parking.spotId}</Badge>
                            </div>
                            <div>
                              <p className="text-xs text-zinc-500">Time Window</p>
                              <p className="font-medium">
                                {format(new Date(verificationResult.parking.startTime), 'h:mm a')} -{' '}
                                {format(new Date(verificationResult.parking.endTime), 'h:mm a')}
                              </p>
                            </div>
                            {verificationResult.parking.licensePlate && (
                              <div>
                                <p className="text-xs text-zinc-500">License Plate</p>
                                <p className="font-mono font-medium">{verificationResult.parking.licensePlate}</p>
                              </div>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </CardContent>
      </Card>

      {/* Today's Visitors */}
      <Card className="bg-white border-zinc-200">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="w-5 h-5" />
            Today's Active Visitors
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="bg-zinc-50">
                <TableHead>Visitor Name</TableHead>
                <TableHead>Unit/Tower</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Valid Until</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Parking</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredPasses?.map((pass) => {
                const parking = todaysParking?.find(p => p.accessPassId === pass.id);
                return (
                  <TableRow key={pass.id}>
                    <TableCell className="font-medium">{pass.visitorName}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <span>{pass.residentUnit}</span>
                        <Badge variant="outline" className="ml-1">{pass.residentTower}</Badge>
                      </div>
                      <div className="text-xs text-zinc-500">{pass.createdByResidentName}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <code className="bg-zinc-100 px-2 py-1 rounded font-mono text-sm">
                          {showCode[pass.id] ? pass.code6 : '••••••'}
                        </code>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => setShowCode({ ...showCode, [pass.id]: !showCode[pass.id] })}
                        >
                          {showCode[pass.id] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {pass.type.replace('_', ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {pass.validUntil ? (
                        <span className={isPast(new Date(pass.validUntil)) ? 'text-red-600' : ''}>
                          {format(new Date(pass.validUntil), 'h:mm a')}
                        </span>
                      ) : (
                        <span className="text-zinc-400">One-time</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {getStatusBadge(pass.status)}
                    </TableCell>
                    <TableCell>
                      {parking ? (
                        <Badge variant="outline" className="bg-indigo-50 text-indigo-700">
                          <Car className="w-3 h-3 mr-1" />
                          {parking.spotId}
                        </Badge>
                      ) : (
                        <span className="text-xs text-zinc-400">None</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSelectedPass({ pass, parking })}
                      >
                        View Details
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!filteredPasses || filteredPasses.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-zinc-400 py-8">
                    No visitor passes for today
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Parking Verification */}
      <Card className="bg-white border-zinc-200">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Car className="w-5 h-5" />
            Visitor Parking Reservations
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="bg-zinc-50">
                <TableHead>Visitor Name</TableHead>
                <TableHead>Unit/Tower</TableHead>
                <TableHead>Time Period</TableHead>
                <TableHead>Spot</TableHead>
                <TableHead>License Plate</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {todaysParking?.map((res) => (
                <TableRow key={res.id}>
                  <TableCell className="font-medium">{res.visitorName}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <span>{res.residentUnit}</span>
                      <Badge variant="outline" className="ml-1">{res.residentTower}</Badge>
                    </div>
                    <div className="text-xs text-zinc-500">{res.createdByResidentName}</div>
                  </TableCell>
                  <TableCell className="text-sm">
                    <div>{format(new Date(res.startTime), 'h:mm a')}</div>
                    <div className="text-zinc-500">→ {format(new Date(res.endTime), 'h:mm a')}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono">
                      {res.spotId === 'auto' ? 'Auto-assigned' : res.spotId}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {res.licensePlate || <span className="text-zinc-400">Not provided</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="bg-green-100 text-green-700">Active</Badge>
                  </TableCell>
                </TableRow>
              ))}
              {!todaysParking || todaysParking.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-zinc-400 py-8">
                    No parking reservations for today
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Details Modal */}
      <Dialog open={!!selectedPass} onOpenChange={() => setSelectedPass(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Visitor Pass Details</DialogTitle>
          </DialogHeader>
          {selectedPass && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-zinc-500">Visitor Name</p>
                  <p className="font-semibold text-lg">{selectedPass.pass.visitorName}</p>
                </div>
                <div>
                  <p className="text-zinc-500">Access Code</p>
                  <code className="bg-zinc-100 px-3 py-1.5 rounded font-mono text-lg">
                    {selectedPass.pass.code6}
                  </code>
                </div>
                <div>
                  <p className="text-zinc-500">Created By</p>
                  <p className="font-semibold">{selectedPass.pass.createdByResidentName}</p>
                  <p className="text-xs text-zinc-500">
                    Unit {selectedPass.pass.residentUnit} {selectedPass.pass.residentTower}
                  </p>
                </div>
                <div>
                  <p className="text-zinc-500">Type</p>
                  <Badge variant="outline" className="capitalize">
                    {selectedPass.pass.type.replace('_', ' ')}
                  </Badge>
                </div>
                <div>
                  <p className="text-zinc-500">Valid From</p>
                  <p className="font-semibold">{format(new Date(selectedPass.pass.validFrom), 'MMM d, yyyy h:mm a')}</p>
                </div>
                {selectedPass.pass.validUntil && (
                  <div>
                    <p className="text-zinc-500">Valid Until</p>
                    <p className="font-semibold">{format(new Date(selectedPass.pass.validUntil), 'MMM d, yyyy h:mm a')}</p>
                  </div>
                )}
                <div>
                  <p className="text-zinc-500">Status</p>
                  {getStatusBadge(selectedPass.pass.status)}
                </div>
                <div>
                  <p className="text-zinc-500">Created</p>
                  <p className="text-sm">{format(new Date(selectedPass.pass.created_date), 'MMM d, h:mm a')}</p>
                </div>
                {selectedPass.pass.usedAt && (
                  <div className="col-span-2">
                    <p className="text-zinc-500">Used At</p>
                    <p className="text-sm">{format(new Date(selectedPass.pass.usedAt), 'MMM d, yyyy h:mm a')}</p>
                  </div>
                )}
              </div>

              {selectedPass.parking && (
                <div className="border-t pt-4">
                  <h3 className="font-semibold mb-3 flex items-center gap-2">
                    <Car className="w-4 h-4" />
                    Parking Reservation
                  </h3>
                  <div className="grid grid-cols-2 gap-4 text-sm bg-indigo-50 p-4 rounded-lg">
                    <div>
                      <p className="text-zinc-500">Spot</p>
                      <p className="font-semibold">{selectedPass.parking.spotId}</p>
                    </div>
                    <div>
                      <p className="text-zinc-500">License Plate</p>
                      <p className="font-mono font-semibold">{selectedPass.parking.licensePlate || 'Not provided'}</p>
                    </div>
                    <div>
                      <p className="text-zinc-500">Start Time</p>
                      <p className="font-semibold">{format(new Date(selectedPass.parking.startTime), 'h:mm a')}</p>
                    </div>
                    <div>
                      <p className="text-zinc-500">End Time</p>
                      <p className="font-semibold">{format(new Date(selectedPass.parking.endTime), 'h:mm a')}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

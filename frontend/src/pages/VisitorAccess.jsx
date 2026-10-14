import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { UserCheck, Copy, Eye, EyeOff, Ban, Clock, CheckCircle, XCircle, Calendar, Car } from 'lucide-react';
import { format, addHours, addDays, isPast, isWithinInterval } from 'date-fns';
import { toast } from 'sonner';
import { motion } from 'framer-motion';

export default function VisitorAccess() {
  const [user, setUser] = useState(null);
  const [showCode, setShowCode] = useState({});
  const queryClient = useQueryClient();

  // Form states
  const [visitorName, setVisitorName] = useState('');
  const [accessType, setAccessType] = useState('one_time');
  const [validFrom, setValidFrom] = useState(new Date().toISOString().slice(0, 16));
  const [validUntil, setValidUntil] = useState(addHours(new Date(), 4).toISOString().slice(0, 16));
  const [duration, setDuration] = useState('4');
  const [durationUnit, setDurationUnit] = useState('hours');

  // Parking form states
  const [includeParking, setIncludeParking] = useState(false);
  const [parkingStartTime, setParkingStartTime] = useState(new Date().toISOString().slice(0, 16));
  const [parkingEndTime, setParkingEndTime] = useState(addHours(new Date(), 4).toISOString().slice(0, 16));
  const [licensePlate, setLicensePlate] = useState('');
  const [spotAssignment, setSpotAssignment] = useState('auto');

  React.useEffect(() => {
    const loadUser = async () => {
      const u = await base44.auth.me();
      setUser(u);
    };
    loadUser();
  }, []);

  const { data: accessPasses, refetch: refetchPasses } = useQuery({
    queryKey: ['visitor-access-passes', user?.id],
    queryFn: () => base44.entities.VisitorAccessPass.filter({ createdByResidentUserId: user?.id }, '-created_date', 100),
    enabled: !!user,
  });

  const { data: parkingReservations } = useQuery({
    queryKey: ['visitor-parking', user?.id],
    queryFn: () => base44.entities.VisitorParkingReservation.filter({ createdByResidentUserId: user?.id }, '-created_date', 100),
    enabled: !!user,
  });

  // Auto-update expired passes
  React.useEffect(() => {
    if (!accessPasses) return;
    
    const interval = setInterval(async () => {
      const now = new Date();
      const toExpire = accessPasses.filter(p => 
        p.status === 'active' && 
        p.validUntil && 
        isPast(new Date(p.validUntil))
      );

      for (const pass of toExpire) {
        await base44.entities.VisitorAccessPass.update(pass.id, { status: 'expired' });
      }

      if (toExpire.length > 0) {
        refetchPasses();
      }
    }, 30000); // Check every 30 seconds

    return () => clearInterval(interval);
  }, [accessPasses]);

  const generateCode = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
  };

  const createPassMutation = useMutation({
    mutationFn: async () => {
      let code = generateCode();
      
      // Ensure unique code
      const existingCodes = await base44.entities.VisitorAccessPass.filter({ status: 'active' });
      while (existingCodes.some(p => p.code6 === code)) {
        code = generateCode();
      }

      const passData = {
        createdByResidentUserId: user.id,
        createdByResidentName: user.full_name,
        residentUnit: user.unit_number,
        residentTower: user.unit_number?.toString().startsWith('1') ? 'E' : 'W',
        visitorName,
        code6: code,
        type: accessType,
        validFrom: new Date(validFrom).toISOString(),
        validUntil: accessType === 'time_limited' ? new Date(validUntil).toISOString() : null,
        status: 'active'
      };

      const pass = await base44.entities.VisitorAccessPass.create(passData);

      // Create parking reservation if requested
      if (includeParking) {
        await base44.entities.VisitorParkingReservation.create({
          createdByResidentUserId: user.id,
          createdByResidentName: user.full_name,
          residentUnit: user.unit_number,
          residentTower: user.unit_number?.toString().startsWith('1') ? 'E' : 'W',
          visitorName,
          accessPassId: pass.id,
          startTime: new Date(parkingStartTime).toISOString(),
          endTime: new Date(parkingEndTime).toISOString(),
          spotId: spotAssignment,
          licensePlate: licensePlate || null,
          status: 'active'
        });
      }

      return { pass, code };
    },
    onSuccess: ({ code }) => {
      queryClient.invalidateQueries(['visitor-access-passes']);
      queryClient.invalidateQueries(['visitor-parking']);
      setVisitorName('');
      setIncludeParking(false);
      setLicensePlate('');
      toast.success(`Access code generated: ${code}`, {
        action: {
          label: 'Copy',
          onClick: () => {
            navigator.clipboard.writeText(code);
            toast.success('Code copied!');
          }
        }
      });
    }
  });

  const revokeMutation = useMutation({
    mutationFn: (id) => base44.entities.VisitorAccessPass.update(id, { 
      status: 'revoked',
      revokedAt: new Date().toISOString()
    }),
    onSuccess: () => {
      queryClient.invalidateQueries(['visitor-access-passes']);
      toast.success('Access code revoked');
    }
  });

  const cancelParkingMutation = useMutation({
    mutationFn: (id) => base44.entities.VisitorParkingReservation.update(id, { status: 'cancelled' }),
    onSuccess: () => {
      queryClient.invalidateQueries(['visitor-parking']);
      toast.success('Parking reservation cancelled');
    }
  });

  const copyCode = (code) => {
    navigator.clipboard.writeText(code);
    toast.success('Code copied to clipboard');
  };

  const handleDurationChange = (value, unit) => {
    const from = new Date(validFrom);
    const hours = unit === 'hours' ? parseInt(value) : parseInt(value) * 24;
    setValidUntil(addHours(from, hours).toISOString().slice(0, 16));
  };

  const getStatusBadge = (pass) => {
    const statusConfig = {
      active: { label: 'Active', className: 'bg-green-100 text-green-700 border-green-200' },
      used: { label: 'Used', className: 'bg-blue-100 text-blue-700 border-blue-200' },
      expired: { label: 'Expired', className: 'bg-zinc-100 text-zinc-600 border-zinc-200' },
      revoked: { label: 'Revoked', className: 'bg-red-100 text-red-700 border-red-200' }
    };
    const config = statusConfig[pass.status];
    return <Badge variant="outline" className={config.className}>{config.label}</Badge>;
  };

  if (!user) return <div className="p-8 text-center">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 bg-indigo-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-indigo-600/20">
          <UserCheck className="w-7 h-7" />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Visitor Access</h1>
          <p className="text-zinc-500">Generate access codes and reserve parking for your visitors</p>
        </div>
      </div>

      <Tabs defaultValue="generate" className="space-y-6">
        <TabsList className="grid w-full grid-cols-3 max-w-2xl">
          <TabsTrigger value="generate">Generate Code</TabsTrigger>
          <TabsTrigger value="manage">My Visitor Passes</TabsTrigger>
          <TabsTrigger value="archive">Archive</TabsTrigger>
        </TabsList>

        <TabsContent value="generate" className="space-y-6">
          <Card className="bg-white/80 backdrop-blur-sm border-zinc-200">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserCheck className="w-5 h-5" />
                Generate Visitor Pass
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Visitor Name *</Label>
                <Input
                  placeholder="Enter visitor's full name"
                  value={visitorName}
                  onChange={(e) => setVisitorName(e.target.value)}
                  required
                />
              </div>

              <div>
                <Label>Access Type</Label>
                <Select value={accessType} onValueChange={setAccessType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="one_time">One-Time Use</SelectItem>
                    <SelectItem value="time_limited">Time-Limited Pass</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Valid From</Label>
                  <Input
                    type="datetime-local"
                    value={validFrom}
                    onChange={(e) => {
                      setValidFrom(e.target.value);
                      if (accessType === 'time_limited') {
                        handleDurationChange(duration, durationUnit);
                      }
                    }}
                  />
                </div>
                {accessType === 'time_limited' && (
                  <div>
                    <Label>Valid Until</Label>
                    <Input
                      type="datetime-local"
                      value={validUntil}
                      onChange={(e) => setValidUntil(e.target.value)}
                    />
                  </div>
                )}
              </div>

              {accessType === 'time_limited' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Duration</Label>
                    <Input
                      type="number"
                      min="1"
                      value={duration}
                      onChange={(e) => {
                        setDuration(e.target.value);
                        handleDurationChange(e.target.value, durationUnit);
                      }}
                    />
                  </div>
                  <div>
                    <Label>Unit</Label>
                    <Select value={durationUnit} onValueChange={(v) => {
                      setDurationUnit(v);
                      handleDurationChange(duration, v);
                    }}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="hours">Hours</SelectItem>
                        <SelectItem value="days">Days</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              <div className="border-t pt-4">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Car className="w-5 h-5 text-zinc-500" />
                    <Label htmlFor="parking-toggle">Reserve Visitor Parking</Label>
                  </div>
                  <Switch
                    id="parking-toggle"
                    checked={includeParking}
                    onCheckedChange={setIncludeParking}
                  />
                </div>

                {includeParking && (
                  <div className="space-y-4 bg-zinc-50 p-4 rounded-lg">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Start Time</Label>
                        <Input
                          type="datetime-local"
                          value={parkingStartTime}
                          onChange={(e) => setParkingStartTime(e.target.value)}
                        />
                      </div>
                      <div>
                        <Label>End Time</Label>
                        <Input
                          type="datetime-local"
                          value={parkingEndTime}
                          onChange={(e) => setParkingEndTime(e.target.value)}
                        />
                      </div>
                    </div>
                    <div>
                      <Label>License Plate (Optional)</Label>
                      <Input
                        placeholder="ABC-1234"
                        value={licensePlate}
                        onChange={(e) => setLicensePlate(e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>Parking Spot</Label>
                      <Select value={spotAssignment} onValueChange={setSpotAssignment}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">Assign Automatically</SelectItem>
                          <SelectItem value="V1">Visitor Spot V1</SelectItem>
                          <SelectItem value="V2">Visitor Spot V2</SelectItem>
                          <SelectItem value="V3">Visitor Spot V3</SelectItem>
                          <SelectItem value="V4">Visitor Spot V4</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
              </div>

              <Button
                onClick={() => createPassMutation.mutate()}
                disabled={!visitorName || createPassMutation.isPending}
                className="w-full bg-indigo-600 hover:bg-indigo-700"
              >
                {createPassMutation.isPending ? 'Generating...' : 'Generate Access Code'}
              </Button>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
                <strong>Instructions for visitor:</strong> Enter this code into the building fob/name list keypad to gain access.
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="manage" className="space-y-6">
          <Card className="bg-white border-zinc-200">
            <CardHeader>
              <CardTitle>Active & Recent Passes</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow className="bg-zinc-50">
                    <TableHead>Visitor</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Valid Period</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accessPasses?.map((pass) => (
                    <TableRow key={pass.id}>
                      <TableCell className="font-medium">{pass.visitorName}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <code className="bg-zinc-100 px-2 py-1 rounded font-mono">
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
                        <div>{format(new Date(pass.validFrom), 'MMM d, h:mm a')}</div>
                        {pass.validUntil && (
                          <div className="text-zinc-500">→ {format(new Date(pass.validUntil), 'MMM d, h:mm a')}</div>
                        )}
                      </TableCell>
                      <TableCell>{getStatusBadge(pass)}</TableCell>
                      <TableCell className="text-right space-x-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => copyCode(pass.code6)}
                        >
                          <Copy className="w-4 h-4" />
                        </Button>
                        {pass.status === 'active' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-red-600 hover:text-red-700"
                            onClick={() => revokeMutation.mutate(pass.id)}
                          >
                            <Ban className="w-4 h-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!accessPasses || accessPasses.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-zinc-400 py-8">
                        No visitor passes created yet
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {parkingReservations && parkingReservations.length > 0 && (
            <Card className="bg-white border-zinc-200">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Car className="w-5 h-5" />
                  Parking Reservations
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow className="bg-zinc-50">
                      <TableHead>Visitor</TableHead>
                      <TableHead>Time Period</TableHead>
                      <TableHead>Spot</TableHead>
                      <TableHead>License</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parkingReservations.map((res) => (
                      <TableRow key={res.id}>
                        <TableCell className="font-medium">{res.visitorName}</TableCell>
                        <TableCell className="text-sm">
                          <div>{format(new Date(res.startTime), 'MMM d, h:mm a')}</div>
                          <div className="text-zinc-500">→ {format(new Date(res.endTime), 'MMM d, h:mm a')}</div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{res.spotId === 'auto' ? 'Auto-assigned' : res.spotId}</Badge>
                        </TableCell>
                        <TableCell className="text-sm text-zinc-500">{res.licensePlate || 'N/A'}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={
                            res.status === 'active' ? 'bg-green-100 text-green-700' :
                            res.status === 'cancelled' ? 'bg-red-100 text-red-700' :
                            'bg-zinc-100 text-zinc-600'
                          }>
                            {res.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {res.status === 'active' && !isPast(new Date(res.startTime)) && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-red-600"
                              onClick={() => cancelParkingMutation.mutate(res.id)}
                            >
                              Cancel
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="archive" className="space-y-6">
          <Card className="bg-white border-zinc-200">
            <CardHeader>
              <CardTitle>Expired & Revoked Passes</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow className="bg-zinc-50">
                    <TableHead>Visitor</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Valid Period</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accessPasses?.filter(p => p.status === 'expired' || p.status === 'revoked' || p.status === 'used').map((pass) => (
                    <TableRow key={pass.id}>
                      <TableCell className="font-medium">{pass.visitorName}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <code className="bg-zinc-100 px-2 py-1 rounded font-mono">
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
                        <div>{format(new Date(pass.validFrom), 'MMM d, h:mm a')}</div>
                        {pass.validUntil && (
                          <div className="text-zinc-500">→ {format(new Date(pass.validUntil), 'MMM d, h:mm a')}</div>
                        )}
                      </TableCell>
                      <TableCell>{getStatusBadge(pass)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => copyCode(pass.code6)}
                        >
                          <Copy className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!accessPasses?.some(p => p.status === 'expired' || p.status === 'revoked' || p.status === 'used') && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-zinc-400 py-8">
                        No archived passes yet
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
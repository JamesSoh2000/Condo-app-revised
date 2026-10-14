import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ShieldAlert, MapPin, Send } from 'lucide-react';
import { toast } from "sonner";

export default function SecurityReportPage() {
  const [report, setReport] = useState({
    type: 'noise',
    location: '',
    description: ''
  });
  
  const createMutation = useMutation({
    mutationFn: async (data) => {
        const user = await base44.auth.me();
        
        // Fetch Profile to get accurate name
        const profiles = await base44.entities.Profile.filter({ userId: user.id });
        const residentName = profiles.length > 0 ? profiles[0].full_name : user.full_name;
        
        // Create report for management/property to see
        const rep = await base44.entities.Report.create({
          type: 'incident',
          subject: `${data.type.charAt(0).toUpperCase() + data.type.slice(1)} Report`,
          description: `Location: ${data.location}\n\n${data.description}`,
          createdByUserId: user.id,
          createdByName: residentName,
          status: 'submitted',
          recipientRoles: ['property_management', 'board']
        });
        
        // Notify property management
        await base44.entities.Notification.create({
            title: `Resident Security Report: ${data.type.toUpperCase()}`,
            message: `${data.location}: ${data.description}`,
            type: 'security',
            target_role: 'property_management',
            link: 'ManagementReports'
        });
        
        return rep;
    },
    onSuccess: () => {
      toast.success("Report submitted successfully. Management has been notified.");
      setReport({ type: 'noise', location: '', description: '' });
    }
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!report.location || !report.description) {
        toast.error("Please fill in all fields");
        return;
    }
    createMutation.mutate(report);
  };

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div className="text-center space-y-2">
        <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4 text-red-600">
            <ShieldAlert className="w-8 h-8" />
        </div>
        <h1 className="text-2xl font-bold">Submit Security Report</h1>
        <p className="text-zinc-500">Report parking violations, noise complaints, or other concerns. For emergencies, call 911.</p>
      </div>

      <Card className="border-zinc-200 shadow-xl shadow-zinc-100/50">
        <CardContent className="p-6">
            <form onSubmit={handleSubmit} className="space-y-6">
                <div className="space-y-2">
                    <label className="text-sm font-medium">Report Type</label>
                    <div className="grid grid-cols-3 gap-3">
                        <button
                            type="button"
                            onClick={() => setReport({...report, type: 'noise'})}
                            className={`p-4 rounded-xl border-2 transition-all ${report.type === 'noise' ? 'border-red-500 bg-red-50 text-red-700' : 'border-zinc-100 hover:border-zinc-200'}`}
                        >
                            <span className="block font-bold">Noise</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => setReport({...report, type: 'parking'})}
                            className={`p-4 rounded-xl border-2 transition-all ${report.type === 'parking' ? 'border-red-500 bg-red-50 text-red-700' : 'border-zinc-100 hover:border-zinc-200'}`}
                        >
                            <span className="block font-bold">Parking</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => setReport({...report, type: 'other'})}
                            className={`p-4 rounded-xl border-2 transition-all ${report.type === 'other' ? 'border-red-500 bg-red-50 text-red-700' : 'border-zinc-100 hover:border-zinc-200'}`}
                        >
                            <span className="block font-bold">Other</span>
                        </button>
                    </div>
                </div>

                <div className="space-y-2">
                    <label className="text-sm font-medium flex items-center gap-2">
                        <MapPin className="w-4 h-4" /> Location
                    </label>
                    <Input 
                        placeholder={report.type === 'parking' ? "e.g. Spot #104 or P1 Level" : report.type === 'noise' ? "e.g. Unit 402 or Hallway" : "e.g. Specific location"}
                        value={report.location}
                        onChange={e => setReport({...report, location: e.target.value})}
                    />
                </div>

                <div className="space-y-2">
                    <label className="text-sm font-medium">Description</label>
                    <Textarea 
                        placeholder="Please describe the issue..."
                        className="min-h-[120px]"
                        value={report.description}
                        onChange={e => setReport({...report, description: e.target.value})}
                    />
                </div>

                <Button className="w-full bg-red-600 hover:bg-red-700 h-12 text-lg" disabled={createMutation.isPending}>
                    {createMutation.isPending ? 'Submitting...' : 'Submit Report'}
                </Button>
            </form>
        </CardContent>
      </Card>
    </div>
  );
}
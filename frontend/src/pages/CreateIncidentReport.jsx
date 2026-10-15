import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Upload, Send } from 'lucide-react';

export default function CreateIncidentReport() {
  const [user, setUser] = useState(null);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [tower, setTower] = useState('');
  const [unit, setUnit] = useState('');
  const [photos, setPhotos] = useState([]);
  const [uploading, setUploading] = useState(false);
  const navigate = useNavigate();

  React.useEffect(() => {
    const load = async () => {
      const u = await base44.auth.me();
      setUser(u);
    };
    load();
  }, []);

  const createReport = useMutation({
    mutationFn: async (data) => {
      // Fetch current profile to get latest name, unit, and phone
      const profiles = await base44.entities.Profile.filter({ userId: user.id });
      const profile = profiles.length > 0 ? profiles[0] : null;

      const enrichedData = {
        ...data,
        createdByName: profile?.full_name || user.full_name,
        unit: profile?.unit_number || data.unit,
        createdByPhone: profile?.primary_phone || ''
      };

      const report = await base44.entities.Report.create(enrichedData);

      // Notify property management
      const notifyName = profile?.full_name || user.full_name;
      await base44.entities.Notification.create({
        title: 'New Incident Report',
        message: `${notifyName} submitted an incident report: ${subject}`,
        type: 'security',
        target_role: 'property_management',
        related_entity_id: report.id
      });

      // Notify all board members individually for badge tracking
      const allUsers = await base44.entities.User.list();
      const boardMembers = allUsers.filter(u => u.management_role === 'board' || u.app_role === 'board');

      console.log('====== INCIDENT REPORT NOTIFICATION DEBUG ======');
      console.log('boardRecipientsFound:', boardMembers.length);
      console.log('Board member IDs:', boardMembers.map(b => ({ id: b.id, email: b.email })));

      const createdNotifications = [];
      for (const boardMember of boardMembers) {
        const notification = await base44.entities.Notification.create({
          title: 'New Incident Report',
          message: `${notifyName} submitted an incident report: ${subject}`,
          type: 'security_report',
          target_user_id: boardMember.id,
          related_entity_id: report.id,
          is_read: false
        });
        createdNotifications.push(notification);
      }

      console.log('createdNotifications:', createdNotifications.length);
      if (createdNotifications.length > 0) {
        console.log('SAMPLE notification row:', {
          id: createdNotifications[0].id,
          recipientUserId: createdNotifications[0].target_user_id,
          type: createdNotifications[0].type,
          is_read: createdNotifications[0].is_read,
          reportId: createdNotifications[0].related_entity_id
        });
      }
      console.log('===============================================');

      return report;
    },
    onSuccess: (report) => {
      toast.success('Incident report submitted successfully');
      toast.info(`Debug: Created notifications for board members (reportId: ${report.id})`, { duration: 5000 });
      navigate(createPageUrl('security-reports'));
    },
    onError: () => {
      toast.error('Failed to submit report');
    }
  });

  const handlePhotoUpload = async (e) => {
    const files = Array.from(e.target.files);
    setUploading(true);
    try {
      const uploadedUrls = [];
      for (const file of files) {
        const { file_url } = await base44.integrations.Core.UploadFile({ file });
        uploadedUrls.push(file_url);
      }
      setPhotos([...photos, ...uploadedUrls]);
      toast.success(`${files.length} photo(s) uploaded`);
    } catch (error) {
      toast.error('Failed to upload photos');
    }
    setUploading(false);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!subject || !description) {
      toast.error('Please fill in all required fields');
      return;
    }

    createReport.mutate({
      type: 'incident',
      createdByUserId: user.id,
      createdByName: user.full_name,
      tower,
      unit,
      subject,
      description,
      photos,
      status: 'submitted',
      recipientRoles: ['property_management', 'board']
    });
  };

  if (!user) return null;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Create Incident Report</h1>
        <p className="text-zinc-500 mt-2">Submit to Management & Board</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Report Details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Subject *</Label>
              <Input
                placeholder="Brief summary of incident"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Tower (Optional)</Label>
                <Select value={tower} onValueChange={setTower}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select tower" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="E">East</SelectItem>
                    <SelectItem value="W">West</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Unit (Optional)</Label>
                <Input
                  placeholder="e.g., 101"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                />
              </div>
            </div>

            <div>
              <Label>Description *</Label>
              <Textarea
                placeholder="Detailed description of the incident..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={6}
                required
              />
            </div>

            <div>
              <Label>Photos (Optional)</Label>
              <div className="border-2 border-dashed rounded-lg p-6 text-center">
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handlePhotoUpload}
                  className="hidden"
                  id="photo-upload"
                  disabled={uploading}
                />
                <label htmlFor="photo-upload" className="cursor-pointer">
                  <Upload className="w-8 h-8 mx-auto text-zinc-400 mb-2" />
                  <p className="text-sm text-zinc-500">
                    {uploading ? 'Uploading...' : 'Click to upload photos'}
                  </p>
                </label>
              </div>
              {photos.length > 0 && (
                <div className="grid grid-cols-3 gap-2 mt-2">
                  {photos.map((url, i) => (
                    <img key={i} src={url} alt="" className="w-full h-20 object-cover rounded" />
                  ))}
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate(createPageUrl('security-reports'))}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createReport.isPending || !subject || !description}
                className="flex-1"
              >
                <Send className="w-4 h-4 mr-2" />
                Submit Report
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

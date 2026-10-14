import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Upload, Send } from 'lucide-react';

export default function CreateShiftReport() {
  const [user, setUser] = useState(null);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
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
        createdByPhone: profile?.primary_phone || ''
      };

      const report = await base44.entities.Report.create(enrichedData);
      
      // Notify property management
      const notifyName = profile?.full_name || user.full_name;
      await base44.entities.Notification.create({
        title: 'New Shift Report',
        message: `${notifyName} submitted a shift report: ${subject}`,
        type: 'security',
        target_role: 'property_management',
        related_entity_id: report.id
      });
      
      // Notify all board members individually for badge tracking
      const allUsers = await base44.entities.User.list();
      const boardMembers = allUsers.filter(u => u.management_role === 'board' || u.app_role === 'board');
      
      console.log('====== SHIFT REPORT NOTIFICATION DEBUG ======');
      console.log('boardRecipientsFound:', boardMembers.length);
      console.log('Board member IDs:', boardMembers.map(b => ({ id: b.id, email: b.email })));
      
      const createdNotifications = [];
      for (const boardMember of boardMembers) {
        const notification = await base44.entities.Notification.create({
          title: 'New Shift Report',
          message: `${notifyName} submitted a shift report: ${subject}`,
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
      console.log('=============================================');
      
      return report;
    },
    onSuccess: (report) => {
      toast.success('Shift report submitted successfully');
      setTimeout(() => {
        navigate(createPageUrl('security-reports'));
      }, 1500);
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
      type: 'shift',
      createdByUserId: user.id,
      createdByName: user.full_name,
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
        <h1 className="text-3xl font-bold">Create Shift Report</h1>
        <p className="text-zinc-500 mt-2">Submit to Management & Board</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Shift Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Shift Date/Time *</Label>
              <Input
                placeholder="e.g., Monday Jan 13, 8am-4pm"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
              />
            </div>

            <div>
              <Label>Shift Notes *</Label>
              <Textarea
                placeholder="Summary of activities, observations, and any notable events during the shift..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={8}
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
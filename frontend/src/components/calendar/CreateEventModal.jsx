import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { CalendarDays, Bell, MapPin, Clock } from 'lucide-react';

const CATEGORY_LABELS = {
  building_event: 'Building Event',
  maintenance_event: 'Maintenance Event',
  community_event: 'Community Event',
  inspection: 'Inspection',
  shutdown: 'Shutdown / Service Interruption',
  general_notice: 'General Notice'
};

export default function CreateEventModal({ open, onClose, onSubmit, defaultDate, editEvent, showResidentToggle = true }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState(defaultDate || new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(defaultDate || new Date().toISOString().split('T')[0]);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [location, setLocation] = useState('');
  const [category, setCategory] = useState('building_event');
  const [sendToResidents, setSendToResidents] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Populate form when editing
  useEffect(() => {
    if (editEvent) {
      setTitle(editEvent.title || '');
      setDescription(editEvent.description || '');
      setStartDate(editEvent.start_date || defaultDate);
      setEndDate(editEvent.end_date || defaultDate);
      setStartTime(editEvent.start_time || '');
      setEndTime(editEvent.end_time || '');
      setAllDay(editEvent.all_day || false);
      setLocation(editEvent.location || '');
      setCategory(editEvent.category || 'building_event');
      setSendToResidents(editEvent.send_to_residents || false);
    } else {
      setTitle('');
      setDescription('');
      setStartDate(defaultDate || new Date().toISOString().split('T')[0]);
      setEndDate(defaultDate || new Date().toISOString().split('T')[0]);
      setStartTime('');
      setEndTime('');
      setAllDay(false);
      setLocation('');
      setCategory('building_event');
      setSendToResidents(true);
    }
  }, [editEvent, open, defaultDate]);

  // Auto-sync end date if before start
  const handleStartDateChange = (v) => {
    setStartDate(v);
    if (endDate < v) setEndDate(v);
  };

  const handleSubmit = async () => {
    if (!title || !startDate) return;
    setIsSubmitting(true);
    await onSubmit({
      title,
      description,
      start_date: startDate,
      end_date: endDate || startDate,
      start_time: allDay ? '' : startTime,
      end_time: allDay ? '' : endTime,
      all_day: allDay,
      location,
      category,
      send_to_residents: sendToResidents
    });
    setIsSubmitting(false);
  };

  const isMultiDay = startDate && endDate && endDate > startDate;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="w-5 h-5 text-orange-500" />
            {editEvent ? 'Edit Building Event' : 'Add Building Event'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Title */}
          <div>
            <Label>Event Title *</Label>
            <Input
              placeholder="e.g., Fire Alarm Testing, Community BBQ"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* Category */}
          <div>
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Date Range */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Start Date *</Label>
              <Input type="date" value={startDate} onChange={(e) => handleStartDateChange(e.target.value)} />
            </div>
            <div>
              <Label>End Date</Label>
              <Input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>

          {isMultiDay && (
            <div className="flex items-center gap-2 px-3 py-2 bg-orange-50 border border-orange-200 rounded-lg">
              <CalendarDays className="w-4 h-4 text-orange-500" />
              <span className="text-xs text-orange-700 font-medium">Multi-day event spanning {
                Math.round((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24) + 1)
              } days</span>
            </div>
          )}

          {/* All-day toggle */}
          <div className="flex items-center justify-between">
            <Label>All-Day Event</Label>
            <Switch checked={allDay} onCheckedChange={setAllDay} />
          </div>

          {/* Times */}
          {!allDay && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>
                  <Clock className="w-3 h-3 inline mr-1" />
                  Start Time
                </Label>
                <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </div>
              <div>
                <Label>End Time</Label>
                <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </div>
            </div>
          )}

          {/* Location */}
          <div>
            <Label>
              <MapPin className="w-3 h-3 inline mr-1" />
              Location (optional)
            </Label>
            <Input
              placeholder="e.g., Lobby, Tower E, Parking Garage"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </div>

          {/* Description */}
          <div>
            <Label>Details / Description</Label>
            <Textarea
              placeholder="Describe the event, what residents or staff should know..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          {/* Send to Residents toggle */}
          {showResidentToggle && (
            <div className={`p-4 rounded-xl border-2 transition-all ${sendToResidents ? 'border-green-400 bg-green-50' : 'border-zinc-200 bg-zinc-50'}`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <Bell className={`w-4 h-4 ${sendToResidents ? 'text-green-600' : 'text-zinc-400'}`} />
                  <span className="font-semibold text-sm">Send to Residents</span>
                </div>
                <Switch checked={sendToResidents} onCheckedChange={setSendToResidents} />
              </div>
              <p className="text-xs text-zinc-500 ml-6">
                {sendToResidents
                  ? 'Residents will see this event in their Updates & Alerts feed.'
                  : 'Also post this event to resident Updates & Alerts.'}
              </p>
              {sendToResidents && (
                <div className="mt-2 ml-6">
                  <Badge className="bg-green-600 text-white text-xs">Will be posted to Updates & Alerts</Badge>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!title || !startDate || isSubmitting}>
            {isSubmitting ? 'Saving…' : editEvent ? 'Save Changes' : 'Create Event'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

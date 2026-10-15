import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CalendarDays, Clock, MapPin, Bell, Pencil, Trash2, CheckCircle2 } from 'lucide-react';
import { format, parseISO } from 'date-fns';

const CATEGORY_LABELS = {
  building_event: 'Building Event',
  maintenance_event: 'Maintenance Event',
  community_event: 'Community Event',
  inspection: 'Inspection',
  shutdown: 'Shutdown / Service Interruption',
  general_notice: 'General Notice'
};

const CATEGORY_COLORS = {
  building_event: 'bg-orange-100 text-orange-700',
  maintenance_event: 'bg-blue-100 text-blue-700',
  community_event: 'bg-green-100 text-green-700',
  inspection: 'bg-yellow-100 text-yellow-700',
  shutdown: 'bg-red-100 text-red-700',
  general_notice: 'bg-zinc-100 text-zinc-700'
};

export default function EventDetailModal({ event, onClose, onEdit, onDelete, onComplete }) {
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState(true);

  if (!event) return null;

  const isMultiDay = event.start_date !== event.end_date;

  const formatDateRange = () => {
    if (!event.start_date) return '';
    if (!isMultiDay) return format(parseISO(event.start_date), 'EEEE, MMMM d, yyyy');
    return `${format(parseISO(event.start_date), 'MMM d')} – ${format(parseISO(event.end_date), 'MMM d, yyyy')}`;
  };

  const formatTimeRange = () => {
    if (event.all_day) return 'All Day';
    if (!event.start_time) return null;
    return event.end_time ? `${event.start_time} – ${event.end_time}` : event.start_time;
  };

  const timeRange = formatTimeRange();

  if (deleteConfirm) {
    return (
      <Dialog open={true} onOpenChange={() => { setDeleteConfirm(false); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Event</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-zinc-600">
            Are you sure you want to delete "<strong>{event.title}</strong>"?
          </p>
          {event.send_to_residents && event.linked_notice_id && (
            <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-sm font-medium text-amber-800 mb-2">
                This event was sent to residents.
              </p>
              <label className="flex items-center gap-2 text-sm text-amber-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={deleteNotice}
                  onChange={(e) => setDeleteNotice(e.target.checked)}
                  className="rounded"
                />
                Also remove the resident notice from Updates &amp; Alerts
              </label>
            </div>
          )}
          <div className="flex gap-2 justify-end mt-4">
            <Button variant="outline" onClick={() => setDeleteConfirm(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => onDelete(event, deleteNotice && event.linked_notice_id)}>
              <Trash2 className="w-4 h-4 mr-2" /> Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <Badge className={`${CATEGORY_COLORS[event.category] || CATEGORY_COLORS.general_notice} text-xs`}>
              {CATEGORY_LABELS[event.category] || 'Event'}
            </Badge>
            {event.send_to_residents && (
              <Badge className="bg-green-100 text-green-700 text-xs">
                <Bell className="w-3 h-3 mr-1" /> Sent to Residents
              </Badge>
            )}
            {event.status === 'completed' && (
              <Badge className="bg-green-600 text-white text-xs">Completed</Badge>
            )}
          </DialogTitle>
          <h3 className={`text-lg font-semibold mt-1 ${event.status === 'completed' ? 'line-through text-zinc-400' : ''}`}>
            {event.title}
          </h3>
        </DialogHeader>

        <div className="space-y-3 mt-2">
          <div className="flex items-start gap-3">
            <CalendarDays className="w-4 h-4 text-zinc-400 mt-0.5 flex-shrink-0" />
            <span className="text-sm text-zinc-700">{formatDateRange()}</span>
          </div>

          {timeRange && (
            <div className="flex items-start gap-3">
              <Clock className="w-4 h-4 text-zinc-400 mt-0.5 flex-shrink-0" />
              <span className="text-sm text-zinc-700">{timeRange}</span>
            </div>
          )}

          {event.location && (
            <div className="flex items-start gap-3">
              <MapPin className="w-4 h-4 text-zinc-400 mt-0.5 flex-shrink-0" />
              <span className="text-sm text-zinc-700">{event.location}</span>
            </div>
          )}

          {event.description && (
            <div className="pt-2 border-t border-zinc-100">
              <p className="text-sm text-zinc-600 whitespace-pre-wrap">{event.description}</p>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-zinc-100">
          {event.status !== 'completed' && onEdit && (
            <Button variant="outline" size="sm" onClick={() => onEdit(event)}>
              <Pencil className="w-4 h-4 mr-1" /> Edit
            </Button>
          )}
          {event.status !== 'completed' && onComplete && (
            <Button variant="outline" size="sm" onClick={() => onComplete(event)}>
              <CheckCircle2 className="w-4 h-4 mr-1" /> Mark Complete
            </Button>
          )}
          {onDelete && (
            <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-700 hover:bg-red-50 ml-auto" onClick={() => setDeleteConfirm(true)}>
              <Trash2 className="w-4 h-4 mr-1" /> Delete
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

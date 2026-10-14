import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { format } from 'date-fns';
import { AlertCircle, MapPin, Clock, User, Bell, Package, ShieldAlert, Paperclip, Pencil, Trash2, CheckCircle2, X } from 'lucide-react';
import AttachmentViewer from './AttachmentViewer';

export default function BuildingUpdateModal({ update, isOpen, onClose, user, onUnsend, onEdit, onResolve }) {
  const [mode, setMode] = useState('view'); // 'view' | 'edit' | 'confirmUnsend'
  const [editedMessage, setEditedMessage] = useState('');
  const [editedTitle, setEditedTitle] = useState('');

  if (!update) return null;

  // Only security and management roles can manage notices
  const appRole = user?.management_role || user?.app_role;
  const canManage = appRole === 'security' || appRole === 'property_management' || appRole === 'board' || user?.isAdmin;

  const getTypeBadge = (type) => {
    const config = {
      general: { label: 'General', className: 'bg-blue-100 text-blue-700', icon: Bell },
      maintenance: { label: 'Maintenance', className: 'bg-orange-100 text-orange-700', icon: AlertCircle },
      security: { label: 'Security', className: 'bg-red-100 text-red-700', icon: ShieldAlert },
      security_report: { label: 'Security', className: 'bg-red-100 text-red-700', icon: ShieldAlert },
      amenity: { label: 'Amenity', className: 'bg-purple-100 text-purple-700', icon: Bell },
      emergency: { label: 'Emergency', className: 'bg-red-600 text-white', icon: AlertCircle },
      package: { label: 'Package', className: 'bg-blue-100 text-blue-700', icon: Package },
      announcement: { label: 'Announcement', className: 'bg-indigo-100 text-indigo-700', icon: Bell }
    };
    return config[type] || config.general;
  };

  const typeBadge = getTypeBadge(update.type);
  const isBuilding = update.source === 'building';
  const postedBy = isBuilding ? (update.postedByName || 'Management') : 'Management';
  const isResolved = update.is_resolved === true;

  const handleStartEdit = () => {
    setEditedTitle(update.title);
    setEditedMessage(update.message);
    setMode('edit');
  };

  const handleSaveEdit = () => {
    if (!editedTitle.trim() || !editedMessage.trim()) return;
    onEdit?.({ ...update, title: editedTitle.trim(), message: editedMessage.trim() });
    setMode('view');
  };

  const handleUnsendConfirm = () => {
    onUnsend?.(update);
    setMode('view');
    onClose();
  };

  const handleClose = () => {
    setMode('view');
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[90vw] md:max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader className="flex-shrink-0 pr-10">
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <DialogTitle className="flex-1 text-xl md:text-2xl leading-snug">
                <span className={isResolved ? 'line-through text-zinc-400' : ''}>
                  {mode === 'edit' ? editedTitle : update.title}
                </span>
                {isResolved && (
                  <span className="ml-2 inline-flex items-center gap-1 text-sm font-normal text-green-600 no-underline">
                    <CheckCircle2 className="w-4 h-4" /> Resolved
                  </span>
                )}
              </DialogTitle>
            </div>
            {update.priority === 'important' && (
              <div>
                <Badge className="bg-red-600 text-white">
                  <AlertCircle className="w-3 h-3 mr-1" />
                  Important
                </Badge>
              </div>
            )}
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge variant="outline" className={typeBadge.className}>
                {typeBadge.label}
              </Badge>
              <div className="flex items-center gap-1 text-zinc-500">
                <User className="w-3 h-3" />
                <span>{postedBy}</span>
                <span className="mx-1">•</span>
                <span>{format(new Date(update.created_date), 'MMM d, yyyy h:mm a')}</span>
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 mt-4 pr-2">
          {update.location && (
            <div className="flex items-start gap-2 text-sm bg-zinc-50 p-3 rounded-lg">
              <MapPin className="w-4 h-4 text-zinc-500 mt-0.5 flex-shrink-0" />
              <div>
                <div className="font-medium text-zinc-700">Location</div>
                <div className="text-zinc-600">{update.location}</div>
              </div>
            </div>
          )}

          {(update.startTime || update.endTime) && (
            <div className="flex items-start gap-2 text-sm bg-zinc-50 p-3 rounded-lg">
              <Clock className="w-4 h-4 text-zinc-500 mt-0.5 flex-shrink-0" />
              <div>
                <div className="font-medium text-zinc-700">Time Period</div>
                <div className="text-zinc-600">
                  {update.startTime && format(new Date(update.startTime), 'MMM d, h:mm a')}
                  {update.startTime && update.endTime && ' - '}
                  {update.endTime && format(new Date(update.endTime), 'MMM d, h:mm a')}
                </div>
              </div>
            </div>
          )}

          {mode === 'edit' ? (
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-zinc-600 mb-1 block">Title</label>
                <input
                  className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-300"
                  value={editedTitle}
                  onChange={(e) => setEditedTitle(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-zinc-600 mb-1 block">Message</label>
                <Textarea
                  className="min-h-[120px] text-sm"
                  value={editedMessage}
                  onChange={(e) => setEditedMessage(e.target.value)}
                />
              </div>
            </div>
          ) : mode === 'confirmUnsend' ? (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <p className="text-sm font-semibold text-red-800 mb-1">
                {update.type === 'emergency'
                  ? 'Are you sure you want to delete this emergency alert? This will remove it from the active Updates & Alerts feed for all users.'
                  : 'Are you sure you want to unsend this notice? It will be removed for all users.'}
              </p>
              <p className="text-xs text-red-600">This action cannot be undone.</p>
            </div>
          ) : (
            <div className={`prose prose-sm max-w-none`}>
              <div className={`whitespace-pre-wrap leading-relaxed text-base ${isResolved ? 'line-through text-zinc-400' : 'text-zinc-700'}`}>
                {update.message}
              </div>
            </div>
          )}

          {update.attachment_url && mode !== 'edit' && (
            <div>
              <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-2">
                <Paperclip className="w-3.5 h-3.5" />
                <span className="font-medium">{update.attachment_name || 'Attachment'}</span>
                {update.attachment_size && (
                  <span className="text-zinc-400">
                    · {update.attachment_size < 1048576
                        ? (update.attachment_size / 1024).toFixed(1) + ' KB'
                        : (update.attachment_size / 1048576).toFixed(1) + ' MB'}
                  </span>
                )}
              </div>
              <AttachmentViewer update={update} />
            </div>
          )}
        </div>

        {/* Action bar — only for management/security, only for building updates */}
        {canManage && isBuilding && (
          <div className="flex-shrink-0 border-t border-zinc-100 pt-3 mt-3">
            {mode === 'view' && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs"
                  onClick={handleStartEdit}
                >
                  <Pencil className="w-3.5 h-3.5" />
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className={`gap-1.5 text-xs ${isResolved ? 'text-zinc-500' : 'text-green-700 border-green-200 hover:bg-green-50'}`}
                  onClick={() => onResolve?.(update)}
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {isResolved ? 'Unresolve' : 'Resolve'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs text-red-600 border-red-200 hover:bg-red-50 ml-auto"
                  onClick={() => setMode('confirmUnsend')}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Unsend
                </Button>
              </div>
            )}
            {mode === 'edit' && (
              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => setMode('view')}>
                  <X className="w-3.5 h-3.5 mr-1" /> Cancel
                </Button>
                <Button size="sm" onClick={handleSaveEdit} disabled={!editedTitle.trim() || !editedMessage.trim()}>
                  Update
                </Button>
              </div>
            )}
            {mode === 'confirmUnsend' && (
              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => setMode('view')}>
                  Cancel
                </Button>
                <Button variant="destructive" size="sm" onClick={handleUnsendConfirm}>
                  <Trash2 className="w-3.5 h-3.5 mr-1" />
                  {update.type === 'emergency' ? 'Delete Alert' : 'Unsend Notice'}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
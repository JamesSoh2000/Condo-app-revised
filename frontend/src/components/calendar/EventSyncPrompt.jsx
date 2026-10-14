import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Bell, BellOff } from 'lucide-react';

export default function EventSyncPrompt({ open, onClose, onUpdateNotice, onSkip }) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Update Resident Notice?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-zinc-600">
          This event was sent to residents. Would you like to update the resident notice in Updates &amp; Alerts as well?
        </p>
        <div className="flex flex-col gap-2 mt-4">
          <Button onClick={onUpdateNotice} className="w-full">
            <Bell className="w-4 h-4 mr-2" /> Yes, update resident notice
          </Button>
          <Button variant="outline" onClick={onSkip} className="w-full">
            <BellOff className="w-4 h-4 mr-2" /> No, keep resident notice unchanged
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
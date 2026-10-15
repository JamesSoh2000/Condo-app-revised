import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Lock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { Button } from '@/components/ui/button';

export default function PendingApprovalBlock() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="max-w-md">
        <CardContent className="p-8 text-center">
          <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Lock className="w-8 h-8 text-amber-600" />
          </div>
          <h2 className="text-2xl font-bold text-zinc-900 mb-2">Pending Approval</h2>
          <p className="text-zinc-600 mb-6">
            This feature will be available once your profile is approved by management.
            Please complete your profile and upload required documents.
          </p>
          <Link to={createPageUrl('Profile')}>
            <Button>
              Go to My Profile
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

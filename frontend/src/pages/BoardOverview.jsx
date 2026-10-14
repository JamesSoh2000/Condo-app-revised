import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { ShieldAlert, Wrench } from 'lucide-react';

export default function BoardOverview() {
  return (
    <div className="space-y-8">
        <div className="bg-zinc-900 text-white p-8 rounded-3xl">
            <h1 className="text-3xl font-bold mb-2">Board Oversight</h1>
            <p className="text-zinc-400">Access all operations and management tools.</p>
        </div>
        
        <div className="grid md:grid-cols-2 gap-6">
          {/* Security Reports */}
          <Card className="border-zinc-200">
            <CardHeader className="bg-zinc-50 border-b border-zinc-200">
              <CardTitle className="flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-blue-600" />
                Security Reports
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              <Link to={createPageUrl('ManagementReports')}>
                <Button variant="outline" className="w-full justify-start text-left h-auto py-3">
                  <ShieldAlert className="w-4 h-4 mr-3 text-zinc-600" />
                  <span>View All Security Reports</span>
                </Button>
              </Link>
            </CardContent>
          </Card>

          {/* Management Window */}
          <Card className="border-zinc-200">
            <CardHeader className="bg-zinc-50 border-b border-zinc-200">
              <CardTitle className="flex items-center gap-2">
                <Wrench className="w-5 h-5 text-purple-600" />
                Management
              </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
              <p className="text-sm text-zinc-500 italic text-center py-8">
                Management tools coming soon
              </p>
            </CardContent>
          </Card>
        </div>
    </div>
  );
}
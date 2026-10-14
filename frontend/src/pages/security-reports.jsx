import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { FileText, ShieldAlert, ClipboardList } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { motion } from 'framer-motion';

export default function SecurityReports() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight mb-2">Security Reports</h1>
        <p className="text-zinc-500">Create and submit reports to Management & Board</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Create Incident Report */}
        <Link to={createPageUrl('CreateIncidentReport')}>
          <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
            <Card className="h-full cursor-pointer hover:shadow-lg transition-all duration-300 border-2 hover:border-red-300">
              <CardContent className="p-8 text-center space-y-4">
                <div className="w-16 h-16 rounded-full bg-red-50 text-red-600 flex items-center justify-center mx-auto">
                  <ShieldAlert className="w-8 h-8" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold mb-2">Create Incident Report</h2>
                  <p className="text-zinc-500">Submit to Management & Board</p>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </Link>

        {/* Create Shift Report */}
        <Link to={createPageUrl('CreateShiftReport')}>
          <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
            <Card className="h-full cursor-pointer hover:shadow-lg transition-all duration-300 border-2 hover:border-blue-300">
              <CardContent className="p-8 text-center space-y-4">
                <div className="w-16 h-16 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
                  <ClipboardList className="w-8 h-8" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold mb-2">Create Shift Report</h2>
                  <p className="text-zinc-500">Submit to Management & Board</p>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </Link>
      </div>
    </div>
  );
}
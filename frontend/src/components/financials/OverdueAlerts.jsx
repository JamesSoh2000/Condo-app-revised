import React from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, TrendingDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export default function OverdueAlerts({ charges, onSelectCharge }) {
  const overdue = charges.filter(c => c.status === 'overdue');
  const highBalance = charges.filter(c => c.status === 'unpaid' && (c.amount || 0) >= 500);

  if (overdue.length === 0 && highBalance.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="rounded-2xl border border-red-200 bg-red-50/70 p-4"
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
        </span>
        <p className="text-sm font-bold text-red-700">Financial Alerts</p>
        <Badge className="bg-red-500 text-white text-xs ml-auto">
          {overdue.length + highBalance.length} issues
        </Badge>
      </div>

      <div className="space-y-2">
        {overdue.map((c, i) => (
          <motion.div
            key={c.id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.05 }}
            onClick={() => onSelectCharge?.(c)}
            className="flex items-center justify-between bg-white rounded-xl px-3 py-2.5 border border-red-100 cursor-pointer hover:border-red-300 transition-all"
          >
            <div className="flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
              <div>
                <p className="text-xs font-semibold text-zinc-800">{c.resident_name || 'Unknown'}{c.unit_number ? ` · Unit ${c.unit_number}` : ''}</p>
                <p className="text-[11px] text-zinc-400">Overdue · {c.charge_type?.replace('_', ' ')}{c.due_date ? ` · Due ${c.due_date}` : ''}</p>
              </div>
            </div>
            <span className="text-sm font-bold text-red-600">${(c.amount || 0).toLocaleString('en-CA', { minimumFractionDigits: 2 })}</span>
          </motion.div>
        ))}
        {highBalance.filter(c => !overdue.find(o => o.id === c.id)).map((c, i) => (
          <motion.div
            key={c.id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: (overdue.length + i) * 0.05 }}
            onClick={() => onSelectCharge?.(c)}
            className="flex items-center justify-between bg-white rounded-xl px-3 py-2.5 border border-amber-100 cursor-pointer hover:border-amber-300 transition-all"
          >
            <div className="flex items-center gap-2.5">
              <TrendingDown className="w-4 h-4 text-amber-500 flex-shrink-0" />
              <div>
                <p className="text-xs font-semibold text-zinc-800">{c.resident_name || 'Unknown'}{c.unit_number ? ` · Unit ${c.unit_number}` : ''}</p>
                <p className="text-[11px] text-zinc-400">High unpaid balance · {c.charge_type?.replace('_', ' ')}</p>
              </div>
            </div>
            <span className="text-sm font-bold text-amber-600">${(c.amount || 0).toLocaleString('en-CA', { minimumFractionDigits: 2 })}</span>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}
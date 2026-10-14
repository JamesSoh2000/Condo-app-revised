import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, CheckCircle2, CreditCard, User, Hash, Calendar, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';

const CHARGE_TYPE_LABELS = { condo_fee: 'Condo Fee', lounge_rental: 'Lounge Rental', key_fob: 'Key / Fob', fine: 'Fine', rent: 'Rent', other: 'Other' };
const CHARGE_COLORS = { condo_fee: 'bg-blue-100 text-blue-700', lounge_rental: 'bg-purple-100 text-purple-700', key_fob: 'bg-zinc-100 text-zinc-700', fine: 'bg-red-100 text-red-700', rent: 'bg-emerald-100 text-emerald-700', other: 'bg-amber-100 text-amber-700' };
const STATUS_COLORS = { unpaid: 'bg-amber-100 text-amber-700', paid: 'bg-green-100 text-green-700', overdue: 'bg-red-100 text-red-700', waived: 'bg-zinc-100 text-zinc-500' };

export default function ChargeDetailPanel({ charge, onClose, onMarkPaid, relatedCharges = [] }) {
  if (!charge) return null;

  const fmtCurrency = n => `$${(n || 0).toLocaleString('en-CA', { minimumFractionDigits: 2 })}`;
  const residentHistory = relatedCharges.filter(c => c.id !== charge.id && c.resident_name === charge.resident_name);

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex justify-end">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/30 backdrop-blur-[2px]"
          onClick={onClose}
        />
        {/* Panel */}
        <motion.div
          initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 28, stiffness: 280 }}
          className="relative w-full max-w-md bg-white shadow-2xl flex flex-col z-10 overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-5 border-b border-zinc-100">
            <div>
              <p className="text-base font-bold text-zinc-900">{charge.resident_name || 'Charge Detail'}</p>
              <p className="text-xs text-zinc-400">{charge.unit_number ? `Unit ${charge.unit_number}${charge.tower ? ` ${charge.tower}` : ''}` : 'No unit'}</p>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 hover:bg-zinc-200 flex items-center justify-center transition-colors">
              <X className="w-4 h-4 text-zinc-600" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
            {/* Charge info */}
            <div className="bg-zinc-50 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge className={`text-xs ${CHARGE_COLORS[charge.charge_type] || 'bg-zinc-100 text-zinc-700'}`}>
                    {CHARGE_TYPE_LABELS[charge.charge_type] || charge.charge_type}
                  </Badge>
                  <Badge className={`text-xs ${STATUS_COLORS[charge.status]}`}>{charge.status}</Badge>
                </div>
                <span className="text-xl font-bold text-zinc-900">{fmtCurrency(charge.amount)}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                {charge.due_date && (
                  <div className="flex items-center gap-2 text-zinc-500">
                    <Calendar className="w-3.5 h-3.5" />
                    <span>Due: <span className="font-medium text-zinc-700">{charge.due_date}</span></span>
                  </div>
                )}
                {charge.payment_date && (
                  <div className="flex items-center gap-2 text-zinc-500">
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                    <span>Paid: <span className="font-medium text-zinc-700">{charge.payment_date}</span></span>
                  </div>
                )}
                {charge.payment_method && (
                  <div className="flex items-center gap-2 text-zinc-500">
                    <CreditCard className="w-3.5 h-3.5" />
                    <span>{charge.payment_method.replace('_', ' ')}</span>
                  </div>
                )}
                {charge.created_by_name && (
                  <div className="flex items-center gap-2 text-zinc-500">
                    <User className="w-3.5 h-3.5" />
                    <span>{charge.created_by_name}</span>
                  </div>
                )}
              </div>
              {charge.description && (
                <div className="flex items-start gap-2 text-xs text-zinc-500 pt-1 border-t border-zinc-100">
                  <FileText className="w-3.5 h-3.5 mt-0.5" />
                  <p>{charge.description}</p>
                </div>
              )}
              {charge.notes && (
                <div className="text-xs text-zinc-400 bg-white rounded-lg p-2.5 border border-zinc-100">{charge.notes}</div>
              )}
            </div>

            {/* History */}
            {residentHistory.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-widest mb-3">Payment History</p>
                <div className="space-y-2">
                  {residentHistory.slice(0, 8).map(h => (
                    <div key={h.id} className="flex items-center justify-between bg-zinc-50 rounded-xl px-3 py-2.5">
                      <div>
                        <p className="text-xs font-medium text-zinc-700">{CHARGE_TYPE_LABELS[h.charge_type] || h.charge_type}</p>
                        <p className="text-[11px] text-zinc-400">{h.due_date || h.created_date?.split('T')[0]}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs font-bold text-zinc-800">{fmtCurrency(h.amount)}</p>
                        <Badge className={`text-[10px] ${STATUS_COLORS[h.status]}`}>{h.status}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Actions */}
          {charge.status !== 'paid' && charge.status !== 'waived' && (
            <div className="px-6 py-4 border-t border-zinc-100 bg-zinc-50">
              <Button
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={() => { onMarkPaid(charge.id); onClose(); }}
              >
                <CheckCircle2 className="w-4 h-4 mr-2" /> Mark as Paid
              </Button>
            </div>
          )}
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
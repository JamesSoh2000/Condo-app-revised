import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, ChevronUp, ChevronDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

const CHARGE_TYPE_LABELS = { condo_fee: 'Condo Fee', lounge_rental: 'Lounge Rental', key_fob: 'Key / Fob', fine: 'Fine', rent: 'Rent', other: 'Other' };
const CHARGE_COLORS = { condo_fee: 'bg-blue-100 text-blue-700', lounge_rental: 'bg-purple-100 text-purple-700', key_fob: 'bg-zinc-100 text-zinc-700', fine: 'bg-red-100 text-red-700', rent: 'bg-emerald-100 text-emerald-700', other: 'bg-amber-100 text-amber-700' };
const STATUS_CONFIG = {
  unpaid: { className: 'bg-amber-100 text-amber-700', dot: 'bg-amber-400' },
  paid: { className: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500' },
  overdue: { className: 'bg-red-100 text-red-700 animate-pulse', dot: 'bg-red-500' },
  waived: { className: 'bg-zinc-100 text-zinc-500', dot: 'bg-zinc-300' },
};

const fmtCurrency = n => `$${(n || 0).toLocaleString('en-CA', { minimumFractionDigits: 2 })}`;

export default function ResidentChargesTable({ charges, onSelectCharge, onMarkPaid, onAddCharge }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [sortField, setSortField] = useState('created_date');
  const [sortDir, setSortDir] = useState('desc');

  const filtered = useMemo(() => {
    let list = charges.filter(c => {
      const matchStatus = statusFilter === 'all' || c.status === statusFilter;
      const matchType = typeFilter === 'all' || c.charge_type === typeFilter;
      const matchSearch = !search ||
        c.resident_name?.toLowerCase().includes(search.toLowerCase()) ||
        c.unit_number?.includes(search) ||
        (CHARGE_TYPE_LABELS[c.charge_type] || '').toLowerCase().includes(search.toLowerCase());
      return matchStatus && matchType && matchSearch;
    });

    list = [...list].sort((a, b) => {
      let va = a[sortField], vb = b[sortField];
      if (sortField === 'amount') { va = a.amount || 0; vb = b.amount || 0; }
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb || '') : (vb || '').localeCompare(va);
      return sortDir === 'asc' ? va - vb : vb - va;
    });

    return list;
  }, [charges, search, statusFilter, typeFilter, sortField, sortDir]);

  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  };

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <ChevronUp className="w-3 h-3 text-zinc-300" />;
    return sortDir === 'asc' ? <ChevronUp className="w-3 h-3 text-zinc-700" /> : <ChevronDown className="w-3 h-3 text-zinc-700" />;
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <Input
            placeholder="Search resident, unit, type..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 h-9 text-sm bg-white"
          />
        </div>
        <div className="flex gap-1 flex-wrap">
          {['all', 'unpaid', 'overdue', 'paid', 'waived'].map(f => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all capitalize
                ${statusFilter === f ? 'bg-zinc-900 text-white shadow-sm' : 'bg-white text-zinc-500 border border-zinc-200 hover:border-zinc-300'}`}
            >
              {f === 'all' ? 'All' : f}
            </button>
          ))}
        </div>
        <div className="flex gap-1 flex-wrap">
          <button onClick={() => setTypeFilter('all')} className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${typeFilter === 'all' ? 'bg-indigo-600 text-white' : 'bg-white text-zinc-500 border border-zinc-200'}`}>
            All Types
          </button>
          {Object.entries(CHARGE_TYPE_LABELS).map(([k, v]) => (
            <button key={k} onClick={() => setTypeFilter(k)} className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${typeFilter === k ? 'bg-indigo-600 text-white' : 'bg-white text-zinc-500 border border-zinc-200'}`}>
              {v}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={onAddCharge} className="ml-auto h-9">
          <Plus className="w-4 h-4 mr-1.5" /> Add Charge
        </Button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-zinc-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50/80 border-b border-zinc-100">
              <tr>
                <th className="px-4 py-3 text-left">
                  <button onClick={() => toggleSort('resident_name')} className="flex items-center gap-1 text-xs font-semibold text-zinc-500 uppercase tracking-wide hover:text-zinc-700">
                    Resident <SortIcon field="resident_name" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">Unit</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">Type</th>
                <th className="px-4 py-3 text-left">
                  <button onClick={() => toggleSort('amount')} className="flex items-center gap-1 text-xs font-semibold text-zinc-500 uppercase tracking-wide hover:text-zinc-700">
                    Amount <SortIcon field="amount" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left">
                  <button onClick={() => toggleSort('due_date')} className="flex items-center gap-1 text-xs font-semibold text-zinc-500 uppercase tracking-wide hover:text-zinc-700">
                    Due Date <SortIcon field="due_date" />
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">Status</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-50">
              <AnimatePresence mode="popLayout">
                {filtered.length === 0 ? (
                  <tr key="empty">
                    <td colSpan={7} className="px-4 py-10 text-center text-zinc-400 text-sm">No charges found</td>
                  </tr>
                ) : filtered.map((c, idx) => {
                  const statusCfg = STATUS_CONFIG[c.status] || STATUS_CONFIG.unpaid;
                  return (
                    <motion.tr
                      key={c.id}
                      layout
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.18, delay: Math.min(idx * 0.02, 0.3) }}
                      className="hover:bg-zinc-50/70 cursor-pointer transition-colors group"
                      onClick={() => onSelectCharge(c)}
                    >
                      <td className="px-4 py-3 font-semibold text-zinc-800">{c.resident_name || '—'}</td>
                      <td className="px-4 py-3 text-zinc-500 text-xs">{c.unit_number ? `${c.unit_number}${c.tower ? ` ${c.tower}` : ''}` : '—'}</td>
                      <td className="px-4 py-3">
                        <Badge className={`text-xs ${CHARGE_COLORS[c.charge_type] || 'bg-zinc-100 text-zinc-700'}`}>
                          {CHARGE_TYPE_LABELS[c.charge_type] || c.charge_type}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 font-bold text-zinc-800">{fmtCurrency(c.amount)}</td>
                      <td className="px-4 py-3 text-zinc-500 text-xs">{c.due_date || '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${statusCfg.className}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${statusCfg.dot}`} />
                          {c.status}
                        </span>
                      </td>
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        {c.status !== 'paid' && c.status !== 'waived' && (
                          <Button
                            size="sm" variant="outline"
                            className="text-xs h-7 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={() => onMarkPaid(c.id)}
                          >
                            Mark Paid
                          </Button>
                        )}
                      </td>
                    </motion.tr>
                  );
                })}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="px-4 py-3 border-t border-zinc-50 flex items-center justify-between">
            <span className="text-xs text-zinc-400">{filtered.length} record{filtered.length !== 1 ? 's' : ''}</span>
            <span className="text-sm font-bold text-zinc-700">
              Total: {fmtCurrency(filtered.reduce((s, c) => s + (c.amount || 0), 0))}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

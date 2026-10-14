import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { format } from 'date-fns';
import {
  DollarSign, TrendingUp, TrendingDown, CreditCard, FileText, Users,
  Plus, CheckCircle2, Receipt, Building2, Landmark, PieChart,
  RefreshCw, Download, BarChart2, AlertCircle, Lightbulb
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';

import AnimatedMetricCard from '@/components/financials/AnimatedMetricCard';
import FinancialCharts from '@/components/financials/FinancialCharts';
import OverdueAlerts from '@/components/financials/OverdueAlerts';
import FinancialInsights from '@/components/financials/FinancialInsights';
import ResidentChargesTable from '@/components/financials/ResidentChargesTable';
import ChargeDetailPanel from '@/components/financials/ChargeDetailPanel';

const TABS = [
  { id: 'overview', label: 'Overview', icon: PieChart },
  { id: 'resident_charges', label: 'Charges', icon: Users },
  { id: 'expenses', label: 'Expenses', icon: Receipt },
  { id: 'budget', label: 'Budget', icon: BarChart2 },
  { id: 'statements', label: 'Statements', icon: Landmark },
];

const CHARGE_TYPE_LABELS = { condo_fee: 'Condo Fee', lounge_rental: 'Lounge Rental', key_fob: 'Key / Fob', fine: 'Fine', rent: 'Rent', other: 'Other' };
const EXPENSE_CATEGORY_LABELS = { maintenance: 'Maintenance', repairs: 'Repairs', vendor: 'Vendor', utilities: 'Utilities', operating: 'Operating', other: 'Other' };
const BUDGET_CATEGORY_LABELS = { maintenance: 'Maintenance', utilities: 'Utilities', insurance: 'Insurance', administration: 'Administration', amenities: 'Amenities', reserves: 'Reserves', other: 'Other' };
const STATUS_COLORS = { unpaid: 'bg-amber-100 text-amber-700', paid: 'bg-emerald-100 text-emerald-700', overdue: 'bg-red-100 text-red-700', waived: 'bg-zinc-100 text-zinc-500', pending: 'bg-amber-100 text-amber-700', approved: 'bg-emerald-100 text-emerald-700' };

const fmtCurrency = n => `$${(n || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ─── Add Charge Modal ───
function AddChargeModal({ open, onClose, onSave }) {
  const [form, setForm] = useState({ resident_name: '', unit_number: '', tower: 'E', charge_type: 'condo_fee', description: '', amount: '', due_date: '', status: 'unpaid', notes: '' });
  const handleSubmit = () => {
    if (!form.amount || !form.resident_name) { toast.error('Resident name and amount are required'); return; }
    onSave({ ...form, amount: parseFloat(form.amount) });
    setForm({ resident_name: '', unit_number: '', tower: 'E', charge_type: 'condo_fee', description: '', amount: '', due_date: '', status: 'unpaid', notes: '' });
  };
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add Resident Charge</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-zinc-600">Resident Name *</label><Input value={form.resident_name} onChange={e => setForm({...form, resident_name: e.target.value})} className="mt-1" /></div>
            <div><label className="text-xs font-medium text-zinc-600">Unit #</label><Input value={form.unit_number} onChange={e => setForm({...form, unit_number: e.target.value})} className="mt-1" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-zinc-600">Charge Type</label>
              <Select value={form.charge_type} onValueChange={v => setForm({...form, charge_type: v})}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(CHARGE_TYPE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select></div>
            <div><label className="text-xs font-medium text-zinc-600">Amount ($) *</label><Input type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} className="mt-1" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-zinc-600">Due Date</label><Input type="date" value={form.due_date} onChange={e => setForm({...form, due_date: e.target.value})} className="mt-1" /></div>
            <div><label className="text-xs font-medium text-zinc-600">Status</label>
              <Select value={form.status} onValueChange={v => setForm({...form, status: v})}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unpaid">Unpaid</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                  <SelectItem value="overdue">Overdue</SelectItem>
                  <SelectItem value="waived">Waived</SelectItem>
                </SelectContent>
              </Select></div>
          </div>
          <div><label className="text-xs font-medium text-zinc-600">Description</label><Input value={form.description} onChange={e => setForm({...form, description: e.target.value})} className="mt-1" /></div>
          <div><label className="text-xs font-medium text-zinc-600">Notes</label><Input value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} className="mt-1" /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={handleSubmit}>Add Charge</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add Expense Modal ───
function AddExpenseModal({ open, onClose, onSave }) {
  const [form, setForm] = useState({ category: 'maintenance', description: '', vendor: '', amount: '', expense_date: format(new Date(), 'yyyy-MM-dd'), status: 'pending', notes: '' });
  const handleSubmit = () => {
    if (!form.amount || !form.expense_date) { toast.error('Amount and date are required'); return; }
    onSave({ ...form, amount: parseFloat(form.amount) });
    setForm({ category: 'maintenance', description: '', vendor: '', amount: '', expense_date: format(new Date(), 'yyyy-MM-dd'), status: 'pending', notes: '' });
  };
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add Expense</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-zinc-600">Category</label>
              <Select value={form.category} onValueChange={v => setForm({...form, category: v})}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(EXPENSE_CATEGORY_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select></div>
            <div><label className="text-xs font-medium text-zinc-600">Amount ($) *</label><Input type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} className="mt-1" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-zinc-600">Vendor</label><Input value={form.vendor} onChange={e => setForm({...form, vendor: e.target.value})} className="mt-1" /></div>
            <div><label className="text-xs font-medium text-zinc-600">Date *</label><Input type="date" value={form.expense_date} onChange={e => setForm({...form, expense_date: e.target.value})} className="mt-1" /></div>
          </div>
          <div><label className="text-xs font-medium text-zinc-600">Description</label><Input value={form.description} onChange={e => setForm({...form, description: e.target.value})} className="mt-1" /></div>
          <div><label className="text-xs font-medium text-zinc-600">Status</label>
            <Select value={form.status} onValueChange={v => setForm({...form, status: v})}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
              </SelectContent>
            </Select></div>
          <div><label className="text-xs font-medium text-zinc-600">Notes</label><Input value={form.notes} onChange={e => setForm({...form, notes: e.target.value})} className="mt-1" /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={handleSubmit}>Add Expense</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add Budget Item Modal ───
function AddBudgetItemModal({ open, onClose, onSave }) {
  const thisYear = new Date().getFullYear().toString();
  const thisMonth = format(new Date(), 'yyyy-MM');
  const [form, setForm] = useState({ fiscal_year: thisYear, month: thisMonth, category: 'maintenance', description: '', allocated_amount: '', spent_amount: '0', notes: '' });
  const handleSubmit = () => {
    if (!form.allocated_amount) { toast.error('Allocated amount is required'); return; }
    onSave({ ...form, allocated_amount: parseFloat(form.allocated_amount), spent_amount: parseFloat(form.spent_amount || 0) });
    setForm({ fiscal_year: thisYear, month: thisMonth, category: 'maintenance', description: '', allocated_amount: '', spent_amount: '0', notes: '' });
  };
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add Budget Item</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-zinc-600">Fiscal Year</label><Input value={form.fiscal_year} onChange={e => setForm({...form, fiscal_year: e.target.value})} className="mt-1" /></div>
            <div><label className="text-xs font-medium text-zinc-600">Month (yyyy-MM)</label><Input value={form.month} onChange={e => setForm({...form, month: e.target.value})} className="mt-1" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-medium text-zinc-600">Category</label>
              <Select value={form.category} onValueChange={v => setForm({...form, category: v})}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(BUDGET_CATEGORY_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
              </Select></div>
            <div><label className="text-xs font-medium text-zinc-600">Allocated ($) *</label><Input type="number" min="0" step="0.01" value={form.allocated_amount} onChange={e => setForm({...form, allocated_amount: e.target.value})} className="mt-1" /></div>
          </div>
          <div><label className="text-xs font-medium text-zinc-600">Spent ($)</label><Input type="number" min="0" step="0.01" value={form.spent_amount} onChange={e => setForm({...form, spent_amount: e.target.value})} className="mt-1" /></div>
          <div><label className="text-xs font-medium text-zinc-600">Description</label><Input value={form.description} onChange={e => setForm({...form, description: e.target.value})} className="mt-1" /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={handleSubmit}>Add Budget Item</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Financials() {
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [expenseFilter, setExpenseFilter] = useState('all');
  const [addChargeOpen, setAddChargeOpen] = useState(false);
  const [addExpenseOpen, setAddExpenseOpen] = useState(false);
  const [addBudgetOpen, setAddBudgetOpen] = useState(false);
  const [selectedCharge, setSelectedCharge] = useState(null);
  const queryClient = useQueryClient();

  useEffect(() => { base44.auth.me().then(u => setUser(u)); }, []);

  const { data: charges = [] } = useQuery({
    queryKey: ['resident-charges'],
    queryFn: () => base44.entities.ResidentCharge.list('-created_date', 200),
    staleTime: 0, refetchOnMount: 'always'
  });

  const { data: expenses = [] } = useQuery({
    queryKey: ['building-expenses'],
    queryFn: () => base44.entities.BuildingExpense.list('-expense_date', 200),
    staleTime: 0, refetchOnMount: 'always'
  });

  const { data: budgetItems = [] } = useQuery({
    queryKey: ['budget-items'],
    queryFn: () => base44.entities.BudgetItem.list('-month', 100),
    staleTime: 0, refetchOnMount: 'always'
  });

  const { data: bankStatements = [] } = useQuery({
    queryKey: ['bank-statements'],
    queryFn: () => base44.entities.BankStatement.list('-statement_month', 50),
    staleTime: 0, refetchOnMount: 'always'
  });

  const addChargeMutation = useMutation({
    mutationFn: data => base44.entities.ResidentCharge.create({ ...data, created_by_user_id: user?.id, created_by_name: user?.full_name }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['resident-charges'] }); toast.success('Charge added'); setAddChargeOpen(false); }
  });

  const updateChargeMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.ResidentCharge.update(id, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['resident-charges'] }); toast.success('Updated'); }
  });

  const addExpenseMutation = useMutation({
    mutationFn: data => base44.entities.BuildingExpense.create({ ...data, created_by_user_id: user?.id, created_by_name: user?.full_name }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['building-expenses'] }); toast.success('Expense added'); setAddExpenseOpen(false); }
  });

  const addBudgetMutation = useMutation({
    mutationFn: data => base44.entities.BudgetItem.create({ ...data, created_by_user_id: user?.id }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['budget-items'] }); toast.success('Budget item added'); setAddBudgetOpen(false); }
  });

  const handleMarkPaid = useCallback((chargeId) => {
    updateChargeMutation.mutate({ id: chargeId, data: { status: 'paid', payment_date: format(new Date(), 'yyyy-MM-dd') } });
  }, [updateChargeMutation]);

  // Export CSV
  const handleExportCSV = () => {
    const rows = [['Resident', 'Unit', 'Type', 'Amount', 'Status', 'Due Date', 'Notes']];
    charges.forEach(c => rows.push([c.resident_name, c.unit_number, c.charge_type, c.amount, c.status, c.due_date, c.notes]));
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'charges.csv'; a.click();
    URL.revokeObjectURL(url);
    toast.success('CSV exported');
  };

  // Metrics
  const thisMonth = format(new Date(), 'yyyy-MM');
  const totalReceivables = charges.filter(c => c.status === 'unpaid' || c.status === 'overdue').reduce((s, c) => s + (c.amount || 0), 0);
  const totalPaid = charges.filter(c => c.status === 'paid').reduce((s, c) => s + (c.amount || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const overdueCount = charges.filter(c => c.status === 'overdue').length;
  const monthlyExpenses = expenses.filter(e => e.expense_date?.startsWith(thisMonth)).reduce((s, e) => s + (e.amount || 0), 0);
  const totalBudgetAllocated = budgetItems.filter(b => b.month === thisMonth).reduce((s, b) => s + (b.allocated_amount || 0), 0);
  const totalBudgetSpent = budgetItems.filter(b => b.month === thisMonth).reduce((s, b) => s + (b.spent_amount || 0), 0);
  const condoFeesCollected = charges.filter(c => c.charge_type === 'condo_fee' && c.status === 'paid').reduce((s, c) => s + (c.amount || 0), 0);

  const filteredExpenses = expenses.filter(e => expenseFilter === 'all' || e.category === expenseFilter || e.status === expenseFilter);

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}
        className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900">Financials</h1>
          <p className="text-zinc-400 mt-1 text-sm">Building finance · Resident charges · Accounting</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleExportCSV} className="h-9 gap-1.5">
            <Download className="w-4 h-4" /> Export CSV
          </Button>
          <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => {
            ['resident-charges','building-expenses','budget-items','bank-statements'].forEach(k => queryClient.invalidateQueries({ queryKey: [k] }));
          }}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </motion.div>

      {/* Tab Navigation */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}
        className="flex gap-1 bg-zinc-100/80 rounded-2xl p-1 overflow-x-auto backdrop-blur-sm">
        {TABS.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`relative flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all duration-200
                ${isActive ? 'text-zinc-900' : 'text-zinc-500 hover:text-zinc-700'}`}>
              {isActive && (
                <motion.div layoutId="activefinancetab"
                  className="absolute inset-0 bg-white rounded-xl shadow-sm"
                  transition={{ type: 'spring', damping: 24, stiffness: 300 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-1.5">
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </span>
            </button>
          );
        })}
      </motion.div>

      {/* Tab Content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, y: -8, filter: 'blur(4px)' }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        >

          {/* ── OVERVIEW ── */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Metric Cards */}
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                <AnimatedMetricCard title="Total Receivables" rawValue={totalReceivables} value={fmtCurrency(totalReceivables)} sub={overdueCount > 0 ? `${overdueCount} overdue` : 'All current'} icon={TrendingUp} color="text-amber-600" bgColor="bg-amber-50" delay={0} />
                <AnimatedMetricCard title="Collected (All Time)" rawValue={totalPaid} value={fmtCurrency(totalPaid)} icon={CheckCircle2} color="text-emerald-600" bgColor="bg-emerald-50" delay={0.06} />
                <AnimatedMetricCard title="Total Expenses" rawValue={totalExpenses} value={fmtCurrency(totalExpenses)} icon={TrendingDown} color="text-red-500" bgColor="bg-red-50" delay={0.12} />
                <AnimatedMetricCard title="Expenses This Month" rawValue={monthlyExpenses} value={fmtCurrency(monthlyExpenses)} icon={Receipt} color="text-orange-600" bgColor="bg-orange-50" delay={0.18} />
                <AnimatedMetricCard title="Monthly Budget" rawValue={totalBudgetAllocated} value={fmtCurrency(totalBudgetAllocated)} sub={`${fmtCurrency(totalBudgetSpent)} spent`} icon={BarChart2} color="text-indigo-600" bgColor="bg-indigo-50" delay={0.24} />
                <AnimatedMetricCard title="Condo Fees Collected" rawValue={condoFeesCollected} value={fmtCurrency(condoFeesCollected)} icon={DollarSign} color="text-teal-600" bgColor="bg-teal-50" delay={0.3} />
              </div>

              {/* Overdue Alerts */}
              <OverdueAlerts charges={charges} onSelectCharge={(c) => { setSelectedCharge(c); setActiveTab('resident_charges'); }} />

              {/* Insights */}
              <FinancialInsights charges={charges} expenses={expenses} budgetItems={budgetItems} />

              {/* Charts */}
              <FinancialCharts charges={charges} expenses={expenses} />

              {/* Recent Activity */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}
                  className="bg-white rounded-2xl border border-zinc-100 shadow-sm p-5">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-bold text-zinc-800">Recent Charges</p>
                    <button onClick={() => setActiveTab('resident_charges')} className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">View all →</button>
                  </div>
                  <div className="space-y-3">
                    {charges.slice(0, 5).map(c => (
                      <div key={c.id} onClick={() => setSelectedCharge(c)}
                        className="flex items-center justify-between cursor-pointer hover:bg-zinc-50 rounded-xl px-2 py-1.5 transition-colors">
                        <div>
                          <p className="text-xs font-semibold text-zinc-800">{c.resident_name} {c.unit_number ? `· ${c.unit_number}` : ''}</p>
                          <p className="text-[11px] text-zinc-400">{CHARGE_TYPE_LABELS[c.charge_type] || c.charge_type}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs font-bold text-zinc-800">{fmtCurrency(c.amount)}</p>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${STATUS_COLORS[c.status]}`}>{c.status}</span>
                        </div>
                      </div>
                    ))}
                    {charges.length === 0 && <p className="text-xs text-zinc-400 text-center py-4">No charges yet</p>}
                  </div>
                </motion.div>

                <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
                  className="bg-white rounded-2xl border border-zinc-100 shadow-sm p-5">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-bold text-zinc-800">Recent Expenses</p>
                    <button onClick={() => setActiveTab('expenses')} className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">View all →</button>
                  </div>
                  <div className="space-y-3">
                    {expenses.slice(0, 5).map(e => (
                      <div key={e.id} className="flex items-center justify-between px-2 py-1.5">
                        <div>
                          <p className="text-xs font-semibold text-zinc-800">{e.description || EXPENSE_CATEGORY_LABELS[e.category]}</p>
                          <p className="text-[11px] text-zinc-400">{e.vendor ? `${e.vendor} · ` : ''}{e.expense_date}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs font-bold text-zinc-800">{fmtCurrency(e.amount)}</p>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${STATUS_COLORS[e.status]}`}>{e.status}</span>
                        </div>
                      </div>
                    ))}
                    {expenses.length === 0 && <p className="text-xs text-zinc-400 text-center py-4">No expenses yet</p>}
                  </div>
                </motion.div>
              </div>
            </div>
          )}

          {/* ── RESIDENT CHARGES ── */}
          {activeTab === 'resident_charges' && (
            <div className="space-y-4">
              <OverdueAlerts charges={charges} onSelectCharge={setSelectedCharge} />
              <ResidentChargesTable
                charges={charges}
                onSelectCharge={setSelectedCharge}
                onMarkPaid={handleMarkPaid}
                onAddCharge={() => setAddChargeOpen(true)}
              />
            </div>
          )}

          {/* ── EXPENSES ── */}
          {activeTab === 'expenses' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex gap-1 flex-wrap">
                  {['all', ...Object.keys(EXPENSE_CATEGORY_LABELS)].map(f => (
                    <button key={f} onClick={() => setExpenseFilter(f)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all
                        ${expenseFilter === f ? 'bg-zinc-900 text-white shadow-sm' : 'bg-white text-zinc-500 border border-zinc-200 hover:border-zinc-300'}`}>
                      {f === 'all' ? 'All' : EXPENSE_CATEGORY_LABELS[f] || f}
                    </button>
                  ))}
                </div>
                <Button size="sm" onClick={() => setAddExpenseOpen(true)} className="h-9">
                  <Plus className="w-4 h-4 mr-1.5" /> Add Expense
                </Button>
              </div>

              <div className="bg-white rounded-2xl border border-zinc-100 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-50/80 border-b border-zinc-100">
                      <tr>
                        {['Date', 'Category', 'Description', 'Vendor', 'Amount', 'Status'].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-50">
                      <AnimatePresence>
                        {filteredExpenses.length === 0 ? (
                          <tr key="empty"><td colSpan={6} className="px-4 py-10 text-center text-zinc-400 text-sm">No expenses found</td></tr>
                        ) : filteredExpenses.map((e, idx) => (
                          <motion.tr key={e.id} layout
                            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.15, delay: Math.min(idx * 0.02, 0.2) }}
                            className="hover:bg-zinc-50/70 transition-colors">
                            <td className="px-4 py-3 text-xs text-zinc-500">{e.expense_date || '—'}</td>
                            <td className="px-4 py-3"><Badge className="text-xs bg-zinc-100 text-zinc-700">{EXPENSE_CATEGORY_LABELS[e.category] || e.category}</Badge></td>
                            <td className="px-4 py-3 text-zinc-700">{e.description || '—'}</td>
                            <td className="px-4 py-3 text-zinc-500 text-xs">{e.vendor || '—'}</td>
                            <td className="px-4 py-3 font-bold text-zinc-800">{fmtCurrency(e.amount)}</td>
                            <td className="px-4 py-3"><span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${STATUS_COLORS[e.status]}`}>{e.status}</span></td>
                          </motion.tr>
                        ))}
                      </AnimatePresence>
                    </tbody>
                  </table>
                </div>
                {filteredExpenses.length > 0 && (
                  <div className="px-4 py-3 border-t border-zinc-50 flex justify-between items-center">
                    <span className="text-xs text-zinc-400">{filteredExpenses.length} records</span>
                    <span className="text-sm font-bold text-zinc-700">Total: {fmtCurrency(filteredExpenses.reduce((s, e) => s + (e.amount || 0), 0))}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── BUDGET ── */}
          {activeTab === 'budget' && (
            <div className="space-y-5">
              <div className="flex justify-end">
                <Button size="sm" onClick={() => setAddBudgetOpen(true)} className="h-9">
                  <Plus className="w-4 h-4 mr-1.5" /> Add Budget Item
                </Button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {Object.entries(BUDGET_CATEGORY_LABELS).map(([cat, label], idx) => {
                  const items = budgetItems.filter(b => b.category === cat && b.month === thisMonth);
                  if (items.length === 0) return null;
                  const allocated = items.reduce((s, b) => s + (b.allocated_amount || 0), 0);
                  const spent = items.reduce((s, b) => s + (b.spent_amount || 0), 0);
                  const pct = allocated > 0 ? Math.min(100, Math.round((spent / allocated) * 100)) : 0;
                  return (
                    <motion.div key={cat} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.3, delay: idx * 0.06 }}
                      className="bg-white rounded-2xl border border-zinc-100 shadow-sm p-5">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-sm font-bold text-zinc-800">{label}</span>
                        <span className={`text-xs font-bold ${pct >= 90 ? 'text-red-600' : pct >= 70 ? 'text-amber-600' : 'text-emerald-600'}`}>{pct}%</span>
                      </div>
                      <div className="w-full bg-zinc-100 rounded-full h-2 mb-3 overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${pct}%` }}
                          transition={{ duration: 0.8, delay: 0.2 + idx * 0.06, ease: 'easeOut' }}
                          className={`h-2 rounded-full ${pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-400' : 'bg-emerald-500'}`}
                        />
                      </div>
                      <div className="flex justify-between text-xs text-zinc-500">
                        <span>{fmtCurrency(spent)} spent</span>
                        <span>{fmtCurrency(allocated)} allocated</span>
                      </div>
                    </motion.div>
                  );
                })}
              </div>

              <div className="bg-white rounded-2xl border border-zinc-100 shadow-sm overflow-hidden">
                <div className="px-5 py-4 border-b border-zinc-50">
                  <p className="text-sm font-bold text-zinc-800">All Budget Items</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-50/80 border-b border-zinc-100">
                      <tr>
                        {['Year', 'Month', 'Category', 'Description', 'Allocated', 'Spent', 'Remaining'].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-zinc-500 uppercase tracking-wide">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-50">
                      {budgetItems.length === 0
                        ? <tr><td colSpan={7} className="px-4 py-10 text-center text-zinc-400 text-sm">No budget items yet</td></tr>
                        : budgetItems.map((b, idx) => {
                          const remaining = (b.allocated_amount || 0) - (b.spent_amount || 0);
                          return (
                            <motion.tr key={b.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                              transition={{ duration: 0.15, delay: Math.min(idx * 0.02, 0.2) }}
                              className="hover:bg-zinc-50/70 transition-colors">
                              <td className="px-4 py-3 text-xs text-zinc-500">{b.fiscal_year}</td>
                              <td className="px-4 py-3 text-xs text-zinc-500">{b.month || '—'}</td>
                              <td className="px-4 py-3"><Badge className="text-xs bg-indigo-100 text-indigo-700">{BUDGET_CATEGORY_LABELS[b.category] || b.category}</Badge></td>
                              <td className="px-4 py-3 text-zinc-700">{b.description || '—'}</td>
                              <td className="px-4 py-3 font-bold text-zinc-800">{fmtCurrency(b.allocated_amount)}</td>
                              <td className="px-4 py-3 text-zinc-600">{fmtCurrency(b.spent_amount)}</td>
                              <td className={`px-4 py-3 font-bold ${remaining < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{fmtCurrency(remaining)}</td>
                            </motion.tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ── STATEMENTS ── */}
          {activeTab === 'statements' && (
            <div className="space-y-4">
              {bankStatements.length === 0 ? (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  className="bg-white rounded-2xl border border-dashed border-zinc-200 p-12 text-center">
                  <Landmark className="w-12 h-12 mx-auto mb-3 text-zinc-200" />
                  <p className="text-zinc-500 font-semibold">No bank statements yet</p>
                  <p className="text-xs text-zinc-400 mt-1">Statements can be uploaded and tracked here.</p>
                </motion.div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {bankStatements.map((s, idx) => (
                    <motion.div key={s.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3, delay: idx * 0.06 }}
                      className="bg-white rounded-2xl border border-zinc-100 shadow-sm p-5 hover:shadow-md transition-shadow">
                      <div className="flex items-start justify-between mb-4">
                        <div>
                          <p className="font-bold text-sm text-zinc-900">{s.account_name}</p>
                          <p className="text-xs text-zinc-400">{s.statement_month}</p>
                        </div>
                        <div className="w-9 h-9 bg-indigo-50 rounded-xl flex items-center justify-center">
                          <Landmark className="w-4 h-4 text-indigo-600" />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3 text-xs">
                        {s.opening_balance != null && <div><span className="text-zinc-400">Opening</span><p className="font-bold text-zinc-800 mt-0.5">{fmtCurrency(s.opening_balance)}</p></div>}
                        {s.closing_balance != null && <div><span className="text-zinc-400">Closing</span><p className="font-bold text-zinc-800 mt-0.5">{fmtCurrency(s.closing_balance)}</p></div>}
                        {s.total_deposits != null && <div><span className="text-zinc-400">Deposits</span><p className="font-bold text-emerald-600 mt-0.5">{fmtCurrency(s.total_deposits)}</p></div>}
                        {s.total_withdrawals != null && <div><span className="text-zinc-400">Withdrawals</span><p className="font-bold text-red-500 mt-0.5">{fmtCurrency(s.total_withdrawals)}</p></div>}
                      </div>
                      {s.document_url && (
                        <a href={s.document_url} target="_blank" rel="noreferrer"
                          className="mt-4 flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 font-medium transition-colors">
                          <FileText className="w-3.5 h-3.5" /> {s.document_name || 'View Statement'}
                        </a>
                      )}
                      {s.notes && <p className="mt-2 text-xs text-zinc-400">{s.notes}</p>}
                    </motion.div>
                  ))}
                </div>
              )}
            </div>
          )}

        </motion.div>
      </AnimatePresence>

      {/* Modals */}
      <AddChargeModal open={addChargeOpen} onClose={() => setAddChargeOpen(false)} onSave={data => addChargeMutation.mutate(data)} />
      <AddExpenseModal open={addExpenseOpen} onClose={() => setAddExpenseOpen(false)} onSave={data => addExpenseMutation.mutate(data)} />
      <AddBudgetItemModal open={addBudgetOpen} onClose={() => setAddBudgetOpen(false)} onSave={data => addBudgetMutation.mutate(data)} />

      {/* Slide-in Charge Detail Panel */}
      {selectedCharge && (
        <ChargeDetailPanel
          charge={selectedCharge}
          relatedCharges={charges}
          onClose={() => setSelectedCharge(null)}
          onMarkPaid={handleMarkPaid}
        />
      )}
    </div>
  );
}
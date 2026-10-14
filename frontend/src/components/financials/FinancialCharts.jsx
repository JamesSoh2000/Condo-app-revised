import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { format, subMonths, startOfMonth } from 'date-fns';

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-zinc-200 rounded-xl shadow-lg px-4 py-3 text-xs">
      {label && <p className="font-semibold text-zinc-700 mb-1">{label}</p>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: p.color }} />
          <span className="text-zinc-500">{p.name}:</span>
          <span className="font-bold text-zinc-800">
            {typeof p.value === 'number' ? `$${p.value.toLocaleString('en-CA', { minimumFractionDigits: 0 })}` : p.value}
          </span>
        </div>
      ))}
    </div>
  );
};

export default function FinancialCharts({ charges, expenses }) {
  // Build last 6 months data
  const monthlyData = useMemo(() => {
    const months = Array.from({ length: 6 }, (_, i) => {
      const d = subMonths(new Date(), 5 - i);
      return { key: format(startOfMonth(d), 'yyyy-MM'), label: format(d, 'MMM') };
    });

    return months.map(({ key, label }) => {
      const receivables = charges
        .filter(c => (c.status === 'unpaid' || c.status === 'overdue') && c.created_date?.startsWith(key))
        .reduce((s, c) => s + (c.amount || 0), 0);
      const collected = charges
        .filter(c => c.status === 'paid' && (c.payment_date?.startsWith(key) || c.created_date?.startsWith(key)))
        .reduce((s, c) => s + (c.amount || 0), 0);
      const expTotal = expenses
        .filter(e => e.expense_date?.startsWith(key))
        .reduce((s, e) => s + (e.amount || 0), 0);
      return { label, receivables, collected, expenses: expTotal };
    });
  }, [charges, expenses]);

  // Expense breakdown by category
  const expenseByCategory = useMemo(() => {
    const map = {};
    expenses.forEach(e => {
      const cat = e.category || 'other';
      map[cat] = (map[cat] || 0) + (e.amount || 0);
    });
    return Object.entries(map).map(([name, value]) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1).replace('_', ' '),
      value: Math.round(value * 100) / 100
    })).filter(d => d.value > 0);
  }, [expenses]);

  // Charge type breakdown
  const chargeByType = useMemo(() => {
    const map = {};
    charges.forEach(c => {
      const type = c.charge_type || 'other';
      if (c.status !== 'waived') map[type] = (map[type] || 0) + (c.amount || 0);
    });
    const labels = { condo_fee: 'Condo Fee', lounge_rental: 'Lounge', key_fob: 'Key/Fob', fine: 'Fine', rent: 'Rent', other: 'Other' };
    return Object.entries(map).map(([k, v]) => ({ name: labels[k] || k, value: Math.round(v * 100) / 100 })).filter(d => d.value > 0);
  }, [charges]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Receivables vs Collected (Bar) */}
      <motion.div
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="bg-white rounded-2xl border border-zinc-100 shadow-sm p-5"
      >
        <p className="text-sm font-semibold text-zinc-800 mb-1">Receivables vs Collected</p>
        <p className="text-xs text-zinc-400 mb-4">Last 6 months</p>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={monthlyData} barCategoryGap="30%">
            <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#a1a1aa' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: '#a1a1aa' }} axisLine={false} tickLine={false} tickFormatter={v => `$${v >= 1000 ? `${(v/1000).toFixed(0)}k` : v}`} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="receivables" name="Receivables" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            <Bar dataKey="collected" name="Collected" fill="#10b981" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </motion.div>

      {/* Monthly Expenses Line */}
      <motion.div
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="bg-white rounded-2xl border border-zinc-100 shadow-sm p-5"
      >
        <p className="text-sm font-semibold text-zinc-800 mb-1">Monthly Expenses</p>
        <p className="text-xs text-zinc-400 mb-4">Trend over 6 months</p>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={monthlyData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#a1a1aa' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: '#a1a1aa' }} axisLine={false} tickLine={false} tickFormatter={v => `$${v >= 1000 ? `${(v/1000).toFixed(0)}k` : v}`} />
            <Tooltip content={<CustomTooltip />} />
            <Line type="monotone" dataKey="expenses" name="Expenses" stroke="#ef4444" strokeWidth={2.5} dot={{ r: 4, fill: '#ef4444' }} activeDot={{ r: 6 }} />
          </LineChart>
        </ResponsiveContainer>
      </motion.div>

      {/* Expense Donut */}
      <motion.div
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.3 }}
        className="bg-white rounded-2xl border border-zinc-100 shadow-sm p-5"
      >
        <p className="text-sm font-semibold text-zinc-800 mb-1">Expense Breakdown</p>
        <p className="text-xs text-zinc-400 mb-4">By category (all time)</p>
        {expenseByCategory.length === 0 ? (
          <div className="h-[200px] flex items-center justify-center text-zinc-300 text-sm">No expense data</div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={expenseByCategory} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value">
                {expenseByCategory.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </motion.div>

      {/* Revenue Sources Pie */}
      <motion.div
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.4 }}
        className="bg-white rounded-2xl border border-zinc-100 shadow-sm p-5"
      >
        <p className="text-sm font-semibold text-zinc-800 mb-1">Revenue by Charge Type</p>
        <p className="text-xs text-zinc-400 mb-4">All charges</p>
        {chargeByType.length === 0 ? (
          <div className="h-[200px] flex items-center justify-center text-zinc-300 text-sm">No charge data</div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={chargeByType} cx="50%" cy="50%" outerRadius={80} paddingAngle={3} dataKey="value">
                {chargeByType.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </motion.div>
    </div>
  );
}
import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Lightbulb, TrendingUp, TrendingDown, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { format, subMonths } from 'date-fns';

export default function FinancialInsights({ charges, expenses, budgetItems }) {
  const insights = useMemo(() => {
    const list = [];
    const now = new Date();
    const thisMonth = format(now, 'yyyy-MM');
    const lastMonth = format(subMonths(now, 1), 'yyyy-MM');

    // Overdue check
    const overdueCharges = charges.filter(c => c.status === 'overdue');
    const overdueOver30 = overdueCharges.filter(c => {
      if (!c.due_date) return false;
      const dueD = new Date(c.due_date);
      return (now - dueD) / (1000 * 60 * 60 * 24) > 30;
    });
    if (overdueOver30.length > 0) {
      list.push({
        icon: AlertTriangle, color: 'text-red-600', bg: 'bg-red-50',
        text: `${overdueOver30.length} resident${overdueOver30.length > 1 ? 's are' : ' is'} overdue by more than 30 days`
      });
    }

    // Expense vs budget
    const thisMonthBudget = budgetItems.filter(b => b.month === thisMonth).reduce((s, b) => s + (b.allocated_amount || 0), 0);
    const thisMonthExpenses = expenses.filter(e => e.expense_date?.startsWith(thisMonth)).reduce((s, e) => s + (e.amount || 0), 0);
    if (thisMonthBudget > 0 && thisMonthExpenses > thisMonthBudget) {
      list.push({
        icon: TrendingDown, color: 'text-amber-600', bg: 'bg-amber-50',
        text: `Expenses exceeded monthly budget by $${(thisMonthExpenses - thisMonthBudget).toFixed(2)}`
      });
    }

    // Month-over-month expenses
    const lastMonthExpenses = expenses.filter(e => e.expense_date?.startsWith(lastMonth)).reduce((s, e) => s + (e.amount || 0), 0);
    if (lastMonthExpenses > 0 && thisMonthExpenses > 0) {
      const pct = Math.round(((thisMonthExpenses - lastMonthExpenses) / lastMonthExpenses) * 100);
      if (Math.abs(pct) >= 10) {
        list.push({
          icon: pct > 0 ? TrendingUp : TrendingDown,
          color: pct > 0 ? 'text-orange-600' : 'text-emerald-600',
          bg: pct > 0 ? 'bg-orange-50' : 'bg-emerald-50',
          text: `Expenses ${pct > 0 ? 'increased' : 'decreased'} by ${Math.abs(pct)}% compared to last month`
        });
      }
    }

    // Collection rate
    const totalCharged = charges.reduce((s, c) => s + (c.amount || 0), 0);
    const totalCollected = charges.filter(c => c.status === 'paid').reduce((s, c) => s + (c.amount || 0), 0);
    if (totalCharged > 0) {
      const rate = Math.round((totalCollected / totalCharged) * 100);
      if (rate >= 80) {
        list.push({ icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-50', text: `Strong collection rate: ${rate}% of all charges collected` });
      } else if (rate < 60) {
        list.push({ icon: TrendingDown, color: 'text-red-600', bg: 'bg-red-50', text: `Low collection rate: only ${rate}% of charges collected` });
      }
    }

    // Maintenance budget exceeded
    const maintenanceBudget = budgetItems.filter(b => b.category === 'maintenance').reduce((s, b) => s + (b.allocated_amount || 0), 0);
    const maintenanceExpenses = expenses.filter(e => e.category === 'maintenance').reduce((s, e) => s + (e.amount || 0), 0);
    if (maintenanceBudget > 0 && maintenanceExpenses > maintenanceBudget) {
      list.push({ icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-50', text: `Expenses exceeded budget in Maintenance category` });
    }

    if (list.length === 0) {
      list.push({ icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-50', text: 'All financial metrics are on track — great work!' });
    }

    return list;
  }, [charges, expenses, budgetItems]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: 0.15 }}
      className="bg-white rounded-2xl border border-zinc-100 shadow-sm p-5"
    >
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
          <Lightbulb className="w-4 h-4 text-indigo-600" />
        </div>
        <div>
          <p className="text-sm font-bold text-zinc-800">AI Insights</p>
          <p className="text-xs text-zinc-400">Auto-generated financial summary</p>
        </div>
      </div>
      <div className="space-y-2.5">
        {insights.map((ins, i) => {
          const Ic = ins.icon;
          return (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 + i * 0.07 }}
              className={`flex items-start gap-3 rounded-xl px-3 py-2.5 ${ins.bg}`}
            >
              <Ic className={`w-4 h-4 mt-0.5 flex-shrink-0 ${ins.color}`} />
              <p className={`text-xs font-medium ${ins.color}`}>{ins.text}</p>
            </motion.div>
          );
        })}
      </div>
    </motion.div>
  );
}

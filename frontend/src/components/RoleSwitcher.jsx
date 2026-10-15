import React from 'react';
import { motion } from 'framer-motion';
import { Home, Shield, Building2, DollarSign } from 'lucide-react';
import { isDemoViewRole } from '@/app/routeScope';

const ALL_ROLES = [
  { value: 'resident',             label: 'Resident', icon: Home,         access: ['board', 'property_management'] },
  { value: 'security',             label: 'Security', icon: Shield,        access: ['board', 'property_management'] },
  { value: 'property_management',  label: 'Mgmt',     icon: Building2,     access: ['board', 'property_management'] },
  { value: 'financials',           label: 'Finance',  icon: DollarSign,    access: ['board', 'property_management'] },
];

export default function RoleSwitcher({ activeRole, onRoleChange, userRole }) {
  // Filter roles based on the user's actual role
  // Views of pages outside the demo scope (Finance) are not offered (src/app/routeScope.ts).
  const roles = ALL_ROLES.filter(r => (!userRole || r.access.includes(userRole)) && isDemoViewRole(r.value));

  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="rounded-2xl bg-gradient-to-br from-zinc-900 to-zinc-800 border border-zinc-700/60 p-3 mb-4 shadow-xl shadow-black/20"
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <div className="w-6 h-6 rounded-md bg-amber-400/20 flex items-center justify-center flex-shrink-0">
          <span className="text-amber-400 text-[11px] leading-none">✦</span>
        </div>
        <div>
          <p className="text-[10px] font-bold text-amber-400 uppercase tracking-widest leading-none">
            Board Admin
          </p>
          <p className="text-[10px] text-zinc-500 mt-0.5 leading-none">
            Switch dashboard mode
          </p>
        </div>
      </div>

      {/* Segmented control — 2-col grid so 4 items never overflow */}
      <div className="grid grid-cols-2 gap-1 bg-zinc-800/80 rounded-xl p-1">
        {roles.map((role) => {
          const isActive = activeRole === role.value;
          const Icon = role.icon;
          return (
            <motion.button
              key={role.value}
              onClick={() => onRoleChange(role.value)}
              whileHover={!isActive ? { scale: 1.04, backgroundColor: 'rgba(255,255,255,0.06)' } : {}}
              whileTap={{ scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 400, damping: 22 }}
              className="relative flex-1 flex flex-col items-center gap-1 py-2 px-1 rounded-lg cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-amber-400"
            >
              {/* Gliding pill */}
              {isActive && (
                <motion.div
                  layoutId="rolePill"
                  className="absolute inset-0 bg-white rounded-lg shadow-lg"
                  transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                />
              )}

              <Icon
                className={`w-3.5 h-3.5 relative z-10 transition-colors duration-150 ${
                  isActive ? 'text-zinc-900' : 'text-zinc-400'
                }`}
              />
              <span
                className={`text-[10px] font-semibold relative z-10 transition-colors duration-150 leading-none ${
                  isActive ? 'text-zinc-900' : 'text-zinc-400'
                }`}
              >
                {role.label}
              </span>
            </motion.button>
          );
        })}
      </div>
    </motion.div>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';

function useCountUp(target, duration = 1200) {
  const [value, setValue] = useState(0);
  const frameRef = useRef(null);

  useEffect(() => {
    if (target === 0) { setValue(0); return; }
    const start = performance.now();
    const animate = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // easeOutExpo
      const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      setValue(eased * target);
      if (progress < 1) frameRef.current = requestAnimationFrame(animate);
    };
    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, [target, duration]);

  return value;
}

export default function AnimatedMetricCard({ title, value, rawValue = 0, sub, icon: Icon, color, bgColor, trend, delay = 0, onClick }) {
  const animated = useCountUp(rawValue);
  const formatted = rawValue > 0
    ? `$${animated.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : value;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ scale: 1.025, y: -2 }}
      className={`bg-white rounded-2xl border border-zinc-100 shadow-sm p-5 cursor-default transition-shadow hover:shadow-md ${onClick ? 'cursor-pointer' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-widest truncate">{title}</p>
          <p className={`text-2xl font-bold mt-1.5 tabular-nums ${color || 'text-zinc-900'}`}>
            {rawValue > 0 ? formatted : value}
          </p>
          {sub && <p className="text-xs text-zinc-400 mt-0.5">{sub}</p>}
        </div>
        <div className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 ml-3 ${bgColor || 'bg-zinc-50'}`}>
          <Icon className={`w-5 h-5 ${color || 'text-zinc-500'}`} />
        </div>
      </div>
      {trend !== undefined && (
        <div className={`flex items-center gap-1 mt-3 text-xs font-semibold ${trend >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
          {trend >= 0
            ? <ArrowUpRight className="w-3.5 h-3.5" />
            : <ArrowDownRight className="w-3.5 h-3.5" />}
          {Math.abs(trend)}% vs last month
        </div>
      )}
    </motion.div>
  );
}
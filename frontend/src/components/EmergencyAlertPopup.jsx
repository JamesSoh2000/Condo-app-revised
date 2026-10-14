import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { format } from 'date-fns';
import { X } from 'lucide-react';

// Queue manager: one popup at a time, queue the rest
export default function EmergencyAlertPopup({ alerts, onDismiss }) {
  const [current, setCurrent] = useState(null);
  const [queue, setQueue] = useState([]);

  useEffect(() => {
    const validIds = new Set((alerts || []).map(a => a.id));

    // Purge current if it's no longer valid
    setCurrent(prev => (prev && !validIds.has(prev.id) ? null : prev));

    // Sync queue: remove invalid items, add new ones
    setQueue(prev => {
      const filtered = prev.filter(a => validIds.has(a.id));
      const existingIds = new Set(filtered.map(a => a.id));
      const newAlerts = (alerts || []).filter(a => !existingIds.has(a.id));
      return [...filtered, ...newAlerts];
    });
  }, [alerts]);

  // Show next from queue when current is dismissed
  useEffect(() => {
    if (!current && queue.length > 0) {
      const [next, ...rest] = queue;
      setCurrent(next);
      setQueue(rest);
    }
  }, [current, queue]);

  const handleDismiss = () => {
    if (current) onDismiss(current.id);
    setCurrent(null);
  };

  const remainingCount = queue.length;

  return (
    <AnimatePresence>
      {current && (
        <motion.div
          key={current.id}
          initial={{ opacity: 0, scale: 0.85, y: 40 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: -20 }}
          transition={{ type: 'spring', stiffness: 420, damping: 30 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          style={{ backdropFilter: 'blur(6px)', background: 'rgba(0,0,0,0.65)' }}
        >
          {/* Pulsing outer ring */}
          <motion.div
            animate={{ scale: [1, 1.04, 1] }}
            transition={{ repeat: Infinity, duration: 1.6, ease: 'easeInOut' }}
            className="absolute w-[340px] sm:w-[440px] h-auto rounded-2xl border-2 border-red-500 opacity-40 pointer-events-none"
            style={{ minHeight: 200 }}
          />

          <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden border-2 border-red-500">
            {/* Red header strip */}
            <div className="bg-red-600 px-5 pt-5 pb-4 flex flex-col items-center gap-2">
              {/* Animated siren emoji */}
              <picture>
                <source srcSet="https://fonts.gstatic.com/s/e/notoemoji/latest/1f6a8/512.webp" type="image/webp" />
                <img
                  src="https://fonts.gstatic.com/s/e/notoemoji/latest/1f6a8/512.gif"
                  alt="🚨"
                  className="w-16 h-16"
                />
              </picture>
              <h2 className="text-white font-black text-xl tracking-widest uppercase">Emergency Alert</h2>
            </div>

            {/* Content */}
            <div className="px-6 pt-4 pb-2 space-y-2">
              <h3 className="text-zinc-900 font-bold text-lg leading-snug">{current.title}</h3>
              <p className="text-zinc-600 text-sm leading-relaxed">{current.message}</p>

              <div className="flex items-center gap-3 text-xs text-zinc-400 pt-1">
                {current.postedByName && (
                  <span className="font-medium text-zinc-500">
                    {current.postedByRole
                      ? current.postedByRole.charAt(0).toUpperCase() + current.postedByRole.slice(1)
                      : 'Management'}
                  </span>
                )}
                <span>·</span>
                <span>{format(new Date(current.created_date), 'MMM d, h:mm a')}</span>
              </div>
            </div>

            {/* More in queue */}
            {remainingCount > 0 && (
              <div className="mx-6 mt-2 px-3 py-1.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 font-medium">
                +{remainingCount} more emergency alert{remainingCount > 1 ? 's' : ''} waiting
              </div>
            )}

            {/* Actions */}
            <div className="px-6 py-4 flex justify-center">
              <Button
                variant="outline"
                className="w-48 border-zinc-300 font-semibold"
                onClick={handleDismiss}
              >
                Dismiss
              </Button>
            </div>

            {/* Dismiss X */}
            <button
              onClick={handleDismiss}
              className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-full bg-white/20 hover:bg-white/40 text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
import React, { useState, useRef, useCallback } from 'react';
import { motion, useMotionValue, useTransform } from 'framer-motion';
import { RefreshCw } from 'lucide-react';

const THRESHOLD = 72;
const MAX_PULL = 100;

export default function PullToRefresh({ onRefresh, children }) {
  const [refreshing, setRefreshing] = useState(false);
  const [released, setReleased] = useState(false);
  const startY = useRef(null);
  const pullY = useMotionValue(0);
  const opacity = useTransform(pullY, [0, THRESHOLD], [0, 1]);
  const rotate = useTransform(pullY, [0, MAX_PULL], [0, 360]);
  const scale = useTransform(pullY, [0, THRESHOLD], [0.5, 1]);

  const handleTouchStart = useCallback((e) => {
    // Only allow pull if already at top of scroll container
    if (window.scrollY > 0) return;
    startY.current = e.touches[0].clientY;
    setReleased(false);
  }, []);

  const handleTouchMove = useCallback((e) => {
    if (startY.current === null || refreshing) return;
    const delta = e.touches[0].clientY - startY.current;
    if (delta < 0) { pullY.set(0); return; }
    pullY.set(Math.min(delta * 0.5, MAX_PULL));
  }, [refreshing, pullY]);

  const handleTouchEnd = useCallback(async () => {
    if (startY.current === null) return;
    startY.current = null;
    const current = pullY.get();
    if (current >= THRESHOLD && !refreshing) {
      setReleased(true);
      setRefreshing(true);
      pullY.set(52);
      try { await onRefresh(); } finally {
        setRefreshing(false);
        setReleased(false);
        pullY.set(0);
      }
    } else {
      pullY.set(0);
    }
  }, [pullY, refreshing, onRefresh]);

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className="relative"
    >
      {/* Pull indicator */}
      <motion.div
        style={{ height: pullY, opacity }}
        className="flex items-center justify-center overflow-hidden"
      >
        <motion.div style={{ rotate, scale }}>
          <RefreshCw className={`w-5 h-5 ${refreshing ? 'text-zinc-500 animate-spin' : 'text-zinc-400'}`} />
        </motion.div>
      </motion.div>
      {children}
    </div>
  );
}
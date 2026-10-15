import React, { useState, useRef, useEffect } from 'react';
import { Globe } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLanguage } from '@/lib/LanguageContext';

export default function LanguageSwitcher() {
  const { lang, setLang, LANGUAGES } = useLanguage();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const current = LANGUAGES.find(l => l.code === lang) || LANGUAGES[0];

  return (
    <div ref={ref} className="relative px-3 pb-2">
      <button
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all duration-200 ${
          open
            ? 'bg-zinc-100 text-zinc-900'
            : 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900'
        }`}
      >
        <Globe className="w-4 h-4 flex-shrink-0 text-zinc-400" />
        <span className="flex-1 text-left">{current.label}</span>
        <span className="text-xs">{current.flag}</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute left-3 right-3 bottom-full mb-1 z-50 bg-white border border-zinc-200 rounded-xl shadow-xl overflow-hidden"
          >
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                onClick={() => { setLang(l.code); setOpen(false); }}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                  lang === l.code
                    ? 'bg-zinc-900 text-white font-semibold'
                    : 'text-zinc-700 hover:bg-zinc-50'
                }`}
              >
                <span className="text-base">{l.flag}</span>
                <span>{l.label}</span>
                {lang === l.code && <span className="ml-auto text-xs opacity-70">✓</span>}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

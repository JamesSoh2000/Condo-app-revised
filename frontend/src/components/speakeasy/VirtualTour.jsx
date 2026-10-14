import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ChevronLeft, ChevronRight, Expand, Camera } from 'lucide-react';
import { useLanguage } from '@/lib/LanguageContext';

const ROOM_DATA = [
  {
    name: "Speakeasy",
    descriptionKey: "An intimate lounge with vintage-inspired decor, perfect for private gatherings.",
    photos: [
      "https://media.base44.com/images/public/6931cd960917c204b2b4808b/31471f07c_SharedImage.png",
      "https://media.base44.com/images/public/6931cd960917c204b2b4808b/4f31dedf5_speakeasy3.png",
      "https://media.base44.com/images/public/6931cd960917c204b2b4808b/a7c661303_Speakeasy2.png",
      "https://media.base44.com/images/public/6931cd960917c204b2b4808b/f90483998_speakeasy4.png",
    ],
  },
  {
    name: "TV Room (2nd floor)",
    descriptionKey: "A cozy TV lounge with comfortable seating, ideal for movie nights.",
    photos: [
      "https://media.base44.com/images/public/6931cd960917c204b2b4808b/758ccf3f8_SharedImage2.png",
      "https://media.base44.com/images/public/6931cd960917c204b2b4808b/dd1b675ef_tv1.png",
      "https://media.base44.com/images/public/6931cd960917c204b2b4808b/5c579ac06_tv2.png",
    ],
  },
  {
    name: "Dining room with TV (2nd floor)",
    descriptionKey: "A stylish dining space with integrated entertainment — ideal for dinner and a show.",
    photos: [
      "https://media.base44.com/images/public/6931cd960917c204b2b4808b/593b16519_SharedImage5.png",
      "https://media.base44.com/images/public/6931cd960917c204b2b4808b/a9e283186_DTV.png",
    ],
  },
  {
    name: "Living and Dining Room (3rd floor)",
    descriptionKey: "A spacious open-plan living and dining area with panoramic views.",
    photos: [
      "https://media.base44.com/images/public/6931cd960917c204b2b4808b/488c24dbe_SharedImage3.png",
      "https://media.base44.com/images/public/6931cd960917c204b2b4808b/9149c714f_k1.png",
    ],
  },
];

function PhotoCarousel({ photos, roomName, onExpand }) {
  const [idx, setIdx] = useState(0);

  const prev = (e) => { e.stopPropagation(); setIdx(i => (i - 1 + photos.length) % photos.length); };
  const next = (e) => { e.stopPropagation(); setIdx(i => (i + 1) % photos.length); };

  return (
    <div className="relative w-full h-48 overflow-hidden rounded-xl group cursor-pointer" onClick={() => onExpand(roomName, idx)}>
      <AnimatePresence mode="wait">
        <motion.img
          key={idx}
          src={photos[idx]}
          alt={roomName}
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35 }}
          className="w-full h-full object-cover"
        />
      </AnimatePresence>

      {/* Gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent" />

      {/* Expand button */}
      <motion.button
        initial={{ opacity: 0 }}
        whileHover={{ opacity: 1 }}
        className="absolute top-3 right-3 w-8 h-8 bg-black/50 backdrop-blur-sm rounded-lg flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => { e.stopPropagation(); onExpand(roomName, idx); }}
      >
        <Expand className="w-4 h-4" />
      </motion.button>

      {/* Nav arrows - only show if multiple photos */}
      {photos.length > 1 && (
        <>
          <button
            onClick={prev}
            className="absolute left-2 top-1/2 -translate-y-1/2 w-7 h-7 bg-black/50 backdrop-blur-sm rounded-full flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={next}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 bg-black/50 backdrop-blur-sm rounded-full flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          {/* Dots */}
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
            {photos.map((_, i) => (
              <div key={i} className={`w-1.5 h-1.5 rounded-full transition-all ${i === idx ? 'bg-white scale-125' : 'bg-white/50'}`} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function LightboxModal({ room, initialIdx, onClose }) {
  const [idx, setIdx] = useState(initialIdx || 0);
  const photos = room.photos;

  const prev = () => setIdx(i => (i - 1 + photos.length) % photos.length);
  const next = () => setIdx(i => (i + 1) % photos.length);

  // Keyboard navigation
  React.useEffect(() => {
    const handler = (e) => {
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'ArrowRight') next();
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Close */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white transition-colors z-10"
      >
        <X className="w-5 h-5" />
      </button>

      {/* Room name */}
      <div className="absolute top-4 left-4 text-white/80 text-sm font-medium">{room.name}</div>

      {/* Main image */}
      <div className="relative w-full max-w-4xl" onClick={e => e.stopPropagation()}>
        <AnimatePresence mode="wait">
          <motion.img
            key={idx}
            src={photos[idx]}
            alt={room.name}
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -30 }}
            transition={{ duration: 0.25 }}
            className="w-full max-h-[70vh] object-contain rounded-xl"
          />
        </AnimatePresence>

        {photos.length > 1 && (
          <>
            <button
              onClick={prev}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 bg-black/60 hover:bg-black/80 rounded-full flex items-center justify-center text-white transition-colors"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={next}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 bg-black/60 hover:bg-black/80 rounded-full flex items-center justify-center text-white transition-colors"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </>
        )}
      </div>

      {/* Thumbnails */}
      {photos.length > 1 && (
        <div className="flex gap-2 mt-4" onClick={e => e.stopPropagation()}>
          {photos.map((url, i) => (
            <button key={i} onClick={() => setIdx(i)}>
              <img
                src={url}
                alt=""
                className={`w-14 h-10 object-cover rounded-lg transition-all ${i === idx ? 'ring-2 ring-white scale-105' : 'opacity-50 hover:opacity-80'}`}
              />
            </button>
          ))}
        </div>
      )}

      {/* Counter */}
      <p className="text-white/50 text-xs mt-3">{idx + 1} / {photos.length}</p>
    </motion.div>
  );
}

export default function VirtualTour({ hideHeader = false }) {
  const { t } = useLanguage();
  const [lightbox, setLightbox] = useState(null); // { roomName, idx }

  const openLightbox = (roomName, idx) => {
    setLightbox({ roomName, idx });
  };

  const activeLightboxRoom = lightbox ? ROOM_DATA.find(r => r.name === lightbox.roomName) : null;

  return (
    <>
      <div className="space-y-4">
        {/* Room cards grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {ROOM_DATA.map((room, i) => (
            <motion.div
              key={room.name}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.07 }}
              whileHover={{ y: -3, boxShadow: '0 12px 32px rgba(88,28,135,0.12)' }}
              className="bg-white dark:bg-purple-100 rounded-2xl border border-zinc-100 dark:border-purple-200 shadow-sm overflow-hidden transition-shadow"
            >
              <PhotoCarousel
                photos={room.photos}
                roomName={room.name}
                onExpand={openLightbox}
              />
              <div className="p-3">
                <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-900 leading-tight">{t(room.name)}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-600 mt-0.5 leading-relaxed">{t(room.descriptionKey)}</p>
                <button
                  onClick={() => openLightbox(room.name, 0)}
                  className="mt-2 text-[11px] font-semibold text-purple-700 hover:text-purple-900 transition-colors"
                >
                  {t('View all photos →')}
                </button>
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      {/* Lightbox */}
      <AnimatePresence>
        {lightbox && activeLightboxRoom && (
          <LightboxModal
            room={activeLightboxRoom}
            initialIdx={lightbox.idx}
            onClose={() => setLightbox(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
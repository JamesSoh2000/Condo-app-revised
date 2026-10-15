import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { t as translate, LANGUAGES } from './i18n';
import { base44 } from '@/api/base44Client';

const LanguageContext = createContext(null);

const LANG_STORAGE_KEY = 'resident_lang';

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    return localStorage.getItem(LANG_STORAGE_KEY) || 'en';
  });
  const [profileId, setProfileId] = useState(null);

  // On mount, try to load saved language from profile
  useEffect(() => {
    const loadSavedLang = async () => {
      try {
        const user = await base44.auth.me();
        if (user?.account_type !== 'resident') return;

        // Try Profile first
        const profiles = await base44.entities.Profile.filter({ userId: user.id });
        if (profiles.length > 0 && profiles[0].preferred_language) {
          setLangState(profiles[0].preferred_language);
          localStorage.setItem(LANG_STORAGE_KEY, profiles[0].preferred_language);
          setProfileId(profiles[0].id);
          return;
        }
        if (profiles.length > 0) {
          setProfileId(profiles[0].id);
          return;
        }
        // Fallback: ResidentProfile
        const rps = await base44.entities.ResidentProfile.filter({ user_id: user.id });
        if (rps.length > 0 && rps[0].preferred_language) {
          setLangState(rps[0].preferred_language);
          localStorage.setItem(LANG_STORAGE_KEY, rps[0].preferred_language);
        }
      } catch (_) {}
    };
    loadSavedLang();
  }, []);

  const setLang = useCallback(async (newLang) => {
    setLangState(newLang);
    localStorage.setItem(LANG_STORAGE_KEY, newLang);

    // Persist to profile (best-effort, don't block UI)
    try {
      if (profileId) {
        await base44.entities.Profile.update(profileId, { preferred_language: newLang });
      } else {
        const user = await base44.auth.me();
        if (user?.account_type !== 'resident') return;
        const profiles = await base44.entities.Profile.filter({ userId: user.id });
        if (profiles.length > 0) {
          await base44.entities.Profile.update(profiles[0].id, { preferred_language: newLang });
          setProfileId(profiles[0].id);
        }
      }
    } catch (_) {}
  }, [profileId]);

  const t = useCallback((key) => translate(key, lang), [lang]);

  return (
    <LanguageContext.Provider value={{ lang, setLang, t, LANGUAGES }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) return { lang: 'en', setLang: () => {}, t: (k) => k, LANGUAGES };
  return ctx;
}
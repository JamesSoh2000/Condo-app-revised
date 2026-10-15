import { useState, useEffect } from 'react';

const STORAGE_KEY = 'resident_color_scheme';

export function useDarkMode() {
  const [colorScheme, setColorSchemeState] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) || 'light';
  });

  const applyScheme = (scheme) => {
    const html = document.documentElement;
    if (scheme === 'dark') {
      html.classList.add('dark');
    } else if (scheme === 'light') {
      html.classList.remove('dark');
    } else {
      // system
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      prefersDark ? html.classList.add('dark') : html.classList.remove('dark');
    }
  };

  useEffect(() => {
    applyScheme(colorScheme);

    // Listen for system changes when scheme === 'system'
    if (colorScheme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyScheme('system');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, [colorScheme]);

  const setColorScheme = (scheme) => {
    setColorSchemeState(scheme);
    localStorage.setItem(STORAGE_KEY, scheme);
    applyScheme(scheme);
  };

  return { colorScheme, setColorScheme };
}
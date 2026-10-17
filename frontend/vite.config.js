import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // loadEnv reads frontend/.env* (next to this file) as well as the shell.
  const env = loadEnv(mode, import.meta.dirname, '');
  return {
    logLevel: 'error', // Suppress warnings, only show errors
    resolve: {
      // The `@/` imports, as in vitest.config.ts. The Base44 plugin used to add this alias (removed in P2-06c).
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      // Same-origin API in development (ADR-0003): the browser calls /api on the Vite origin and Vite
      // forwards it to FastAPI, so there is no CORS. changeOrigin stays false, like the production proxy.
      // The key is a regex so only /api, /api/… and /api?… are forwarded (not /apifoo).
      proxy: {
        '^/api(/|\\?|$)': {
          target: env.VITE_API_PROXY_TARGET || 'http://localhost:8000',
          changeOrigin: false,
        },
      },
    },
    plugins: [react()],
  };
});

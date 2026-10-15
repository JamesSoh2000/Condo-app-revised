import base44 from "@base44/vite-plugin"
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // loadEnv reads frontend/.env* (next to this file) as well as the shell, like the Base44 plugin does.
  const env = loadEnv(mode, import.meta.dirname, '');
  return {
    logLevel: 'error', // Suppress warnings, only show errors
    server: {
      // Same-origin API in development (ADR-0003): the browser calls /api on the Vite origin and Vite
      // forwards it to FastAPI, so there is no CORS. changeOrigin stays false, like the production proxy.
      // The key is a regex so only /api, /api/… and /api?… are forwarded (not /apifoo).
      // Note: the Base44 plugin adds its own /api proxy if VITE_BASE44_APP_BASE_URL is set; leave that unset.
      proxy: {
        '^/api(/|\\?|$)': {
          target: env.VITE_API_PROXY_TARGET || 'http://localhost:8000',
          changeOrigin: false,
        },
      },
    },
    plugins: [
      base44({
        // Support for legacy code that imports the base44 SDK with @/integrations, @/entities, etc.
        // can be removed if the code has been updated to use the new SDK imports from @base44/sdk
        legacySDKImports: process.env.BASE44_LEGACY_SDK_IMPORTS === 'true'
      }),
      react(),
    ]
  };
});

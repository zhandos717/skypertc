import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// Vite builds the Vue source in `web/` and emits the production bundle into
// `static/`, which the Go server already serves at the site root. Non-bundled
// assets live in `web/public/` and are copied verbatim (icons.svg, manifest,
// service worker, icon images).
//
// In dev mode the Vite dev server proxies the WebSocket signaling channel and
// JSON endpoints to the Go backend running on :8080, so `npm run dev` gives
// HMR for the frontend while the existing Go server handles signaling.
export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [vue()],
  publicDir: 'public',
  build: {
    outDir: fileURLToPath(new URL('./static', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/ws':           { target: 'ws://localhost:8080', ws: true },
      '/rooms':        'http://localhost:8080',
      '/config.json':  'http://localhost:8080',
      '/healthz':      'http://localhost:8080',
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
    },
  },
});

import { defineConfig } from 'vite';

export default defineConfig({
  // Served from a sub-path on GitHub Pages (https://<user>.github.io/<repo>/): the deploy
  // workflow sets BASE_PATH. All app URLs go through import.meta.env.BASE_URL.
  base: process.env.BASE_PATH || '/',
  // No SPA fallback: a missing vector tile must be a 404 (empty tile), not index.html.
  appType: 'mpa',
  // MapLibre loads its worker with `new URL(..., import.meta.url)`, which pre-bundling breaks.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  // MapLibre starts its worker as an ES module (`new Worker(url, { type: 'module' })`).
  worker: { format: 'es' },
  build: { target: 'es2020', chunkSizeWarningLimit: 1500 },
});

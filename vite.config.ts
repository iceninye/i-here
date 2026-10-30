import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// base: './' — 同一份 build 可以放 GitHub Pages (/i-here/) 或 Cloudflare / Vercel 根目錄
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // MapLibre 自成一包（首屏必需）；deck.gl 只喺開 3D 時 lazy import
        manualChunks: { maplibre: ['maplibre-gl'] },
      },
    },
  },
  test: {
    environment: 'jsdom',
  },
});

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

/** 例如 `a1b2c3d · 2026-10-31`：debug 面板顯示，等貼出嚟嘅紀錄知道係邊個版本（手機會有舊快取） */
function buildId(): string {
  let sha = process.env.GITHUB_SHA?.slice(0, 7) ?? '';
  if (!sha) { try { sha = execSync('git rev-parse --short HEAD').toString().trim(); } catch { sha = 'local'; } }
  return `${sha} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

// base: './' — 同一份 build 可以放 GitHub Pages (/i-here/) 或 Cloudflare / Vercel 根目錄
export default defineConfig({
  base: './',
  plugins: [react()],
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
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

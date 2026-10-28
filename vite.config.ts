import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  plugins: [react()],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
  },
  server: {
    // `npm run dev -- ui` serves the API on 7777; Vite proxies to it.
    proxy: { '/api': 'http://localhost:7777' },
  },
});

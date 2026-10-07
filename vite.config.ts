import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { IMAGE_ID_PATTERN } from './src/worker/constants.ts';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', rollupOptions: { input: { main: 'index.html', admin: 'admin/index.html' } } },
  server: { proxy: { '/api': 'http://localhost:8787', '/upload': 'http://localhost:8787', [`^/${IMAGE_ID_PATTERN.source.slice(1, -1)}(?:\\?|$)`]: 'http://localhost:8787' } },
});

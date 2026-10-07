import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', rollupOptions: { input: { main: 'index.html', admin: 'admin/index.html' } } },
  server: { proxy: { '/api': 'http://localhost:8787', '/upload': 'http://localhost:8787', '^/[a-z]{32}(?:\\?|$)': 'http://localhost:8787' } },
});

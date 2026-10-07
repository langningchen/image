import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
  server: { proxy: { '/upload': 'http://localhost:8787', '^/[a-z]{32}(?:\\?|$)': 'http://localhost:8787' } },
});

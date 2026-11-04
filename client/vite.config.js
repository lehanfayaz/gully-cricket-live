import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000', '/socket.io': { target: 'http://localhost:3000', ws: true } } },
  build: { outDir: 'dist', emptyOutDir: true },
});

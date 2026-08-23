import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API runs on 3000. Proxying in development keeps the browser on one
    // origin, so the CORS allowlist does not have to include a dev port and a
    // developer cannot accidentally prove CORS works by bypassing it.
    proxy: {
      '/v1': {
        target: process.env['VITE_API_PROXY'] ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});

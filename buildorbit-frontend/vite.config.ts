import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/a2a': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/run': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // Only proxy actual run SSE/data endpoints, not React routes
      },
    },
  },
  build: {
    outDir: '../public/react-build',
    emptyOutDir: true,
  },
  // base must match outDir relative to public/ so Express static middleware
  // resolves /react-build/assets/* → public/react-build/assets/*
  base: '/react-build/',
});

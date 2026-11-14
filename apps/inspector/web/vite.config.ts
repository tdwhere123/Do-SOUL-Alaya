import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export const DEFAULT_INSPECTOR_BACKEND_PORT = 5174;
export const DEFAULT_INSPECTOR_SPA_PORT = 5175;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Ensure the bundle is small
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/node_modules\/react-force-graph-3d\//.test(id)) {
            return 'force-graph-3d';
          }
          return /node_modules\/(react|react-dom|react-router-dom)\//.test(id) ? 'vendor' : undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: DEFAULT_INSPECTOR_SPA_PORT,
    strictPort: true,
    proxy: {
      '/api': {
         target: process.env.ALAYA_INSPECTOR_URL ?? `http://127.0.0.1:${DEFAULT_INSPECTOR_BACKEND_PORT}`,
        changeOrigin: true,
      },
    },
  },
});

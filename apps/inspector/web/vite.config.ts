import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

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
    proxy: {
      '/api': {
        target: 'http://localhost:3000', // Default inspector server port
        changeOrigin: true,
      },
    },
  },
});

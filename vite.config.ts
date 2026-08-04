import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const isProd = mode === 'production';

  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.resolve(__dirname, '.') } },

    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {}
    },

    build: {
      target: 'es2020',
      sourcemap: isProd ? 'hidden' : true,
      cssMinify: true,
      // Leaflet + turf are large; warn only above a realistic threshold.
      chunkSizeWarningLimit: 900,

      rollupOptions: {
        output: {
          /**
           * Split heavy, rarely-changing dependencies into their own chunks so
           * a code change doesn't force users to re-download Leaflet and Turf.
           */
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            if (id.includes('leaflet')) return 'vendor-map';
            if (id.includes('@turf')) return 'vendor-geo';
            if (id.includes('@supabase')) return 'vendor-supabase';
            if (id.includes('react') || id.includes('scheduler')) return 'vendor-react';
            if (id.includes('lucide-react')) return 'vendor-icons';
            return 'vendor';
          }
        }
      }
    },

    // Drop console noise from production bundles but keep warnings/errors,
    // which are the ones that matter when debugging a live incident.
    esbuild: isProd ? { pure: ['console.log', 'console.debug'] } : undefined
  };
});

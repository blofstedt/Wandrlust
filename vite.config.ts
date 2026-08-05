import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const isProd = mode === 'production';

  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': rootDir } },

    server: {
      // HMR is disabled in AI Studio via the DISABLE_HMR env var.
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {}
    },

    build: {
      target: 'es2020',
      sourcemap: isProd ? 'hidden' : true,
      cssMinify: true,
      // Leaflet is large; warn only above a realistic threshold.
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          /**
           * Split heavy, rarely-changing dependencies into their own chunks so
           * a code change doesn't force users to re-download Leaflet.
           *
           * Order matters and the matches are path-anchored: the old version
           * tested `id.includes('react')` before `lucide-react`, so the entire
           * icon library was swept into the React chunk and its own rule was
           * unreachable.
           */
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return;
            if (id.includes('node_modules/leaflet')) return 'vendor-map';
            if (id.includes('node_modules/lucide-react')) return 'vendor-icons';
            if (id.includes('node_modules/@supabase')) return 'vendor-supabase';
            if (
              id.includes('node_modules/react/') ||
              id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/scheduler/')
            ) {
              return 'vendor-react';
            }
            return 'vendor';
          }
        }
      }
    },

    // Drop console noise from production bundles but keep warnings and errors,
    // which are the ones that matter when debugging a live incident.
    esbuild: isProd ? { pure: ['console.log', 'console.debug'] } : undefined
  };
});

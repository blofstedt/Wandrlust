import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, type Plugin } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Stamps the built service worker with a build id and the list of files to
 * precache.
 *
 * Two things depend on this and neither is obvious:
 *
 * 1. A browser only considers a service worker "new" if the BYTES of sw.js
 *    changed. `public/sw.js` is copied verbatim, so without a stamp it would
 *    be byte-identical on every deploy and the app would never be told an
 *    update exists. The id is derived from the emitted filenames, not from a
 *    timestamp, so rebuilding unchanged code does NOT nag users with a
 *    phantom update.
 *
 * 2. The precache list has to be the real hashed filenames, which only exist
 *    after the bundle is generated. Hardcoding it in public/sw.js would go
 *    stale the moment anything is rebuilt.
 */
const pwaBuildStamp = (): Plugin => ({
  name: 'wandrlust-pwa-build-stamp',
  apply: 'build',
  writeBundle(options, bundle) {
    const outDir = options.dir ?? path.join(rootDir, 'dist');
    const swPath = path.join(outDir, 'sw.js');
    if (!fs.existsSync(swPath)) return;

    // Sourcemaps are large and never needed offline.
    const assets = Object.keys(bundle)
      .filter((f) => /\.(js|css)$/.test(f))
      .map((f) => `/${f}`)
      .sort();

    const buildId = crypto
      .createHash('sha1')
      .update(assets.join('|'))
      .digest('hex')
      .slice(0, 12);

    const stamped = fs
      .readFileSync(swPath, 'utf8')
      .replace('__BUILD_ID__', buildId)
      .replace("['__PRECACHE_ASSETS__']", JSON.stringify(assets));

    fs.writeFileSync(swPath, stamped);
    // eslint-disable-next-line no-console
    console.log(`  sw.js stamped ${buildId} — ${assets.length} files precached`);
  }
});

export default defineConfig(({ mode }) => {
  const isProd = mode === 'production';

  return {
    plugins: [react(), tailwindcss(), pwaBuildStamp()],
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
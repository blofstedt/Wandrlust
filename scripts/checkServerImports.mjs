/**
 * Fail the build on a relative import that Vercel's ESM runtime cannot resolve.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCRIPT EXISTS
 * ---------------------------------------------------------------------------
 *
 * The project is `"type": "module"`, so the deployed function uses strict ESM
 * resolution: every relative import needs an explicit file extension. Leave one
 * off and the module throws ERR_MODULE_NOT_FOUND the instant it is imported.
 *
 * That failure is invisible in every place anyone looks. `npm run dev` uses
 * tsx, which resolves extensionless imports happily. `npm run lint` is a
 * TypeScript typecheck, and TypeScript resolves them happily too. The build
 * succeeds. The deploy goes green. And then `safeRegister` in api/index.ts
 * catches the import error exactly as it was designed to, records it, and one
 * whole feature answers 503 while the rest of the app carries on looking fine.
 *
 * It has now happened twice. `weatherRoutes` lost weather for a release. Then
 * `boundaryRoutes` imported `./landGeometry` without the extension and took
 * every public-land boundary off the map — which nobody could see, because the
 * browser's seven-day boundary cache kept drawing the last good answer at the
 * zoom levels already visited, and only a new viewport revealed the blank.
 *
 * A missing two characters must not cost a release again. This runs before the
 * client build, so Vercel fails the deploy and keeps the last working one live
 * instead of publishing a broken API.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

/**
 * `server.ts` is deliberately not checked.
 *
 * It is the development entry point — `npm run dev` runs it through tsx, and
 * `npm run build` bundles it with esbuild — and neither cares about
 * extensions. It is never part of the serverless function, which enters at
 * `api/index.ts`. Requiring extensions there would be churn with no failure
 * behind it.
 */
const ROOTS = ['api', 'server', 'shared'];

/** Extensions an ESM specifier may legitimately end with. */
const OK_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.node']);

/**
 * Relative specifiers in `import ... from '...'`, `export ... from '...'` and
 * `import('...')`. Deliberately a regex rather than a parser: it runs on every
 * build and the shape it is looking for is unambiguous.
 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]*)['"]/g;

const walk = (dir) => {
  let files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files; // A root that doesn't exist is not a failure.
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files = files.concat(walk(path));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) files.push(path);
  }
  return files;
};

const problems = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const source = readFileSync(file, 'utf8');
    const lines = source.split('\n');

    lines.forEach((line, index) => {
      // Skip comment lines — this file's own prose mentions the pattern.
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;

      for (const match of line.matchAll(SPECIFIER)) {
        const specifier = match[1];
        if (OK_EXTENSIONS.has(extname(specifier))) continue;
        problems.push({ file, line: index + 1, specifier });
      }
    });
  }
}

if (problems.length > 0) {
  console.error(
    '\nRelative imports without a file extension. The deployed function is ESM ' +
      'and will throw ERR_MODULE_NOT_FOUND on every one of these at runtime,\n' +
      'taking the feature that owns them to a 503 while the build stays green.\n' +
      'Add the extension — write `.js` even when the source is `.ts`.\n'
  );
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}  '${p.specifier}'  →  '${p.specifier}.js'`);
  }
  console.error('');
  process.exit(1);
}

console.log(`Server imports OK — ${ROOTS.join(', ')} carry explicit extensions.`);

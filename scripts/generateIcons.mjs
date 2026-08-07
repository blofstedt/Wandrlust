/**
 * Generates every PNG in public/icons from one vector definition.
 *
 *   npm run icons
 *
 * Two separate things depend on these files, and both fail quietly when they
 * are missing, which is why they are generated rather than hand-managed:
 *
 *   - The web app manifest. No 192px and 512px icon means no install prompt,
 *     on any platform. The app is simply not installable.
 *   - The service worker's push notifications, which reference an icon per
 *     hazard family. A missing file there doesn't error; the notification
 *     just arrives looking generic.
 *
 * Glyphs come from the lucide package already used across the UI, read
 * straight from its source so the notification icons can't drift away from
 * the icons shown in the app for the same hazard.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LUCIDE_DIR = path.join(rootDir, 'node_modules/lucide-react/dist/esm/icons');
const OUT_DIR = path.join(rootDir, 'public/icons');

/** Read a lucide icon's raw node list and turn it into SVG child elements. */
const glyph = (name) => {
  const file = path.join(LUCIDE_DIR, `${name}.js`);
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/const __iconNode = (\[[\s\S]*?\n\]);/);
  if (!match) throw new Error(`Could not read icon geometry from ${name}.js`);

  // The matched text is a plain array literal from a package already trusted
  // enough to execute in the browser.
  const nodes = eval(match[1]);

  return nodes
    .map(([tag, attrs]) => {
      const rendered = Object.entries(attrs)
        .filter(([key]) => key !== 'key')
        .map(([key, value]) => `${key}="${value}"`)
        .join(' ');
      return `<${tag} ${rendered} />`;
    })
    .join('');
};

/** The wordmark gradient from the navbar, so the icon matches the app. */
const BRAND_GRADIENT = `
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#10B981"/>
      <stop offset="52%" stop-color="#0D9488"/>
      <stop offset="100%" stop-color="#D97706"/>
    </linearGradient>`;

/**
 * @param {number} size       canvas size in px
 * @param {number} glyphFrac  glyph width as a fraction of the canvas
 * @param {number} radiusPct  corner radius as a percentage of size; 0 is a
 *                            full-bleed square, which is what maskable and
 *                            iOS icons need since the platform rounds them
 */
const appIcon = (size, glyphFrac, radiusPct, nodes) => {
  const glyphSize = size * glyphFrac;
  const offset = (size - glyphSize) / 2;
  const radius = (radiusPct / 100) * size;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>${BRAND_GRADIENT}
  </defs>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="url(#brand)"/>
  <g transform="translate(${offset} ${offset}) scale(${glyphSize / 24})"
     fill="none" stroke="#ffffff" stroke-width="2.1"
     stroke-linecap="round" stroke-linejoin="round">${nodes}</g>
</svg>`;
};

/** Notification icon: white glyph on a solid family-coloured disc. */
const alertIcon = (size, color, nodes) => {
  const glyphSize = size * 0.52;
  const offset = (size - glyphSize) / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${color}"/>
  <g transform="translate(${offset} ${offset}) scale(${glyphSize / 24})"
     fill="none" stroke="#ffffff" stroke-width="2.2"
     stroke-linecap="round" stroke-linejoin="round">${nodes}</g>
</svg>`;
};

/** Android draws the badge as a silhouette, so it must be white on nothing. */
const badgeIcon = (size, nodes) => {
  const glyphSize = size * 0.78;
  const offset = (size - glyphSize) / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <g transform="translate(${offset} ${offset}) scale(${glyphSize / 24})"
     fill="none" stroke="#ffffff" stroke-width="2.4"
     stroke-linecap="round" stroke-linejoin="round">${nodes}</g>
</svg>`;
};

/** Hazard family to lucide glyph and colour. Mirrors HazardAlertPanel. */
const ALERT_ICONS = {
  'alert-fire': ['flame', '#F97316'],
  'alert-flood': ['waves', '#0EA5E9'],
  'alert-storm': ['cloud-lightning', '#A855F7'],
  'alert-winter': ['snowflake', '#38BDF8'],
  'alert-heat': ['thermometer', '#EF4444'],
  'alert-wind': ['wind', '#64748B'],
  'alert-zone': ['thermometer-sun', '#F59E0B'],
  booking: ['calendar-check', '#10B981'],
  hazard: ['triangle-alert', '#F59E0B']
};

const run = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const compass = glyph('compass');

  const jobs = [
    // Install icons. Rounded, because these are shown as-is.
    ['icon-192.png', appIcon(192, 0.5, 22, compass)],
    ['icon-512.png', appIcon(512, 0.5, 22, compass)],
    // Maskable. Full bleed, glyph kept inside the central 80% safe zone so a
    // circular mask can't clip it.
    ['maskable-192.png', appIcon(192, 0.38, 0, compass)],
    ['maskable-512.png', appIcon(512, 0.38, 0, compass)],
    // iOS rounds the corners itself and renders transparency as black.
    ['apple-touch-icon.png', appIcon(180, 0.5, 0, compass)],
    ['favicon-32.png', appIcon(32, 0.56, 22, compass)],
    ['badge.png', badgeIcon(96, compass)]
  ];

  for (const [name, [icon, color]] of Object.entries(ALERT_ICONS)) {
    jobs.push([`${name}.png`, alertIcon(192, color, glyph(icon))]);
  }

  for (const [file, svg] of jobs) {
    const buffer = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
    fs.writeFileSync(path.join(OUT_DIR, file), buffer);
    console.log(`  ${file.padEnd(24)} ${buffer.length} bytes`);
  }

  // The vector master, committed so the raster set is reproducible.
  fs.writeFileSync(path.join(OUT_DIR, 'icon.svg'), appIcon(512, 0.5, 22, compass));
  console.log('  icon.svg                 (vector master)');
  console.log(`\n${jobs.length + 1} files written to public/icons/`);
};

run().catch((error) => {
  console.error('Icon generation failed:', error.message);
  process.exit(1);
});
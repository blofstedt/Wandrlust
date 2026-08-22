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
 * The app icon itself comes from `shared/brandMark.mjs`, which the header also
 * draws, so the thing on the home screen and the badge beside the wordmark
 * cannot drift apart. Hazard glyphs come from the lucide package already used
 * across the UI, read straight from its source so the notification icons can't
 * drift away from the icons shown in the app for the same hazard.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import {
  MARK_VIEWBOX, MARK_EXTENT, BRAND_GRADIENT_STOPS, markElements
} from '../shared/brandMark.mjs';

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
${BRAND_GRADIENT_STOPS.map((s) => `      <stop offset="${s.offset}" stop-color="${s.color}"/>`).join('\n')}
    </linearGradient>
    <radialGradient id="sheen" cx="0.28" cy="0.2" r="0.85">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.26"/>
      <stop offset="60%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>`;

/**
 * @param {number} size      canvas size in px
 * @param {number} markFrac  the MARK'S OWN DIAMETER as a fraction of the
 *                           canvas — not the fraction of some design box with
 *                           padding already baked into it. That distinction is
 *                           the whole reason the old icon looked lost: it asked
 *                           for half the canvas, got a glyph that filled 83% of
 *                           the box it was handed, and landed at 41%.
 * @param {number} radiusPct corner radius as a percentage of size; 0 is a
 *                           full-bleed square, which is what maskable and
 *                           iOS icons need since the platform rounds them
 */
const appIcon = (size, markFrac, radiusPct) => {
  const boxSize = (size * markFrac) / MARK_EXTENT;
  const offset = (size - boxSize) / 2;
  const radius = (radiusPct / 100) * size;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>${BRAND_GRADIENT}
  </defs>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="url(#brand)"/>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="url(#sheen)"/>
  <g transform="translate(${offset} ${offset}) scale(${boxSize / MARK_VIEWBOX})">${markElements()}</g>
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

/**
 * Android draws the badge as a silhouette from the alpha channel alone, so
 * there is no two-tone to be had: the shadowed facets keep their shape by
 * being thinner ink rather than a different colour.
 */
const badgeIcon = (size, markFrac) => {
  const boxSize = (size * markFrac) / MARK_EXTENT;
  const offset = (size - boxSize) / 2;
  const ink = { lit: '#ffffff', shadow: '#ffffff', shadowOpacity: 0.45 };

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <g transform="translate(${offset} ${offset}) scale(${boxSize / MARK_VIEWBOX})">${markElements(ink)}</g>
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

  const jobs = [
    // Install icons. Rounded, because these are shown as-is.
    ['icon-192.png', appIcon(192, 0.74, 22)],
    ['icon-512.png', appIcon(512, 0.74, 22)],
    /*
      Maskable — the Android home screen, and the one Brian actually looks at.
      The platform crops this to the middle 72 of every 108 units and then
      masks it to whatever shape the launcher uses, so two thirds of the file
      is a margin nobody ever sees. A mark sized as a fraction of the WHOLE
      canvas therefore lands far smaller than it looks here: the old 0.38 of a
      padded box came out at 31% of the file, which is 47% of the circle a
      Pixel actually draws — a small compass adrift in a green square.

      0.64 puts the rose's points just inside the circle a Pixel actually
      draws, so the compass fills its badge the way a native icon does while
      staying well within the 80% safe zone the web spec guarantees on every
      other launcher. It can sit wider than a solid disc could because a star
      leaves its diagonals empty — nothing is near the mask on the corners.
    */
    ['maskable-192.png', appIcon(192, 0.64, 0)],
    ['maskable-512.png', appIcon(512, 0.64, 0)],
    // iOS rounds the corners itself and renders transparency as black.
    ['apple-touch-icon.png', appIcon(180, 0.72, 0)],
    // 32px has room for the rose and nothing else, so it gets proportionally
    // more of the canvas than any other size.
    ['favicon-32.png', appIcon(32, 0.86, 22)],
    ['badge.png', badgeIcon(96, 0.92)]
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
  fs.writeFileSync(path.join(OUT_DIR, 'icon.svg'), appIcon(512, 0.74, 22));
  console.log('  icon.svg                 (vector master)');
  console.log(`\n${jobs.length + 1} files written to public/icons/`);
};

run().catch((error) => {
  console.error('Icon generation failed:', error.message);
  process.exit(1);
});

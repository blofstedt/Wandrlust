import React from 'react';
import {
  MARK_VIEWBOX, MARK_EXTENT, MARK_NEEDLE, MARK_RING, MARK_STROKE, MARK_INK,
  BRAND_GRADIENT_STOPS
} from '../../../shared/brandMark.mjs';

/**
 * The app's logo, in the app.
 *
 * The same geometry the home-screen icon is baked from — see
 * `shared/brandMark.mjs` for the shape and why it is that shape. The header
 * used to draw its own `<Compass>` component, which was a DIFFERENT drawing
 * that happened to be the same idea: change one and the other quietly stopped
 * matching. One mark, two renderers.
 *
 * The gradient ids are fixed rather than generated per instance. Two copies of
 * this on screen define the same id twice, which is technically a duplicate —
 * but they are byte-identical definitions, so whichever the browser resolves
 * paints the same thing, and the alternative is a fresh gradient in the DOM
 * for every badge.
 */
export const BrandMark: React.FC<{
  /** Rendered size in px. Everything inside scales from this. */
  size?: number;
  className?: string;
}> = ({ size = 40, className = '' }) => {
  /* The compass sits at 56% of the tile, matching `icon-192.png`. Reckoned
     against the mark's own widest points — the outside of the ring, stroke
     included — rather than its 24-unit design box, which has margin in it
     that would otherwise be counted twice and leave the mark smaller than
     asked for. That arithmetic is the one thing kept from the rose. */
  const box = MARK_VIEWBOX / 0.56 / MARK_EXTENT;
  const inset = (box - MARK_VIEWBOX) / 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-inset} ${-inset} ${box} ${box}`}
      className={className}
      role="img"
      aria-label="Wandrlust"
    >
      <defs>
        <linearGradient id="wl-brand" x1="0" y1="0" x2="1" y2="1">
          {BRAND_GRADIENT_STOPS.map((stop: { offset: string; color: string }) => (
            <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
          ))}
        </linearGradient>
        {/* The same soft top-left highlight the PNGs carry, so the badge in
            the header and the tile on the home screen catch light alike. */}
        <radialGradient id="wl-sheen" cx="0.28" cy="0.2" r="0.85">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.26" />
          <stop offset="60%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect
        x={-inset} y={-inset} width={box} height={box}
        rx={box * 0.22} ry={box * 0.22} fill="url(#wl-brand)"
      />
      <rect
        x={-inset} y={-inset} width={box} height={box}
        rx={box * 0.22} ry={box * 0.22} fill="url(#wl-sheen)"
      />

      <g
        fill="none"
        stroke={MARK_INK.lit}
        strokeWidth={MARK_STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={MARK_NEEDLE} />
        <circle cx={MARK_RING.cx} cy={MARK_RING.cy} r={MARK_RING.r} />
      </g>
    </svg>
  );
};

BrandMark.displayName = 'BrandMark';

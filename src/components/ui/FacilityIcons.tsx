import React from 'react';

/**
 * THE THREE SYMBOLS NO ICON SET HAS.
 *
 * Every other facility borrows a lucide glyph, because a shower, a shop and a
 * washing machine are things the world already has a symbol for. These three
 * are not:
 *
 *   DUMP STATION   The nearest stock icons are a download arrow (which is
 *                  what it looked like, and read as "save this to my phone")
 *                  or a bin, which is where you put a bag, not a tank. This
 *                  is a drop of waste water going down into a drain, which is
 *                  the actual act.
 *   PROPANE        It was a flame. A flame is a fire, a fire ban, a hazard
 *                  alert and a camp stove in this app already, and none of
 *                  those are a place to get a bottle filled. So: the bottle.
 *   GROCERIES      A trolley reads as "checkout", "cart", "buy" — the verb,
 *                  not the errand. A bag with a loaf and something green
 *                  poking out of it is food you are carrying back to camp.
 *
 * They are drawn in the same 24-unit box at the same 2-unit stroke as lucide's
 * own, so a row of them sits at one weight; the caller sets the stroke.
 */

interface GlyphProps {
  className?: string;
  strokeWidth?: number;
}

const Glyph: React.FC<GlyphProps & { children: React.ReactNode }> = ({
  className = '', strokeWidth = 2, children
}) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

/** A drop of waste water going down into a drain. */
export const DumpStationIcon: React.FC<GlyphProps> = (props) => (
  <Glyph {...props}>
    <path d="M12 3c2.2 2.6 3.8 4.6 3.8 6.5a3.8 3.8 0 0 1-7.6 0c0-1.9 1.6-3.9 3.8-6.5Z" />
    <path d="M3.5 16h17l-2.8 4.4a2 2 0 0 1-1.7.9H8a2 2 0 0 1-1.7-.9Z" />
  </Glyph>
);

/** A gas bottle, collar and all. */
export const PropaneIcon: React.FC<GlyphProps> = (props) => (
  <Glyph {...props}>
    <ellipse cx="12" cy="8.6" rx="5" ry="2.2" />
    <path d="M7 8.6v9.6c0 1.3 2.2 2.2 5 2.2s5-.9 5-2.2V8.6" />
    <path d="M12 6.4V4" />
    <path d="M10 4h4" />
  </Glyph>
);

/** A bag of shopping, with a loaf and something leafy out of the top. */
export const GroceriesIcon: React.FC<GlyphProps> = (props) => (
  <Glyph {...props}>
    <path d="M4.8 8.5h14.4l-1.3 11.3a2 2 0 0 1-2 1.7H8.1a2 2 0 0 1-2-1.7Z" />
    <path d="M9 8.5 12.8 2.9a1.6 1.6 0 0 1 2.6 1.8L13 8.5" />
    <path d="M17 8.5V5.2" />
    <path d="M17 6.6c1.2 0 2.1-1 2.1-2.1" />
  </Glyph>
);

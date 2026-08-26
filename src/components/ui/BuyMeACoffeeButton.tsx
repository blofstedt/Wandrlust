import React from 'react';

/**
 * The support button — a coffee cup, as a round yellow button.
 *
 * The cup is drawn here rather than lifted from buymeacoffee.com's own SVG.
 * That copy was a logo-sized path squeezed through a transform into a 26px
 * button: the curves collapsed into a smear and a good part of the artwork
 * sat outside the viewBox entirely, so what landed on screen did not read as
 * a cup at all. Four plain shapes — steam, lid, tapered body, sleeve — stay
 * crisp at the one size this is ever drawn.
 *
 * It lives in the map's control stack (just above the layers button) and
 * opens a small card rather than sailing straight off to a website: the
 * button is the thank-you, the card is the pitch, and only the yellow
 * "Support me" inside it actually leaves the app.
 */
export const BuyMeACoffeeButton: React.FC<{ onClick: () => void; open?: boolean }> = ({
  onClick, open = false
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Support Wandrlust — buy the project a coffee"
      aria-expanded={open}
      aria-haspopup="dialog"
      className={`pointer-events-auto shrink-0 tap-safe w-11 h-11 rounded-full bg-[#FFDD00] shadow-xl hover:scale-105 active:scale-95 transition-transform duration-150 flex items-center justify-center ${
        open ? 'ring-2 ring-emerald-400/70' : ''
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        className="w-[28px] h-[28px]"
        role="img"
        aria-hidden="true"
        fill="none"
      >
        {/* Steam. Stroked S-curves rather than straight ticks — two upright
            marks over a cup read as quotation marks, a wiggle reads as heat. */}
        <g stroke="#0D0C22" strokeWidth="1.5" strokeLinecap="round">
          <path d="M9.7 4.6C8.5 3.7 10.9 2.9 9.7 1.6" />
          <path d="M14.3 4.6C13.1 3.7 15.5 2.9 14.3 1.6" />
        </g>

        {/* The lid, overhanging the cup on both sides the way a real one does. */}
        <rect x="4.6" y="5.6" width="14.8" height="3.1" rx="1.55" fill="#0D0C22" />

        {/* The cup, tapering to a rounded base. */}
        <path
          d="M6.2 9.2H17.8L16.4 20.1A2.1 2.1 0 0 1 14.32 21.95H9.68A2.1 2.1 0 0 1 7.6 20.1Z"
          fill="#0D0C22"
        />

        {/* The sleeve, cut to the same taper so its ends sit flush with the
            cup's sides rather than overhanging them. */}
        <path d="M6.77 13.6H17.24L16.9 16.2H7.1Z" fill="#FFFFFF" />
      </svg>
    </button>
  );
};

/**
 * THE CARD THE BUTTON OPENS.
 *
 * The pitch lives here, not on the button — one tap on a yellow cup should
 * never feel like a bill. It says what the project is (free, no ads, no
 * tiers), why that is worth supporting, and then offers the actual link as a
 * proper yellow button that opens buymeacoffee.com in a new tab.
 */
export const SupportPanelBody: React.FC = () => {
  return (
    <div className="p-3.5">
      <p className="text-[12px] text-slate-300 leading-snug">
        Wandrlust is free and always will be — no ads, no subscriptions, no
        premium tiers. That takes real work: every boundary, every alert,
        every feature here is built and kept going by one person in their
        spare time.
      </p>
      <p className="text-[12px] text-slate-400 leading-snug mt-2">
        If it has saved you a night of hunting for a spot, a coffee goes a
        long way. No perks, no points — just thanks. It buys you nothing in
        the app, and that is the point.
      </p>
      <a
        href="https://buymeacoffee.com/blofstedt"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-[#FFDD00] hover:bg-[#FFE133] text-slate-950 text-xs font-bold"
      >
        Support me
      </a>
    </div>
  );
};

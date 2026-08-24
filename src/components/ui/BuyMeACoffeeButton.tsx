import React from 'react';

/**
 * The Buy Me a Coffee mark, as a round yellow button.
 *
 * This is the official buymeacoffee.com logo — the navy to-go cup with white
 * coffee — lifted verbatim from their own button SVG and set on the yellow
 * circle that all their buttons wear. Reusing their exact cup geometry keeps
 * the mark recognisable at a glance instead of being "a cup that sort of
 * looks like theirs".
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
      <svg viewBox="0 0 24 24" className="w-[26px] h-[26px]" role="img" aria-hidden="true">
        <g transform="translate(6.555 4.10) scale(0.66)">
          <path
            d="M16.5048 6.41468L16.3727 5.74859C16.2542 5.15095 15.9853 4.58625 15.3718 4.37025C15.1752 4.30115 14.9521 4.27145 14.8013 4.12841C14.6505 3.98538 14.606 3.76324 14.5711 3.55725C14.5065 3.17917 14.4458 2.80076 14.3796 2.42332C14.3225 2.09883 14.2773 1.73431 14.1284 1.43662C13.9347 1.0369 13.5327 0.803144 13.133 0.648488C12.9282 0.572029 12.7192 0.507349 12.507 0.454764C11.5083 0.1913 10.4583 0.0944382 9.43095 0.0392269C8.1978 -0.0288182 6.96136 -0.00831713 5.73115 0.100573C4.81548 0.183874 3.85106 0.284611 2.98092 0.601349C2.66289 0.71726 2.33517 0.856418 2.09334 1.10212C1.79662 1.40401 1.69976 1.87089 1.91641 2.24736C2.07042 2.51469 2.3313 2.70357 2.608 2.82853C2.96841 2.98953 3.34482 3.11204 3.73095 3.19402C4.80612 3.43165 5.91971 3.52496 7.01812 3.56468C8.23556 3.61381 9.45495 3.57399 10.6666 3.44554C10.9662 3.4126 11.2653 3.37311 11.5639 3.32704C11.9155 3.27312 12.1411 2.81335 12.0375 2.49306C11.9135 2.11013 11.5803 1.96161 11.2035 2.01941C11.148 2.02812 11.0928 2.0362 11.0372 2.04427L10.9972 2.05008C10.8696 2.06622 10.7419 2.08129 10.6143 2.09528C10.3506 2.1237 10.0863 2.14694 9.82131 2.16502C9.22787 2.20635 8.63281 2.2254 8.03808 2.22637C7.45368 2.22637 6.86896 2.2099 6.28585 2.17148C6.0198 2.15404 5.7544 2.13187 5.48964 2.10497C5.36921 2.09238 5.2491 2.07914 5.12899 2.06429L5.01469 2.04976L4.98983 2.04621L4.87134 2.02909C4.62919 1.99261 4.38703 1.95064 4.14746 1.89994C4.12328 1.89458 4.10166 1.88113 4.08616 1.86182C4.07066 1.8425 4.06222 1.81848 4.06222 1.79372C4.06222 1.76896 4.07066 1.74493 4.08616 1.72562C4.10166 1.70631 4.12328 1.69286 4.14746 1.68749H4.15198C4.35959 1.64326 4.56881 1.60548 4.77867 1.57255C4.84863 1.56157 4.9188 1.55081 4.98919 1.54026H4.99112C5.12253 1.53155 5.25459 1.50798 5.38535 1.49248C6.52305 1.37414 7.66751 1.33379 8.81071 1.37172C9.36573 1.38787 9.92043 1.42048 10.4729 1.47666C10.5917 1.48893 10.7099 1.50184 10.828 1.51637C10.8732 1.52186 10.9188 1.52832 10.9643 1.53381L11.056 1.54704C11.3233 1.58686 11.5892 1.63519 11.8544 1.68806C12.2427 1.7668 12.6228 1.86308 12.9446 2.10106C13.0108 2.14953 13.089 2.18583 13.1773 2.204C13.0657 1.58461 12.8572 0.994171 12.7756 0.372208C12.7233 -0.0180969 12.7062 -0.438321 12.9201 -0.788972C13.0989 -1.08095 13.4447 -1.18935 13.7594 -1.31634C14.0276 -1.4213 14.2811 -1.55499 14.5196 -1.71019C14.904 -1.9747 15.0936 -2.47706 15.1281 -2.93078C15.1557 -3.28972 15.1359 -3.65117 15.0702 -4.00472C15.0038 -4.34914 14.8936 -4.68664 14.7424 -5.0047C14.8365 -4.48683 14.9056 -3.96423 14.9495 -3.43926C15.0138 -2.87496 15.0531 -2.30818 15.0669 -1.74098C15.0764 -1.28176 15.0338 -0.821822 14.9405 -0.370484C14.8411 0.106297 14.6676 0.56828 14.4288 0.998654C14.2115 1.37115 13.8945 1.61027 13.4876 1.67334C13.5771 1.70054 13.6582 1.74614 13.7257 1.80686C13.7932 1.86759 13.8452 1.94169 13.878 2.02405C13.8989 2.09143 13.9221 2.15794 13.9476 2.22334C14.3452 3.22337 14.7675 4.21426 15.2298 5.17429C15.3337 5.39225 15.4432 5.60931 15.5531 5.82536L15.7046 6.14882L16.5048 6.41468Z"
            fill="#0D0C22"
          />
          <path
            d="M8.84348 11.1214C7.98141 11.4905 7.0031 11.9089 5.73518 11.9089C5.20476 11.9079 4.67693 11.8351 4.16602 11.6926L5.04294 20.6959C5.07398 21.0722 5.24541 21.4231 5.52319 21.6789C5.80096 21.9346 6.16477 22.0766 6.54236 22.0765C6.54236 22.0765 7.78574 22.1411 8.20064 22.1411C8.64717 22.1411 9.98612 22.0765 9.98612 22.0765C10.3637 22.0765 10.7274 21.9345 11.0051 21.6788C11.2828 21.423 11.4542 21.0722 11.4852 20.6959L12.4245 10.7469C12.0047 10.6035 11.5811 10.5083 11.1036 10.5083C10.2777 10.508 9.61224 10.7924 8.84348 11.1214Z"
            fill="#FFFFFF"
          />
        </g>
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

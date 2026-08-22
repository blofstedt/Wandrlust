import React from 'react';
import {
  Map as MapIcon, List, Bookmark, LayoutGrid, Plus
} from 'lucide-react';
import type { AppView } from '../types';
import { haptic } from '../utils/animation';

/**
 * The phone's primary navigation.
 *
 * WHY THIS EXISTS. Everything here used to live in the header: a view
 * switcher on its own row, and eight tools collapsed behind a single "⋯"
 * that opened a three-by-three grid of icons captioned in 10px type. Two
 * complaints followed from that one decision — the app felt cluttered
 * (because the header was four rows tall before any content) and things
 * could not be found (because "Scout" under an icon tells you nothing
 * about what Scout Mode is).
 *
 * So: the four things you switch between go to the bottom, where a thumb
 * already rests, and the tools became a PAGE of their own (`ToolsView`) with
 * room to say what each one does in a sentence. Tools is a tab like the other
 * three now, not a card that covers the one you were on — see the note at the
 * top of that file.
 *
 * THIS IS A LAYOUT ROW, NOT A FLOATING BAR. It is a flex sibling of the
 * map, so the map is simply shorter and the bar cannot cover the zoom
 * buttons, the attribution, or the boundary and backroad notices that
 * stack along the map's bottom edge. Nothing here reaches outside the row
 * either — the add button used to hang half out of it, and over the map
 * Leaflet's own panes painted across the half that stuck up.
 */

export interface MobileTabBarProps {
  activeView: AppView;
  setActiveView: (view: AppView) => void;
  savedCount: number;
  /** Both only feed the badge on the Tools tab — the panels live in the view. */
  activeFilterCount: number;
  nearbyCount: number;
  onOpenAddModal: () => void;
}

export const MobileTabBar: React.FC<MobileTabBarProps> = ({
  activeView, setActiveView, savedCount, activeFilterCount, nearbyCount,
  onOpenAddModal
}) => {
  const toolBadgeTotal = activeFilterCount + nearbyCount;

  const tabs: {
    id: AppView;
    label: string;
    icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
    badge?: number;
  }[] = [
    { id: 'map', label: 'Map', icon: MapIcon },
    { id: 'list', label: 'List', icon: List },
    { id: 'saved', label: 'Saved', icon: Bookmark, badge: savedCount },
    { id: 'tools', label: 'Tools', icon: LayoutGrid, badge: toolBadgeTotal }
  ];

  const select = (id: AppView) => {
    haptic('tap');
    setActiveView(id);
  };

  return (
    <>
      {/*
        `pb-[env(safe-area-inset-bottom)]` is deliberate even though the app
        shell already pads for the home indicator: on a phone the shell's
        padding sits BELOW this bar, which would leave a slate gap under it.
        Padding it here instead lets the bar's own background run to the
        bottom edge of the glass, the way a native tab bar does.

        The z-index is load-bearing. Leaflet gives its own panes z-indices in
        the hundreds, and this bar is a plain flex sibling of the map, so
        without a number of its own anything of ours that reaches upward gets
        painted over by the tiles — that is what sliced the top off the add
        button.
      */}
      <nav
        className="md:hidden relative shrink-0 z-[1200] bg-slate-900/95 backdrop-blur-md border-t border-slate-800 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_rgba(2,6,23,0.5)]"
        aria-label="Main"
      >
        <div className="flex items-center">
          {tabs.map(({ id, label, icon: Icon, badge }, index) => (
            <React.Fragment key={id}>
              {/*
                The add button.

                It used to float half out of the bar, over the map. That read
                well in a mock-up and badly on a phone: Leaflet painted over
                its top half, so what a thumb saw was a teal semicircle sitting
                off-centre in the bar. It lives INSIDE the bar now — centred in
                its own slot, the full circle visible, nothing overlapping
                anything. It is still the only round thing down here, which is
                what made it read as the one thing you DO.
              */}
              {index === 2 && (
                <div className="w-[74px] shrink-0 flex items-center justify-center">
                  <button
                    type="button"
                    onClick={() => { haptic('tap'); onOpenAddModal(); }}
                    className="w-[50px] h-[50px] rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 text-white shadow-lg shadow-emerald-950/70 ring-1 ring-emerald-300/30 flex items-center justify-center anim-pop"
                    aria-label="Submit the spot you are standing in"
                  >
                    <Plus className="w-7 h-7" strokeWidth={2.5} />
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={() => select(id)}
                aria-current={activeView === id ? 'page' : undefined}
                className={`relative flex-1 flex flex-col items-center justify-center gap-0.5 pt-2.5 pb-2 min-h-[62px] no-press ${
                  activeView === id ? 'text-emerald-400' : 'text-slate-400'
                }`}
              >
                <span className="relative">
                  <Icon className="w-[22px] h-[22px]" strokeWidth={activeView === id ? 2.4 : 2} />
                  {badge != null && badge > 0 && (
                    <span className="absolute -top-1.5 -right-2.5 min-w-[17px] h-[17px] px-1 rounded-full bg-emerald-500 text-slate-950 text-[11px] font-extrabold flex items-center justify-center">
                      {badge > 99 ? '99+' : badge}
                    </span>
                  )}
                </span>
                <span className="text-[11px] font-bold leading-none">{label}</span>
                {activeView === id && (
                  <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-emerald-400" />
                )}
              </button>
            </React.Fragment>
          ))}
        </div>
      </nav>

    </>
  );
};

MobileTabBar.displayName = 'MobileTabBar';

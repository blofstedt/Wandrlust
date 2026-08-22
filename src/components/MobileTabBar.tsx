import React, { useState } from 'react';
import {
  Map as MapIcon, List, Bookmark, LayoutGrid, Plus,
  SlidersHorizontal, Users, Activity, AlertTriangle,
  Settings as SettingsIcon, Download, BookOpen
} from 'lucide-react';
import type { AppView } from '../types';
import { Sheet } from './ui/Sheet';
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
 * already rests, and the tools move into a sheet that has room to say what
 * each one does in a sentence.
 *
 * THIS IS A LAYOUT ROW, NOT A FLOATING BAR. It is a flex sibling of the
 * map, so the map is simply shorter and the bar cannot cover the zoom
 * buttons, the attribution, or the boundary and backroad notices that
 * stack along the map's bottom edge. Nothing here reaches outside the row
 * either — the add button used to hang half out of it, and over the map
 * Leaflet's own panes painted across the half that stuck up.
 */

interface Tool {
  key: string;
  label: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClass: string;
  onClick: () => void;
  badge?: number;
  badgeClass?: string;
}

export interface MobileTabBarProps {
  activeView: AppView;
  setActiveView: (view: AppView) => void;
  savedCount: number;
  activeFilterCount: number;
  nearbyCount: number;
  onOpenFilterDrawer: () => void;
  onOpenPresence: () => void;
  onOpenScout: () => void;
  onOpenReport: () => void;
  onOpenSettings: () => void;
  onOpenOfflineManager: () => void;
  onOpenGuideModal: () => void;
  onOpenAddModal: () => void;
}

export const MobileTabBar: React.FC<MobileTabBarProps> = ({
  activeView, setActiveView, savedCount, activeFilterCount, nearbyCount,
  onOpenFilterDrawer, onOpenPresence, onOpenScout, onOpenReport,
  onOpenSettings, onOpenOfflineManager, onOpenGuideModal, onOpenAddModal
}) => {
  const [showTools, setShowTools] = useState(false);

  /* Grouped by the question being asked, not by which panel happens to
     open — "narrow down what I'm seeing" and "put something on the map"
     are different intents and were previously the same grey square. */
  const groups: { heading: string; tools: Tool[] }[] = [
    {
      heading: 'Narrow it down',
      tools: [
        {
          key: 'filters', label: 'Filters', icon: SlidersHorizontal,
          blurb: 'Land type, distance, road access, water and toilets',
          iconClass: 'text-emerald-400', onClick: onOpenFilterDrawer,
          badge: activeFilterCount, badgeClass: 'bg-emerald-500'
        },
        {
          key: 'presence', label: 'Campers nearby', icon: Users,
          blurb: 'Who else is out here right now, if they chose to share it',
          iconClass: 'text-sky-400', onClick: onOpenPresence,
          badge: nearbyCount, badgeClass: 'bg-sky-500'
        }
      ]
    },
    {
      heading: 'Add to the map',
      tools: [
        {
          key: 'add', label: 'Add the spot I am in', icon: Plus,
          blurb: 'Submit the ground under your feet as a camping spot',
          iconClass: 'text-emerald-400', onClick: onOpenAddModal
        },
        {
          key: 'report', label: 'Report a problem', icon: AlertTriangle,
          blurb: 'A hazard, a gate, a closure, or something wrong with a spot',
          iconClass: 'text-orange-400', onClick: onOpenReport
        },
        {
          key: 'scout', label: 'Scout Mode', icon: Activity,
          blurb: 'Record road surfaces automatically as you drive them',
          iconClass: 'text-amber-400', onClick: onOpenScout
        }
      ]
    },
    {
      heading: 'Before you lose signal',
      tools: [
        {
          key: 'offline', label: 'Offline maps', icon: Download,
          blurb: 'Download an area so the map still works with no bars',
          iconClass: 'text-teal-400', onClick: onOpenOfflineManager
        },
        {
          key: 'guide', label: 'Camping rules and safety', icon: BookOpen,
          blurb: 'What is allowed where, stay limits, fire rules',
          iconClass: 'text-amber-400', onClick: onOpenGuideModal
        }
      ]
    },
    {
      heading: 'App',
      tools: [
        {
          key: 'settings', label: 'Settings', icon: SettingsIcon,
          blurb: 'Alerts, units, position sharing, legal',
          iconClass: 'text-slate-400', onClick: onOpenSettings
        }
      ]
    }
  ];

  const toolBadgeTotal = activeFilterCount + nearbyCount;

  const tabs: {
    id: AppView | 'tools';
    label: string;
    icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
    badge?: number;
  }[] = [
    { id: 'map', label: 'Map', icon: MapIcon },
    { id: 'list', label: 'List', icon: List },
    { id: 'saved', label: 'Saved', icon: Bookmark, badge: savedCount },
    { id: 'tools', label: 'Tools', icon: LayoutGrid, badge: toolBadgeTotal }
  ];

  /* The bar keeps working while Tools is open, so every tab has to say what
     it does to a panel that is already up. Tools toggles; the other three
     put it away and go where they say they go.

     OPENING TOOLS ALSO GOES TO THE MAP. Every tool in the card acts on the
     map — filters change which pins are drawn, Add drops one, Scout records
     the road you are on — and opening it from the Saved list left a card of
     map controls floating over a list of saved cards, then dropped you back
     on that list when it closed. The map is the thing these tools are for,
     so that is what they open over. */
  const select = (id: AppView | 'tools') => {
    haptic('tap');
    if (id === 'tools') {
      const opening = !showTools;
      if (opening) setActiveView('map');
      setShowTools(opening);
      return;
    }
    setShowTools(false);
    setActiveView(id);
  };

  /* Tools has no view of its own, so it borrows the lit state from whether
     its panel is up — otherwise the tab you just pressed is the one thing
     on the bar that looks untouched.

     And while it is up it is the ONLY thing lit. Two green tabs — the one
     you pressed and the one you were on — read as two things being open at
     once, when only one is. The view underneath is still where it was; it
     just stops claiming the highlight until the card is closed. */
  const lit = (id: AppView | 'tools') =>
    showTools ? id === 'tools' : activeView === id;

  return (
    <>
      {/*
        `pb-[env(safe-area-inset-bottom)]` is deliberate even though the app
        shell already pads for the home indicator: on a phone the shell's
        padding sits BELOW this bar, which would leave a slate gap under it.
        Padding it here instead lets the bar's own background run to the
        bottom edge of the glass, the way a native tab bar does.

        The z-index is load-bearing, twice over. Leaflet gives its own panes
        z-indices in the hundreds, and this bar is a plain flex sibling of
        the map, so without a number of its own anything of ours that
        reaches upward gets painted over by the tiles — that is what sliced
        the top off the add button.

        And while Tools is open it goes ABOVE that panel's backdrop (1800),
        which is the whole point: the bar stays lit, undimmed and pressable
        under a card that is only covering the map. A bar you can still see
        and cannot press is worse than one that got covered up.
      */}
      <nav
        className={`md:hidden relative shrink-0 bg-slate-900/95 backdrop-blur-md border-t border-slate-800 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_rgba(2,6,23,0.5)] ${
          showTools ? 'z-[1900]' : 'z-[1200]'
        }`}
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
                    onClick={() => { haptic('tap'); setShowTools(false); onOpenAddModal(); }}
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
                aria-current={id !== 'tools' && activeView === id ? 'page' : undefined}
                aria-expanded={id === 'tools' ? showTools : undefined}
                className={`relative flex-1 flex flex-col items-center justify-center gap-0.5 pt-2.5 pb-2 min-h-[62px] no-press ${
                  lit(id) ? 'text-emerald-400' : 'text-slate-400'
                }`}
              >
                <span className="relative">
                  <Icon className="w-[22px] h-[22px]" strokeWidth={lit(id) ? 2.4 : 2} />
                  {badge != null && badge > 0 && (
                    <span className="absolute -top-1.5 -right-2.5 min-w-[17px] h-[17px] px-1 rounded-full bg-emerald-500 text-slate-950 text-[11px] font-extrabold flex items-center justify-center">
                      {badge > 99 ? '99+' : badge}
                    </span>
                  )}
                </span>
                <span className="text-[11px] font-bold leading-none">{label}</span>
                {lit(id) && (
                  <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-emerald-400" />
                )}
              </button>
            </React.Fragment>
          ))}
        </div>
      </nav>

      {/*
        Tools is a floating card, not a drawer.

        As a bottom sheet it slid up over the tab bar, so the Tools tab you
        had just pressed vanished under the thing it opened, and the last
        group ran off the bottom edge of the screen with nothing to say it
        was still going. A centred card sits clear of both edges: the bar
        stays visible underneath it, and the list scrolls inside the card
        where a scroll obviously belongs.

        And it is `interactiveBehind`, so the bar underneath is not just
        visible — it works. Tools toggles the card shut again, and Map, List
        and Saved put it away and go. Showing somebody a control and then
        refusing the press is the one outcome worse than covering it up.
      */}
      <Sheet
        isOpen={showTools}
        onClose={() => setShowTools(false)}
        variant="dialog"
        interactiveBehind
        title="Tools"
        subtitle="Everything that is not the map itself"
      >
        {/*
          The list is taller than any phone, so the card fades at its bottom
          edge instead of guillotining a row. Without it the last thing you
          can see is half a tool with a hard line through it, which reads as
          a broken card rather than as "keep scrolling".
        */}
        <div className="relative p-4 space-y-5">
          {groups.map(({ heading, tools }) => (
            <div key={heading}>
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 px-0.5 pb-2">
                {heading}
              </h3>
              <div className="space-y-2">
                {tools.map(({ key, label, blurb, icon: Icon, iconClass, onClick, badge, badgeClass }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => { setShowTools(false); onClick(); }}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-xl bg-slate-800/50 hover:bg-slate-800 border border-slate-700/60 text-left"
                  >
                    <span className="w-9 h-9 shrink-0 rounded-lg bg-slate-900/80 border border-slate-700 flex items-center justify-center self-start">
                      <Icon className={`w-[18px] h-[18px] ${iconClass}`} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-sm font-bold text-slate-100">{label}</span>
                        {badge != null && badge > 0 && (
                          <span className={`min-w-[18px] h-[18px] px-1 rounded-full ${badgeClass} text-slate-950 text-[11px] font-extrabold flex items-center justify-center`}>
                            {badge}
                          </span>
                        )}
                      </span>
                      <span className="block text-xs text-slate-400 leading-snug mt-0.5">{blurb}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div
            aria-hidden="true"
            className="sticky bottom-0 -mb-4 h-7 bg-gradient-to-t from-slate-900 to-transparent pointer-events-none"
          />
        </div>
      </Sheet>
    </>
  );
};

MobileTabBar.displayName = 'MobileTabBar';

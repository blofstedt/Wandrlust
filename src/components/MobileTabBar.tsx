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
 * stack along the map's bottom edge. The only thing that floats is the
 * add button, and it floats over the middle of the map where nothing else
 * ever sits.
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

  const select = (id: AppView | 'tools') => {
    haptic('tap');
    if (id === 'tools') { setShowTools(true); return; }
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
      */}
      <nav
        className="md:hidden relative shrink-0 bg-slate-900/95 backdrop-blur-md border-t border-slate-800 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_rgba(2,6,23,0.5)]"
        aria-label="Main"
      >
        {/*
          The add button.

          It floats clear of the bar so it reads as the one thing you DO
          rather than one of four places you go. It sits centred, over the
          middle of the map's bottom edge, which is the one strip of the map
          chrome that has never held a control.

          The `z-10` is load-bearing. The tab row below is a later sibling,
          so without it the tabs paint over the button's bottom half — the
          half a thumb actually lands on — and the tap silently opened
          Saved instead.
        */}
        <button
          type="button"
          onClick={() => { haptic('tap'); onOpenAddModal(); }}
          className="absolute -top-7 left-1/2 -translate-x-1/2 z-10 w-14 h-14 rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 border-4 border-slate-900 text-white shadow-xl shadow-emerald-950/60 flex items-center justify-center anim-pop"
          aria-label="Submit the spot you are standing in"
        >
          <Plus className="w-7 h-7" strokeWidth={2.5} />
        </button>

        <div className="flex items-stretch">
          {tabs.map(({ id, label, icon: Icon, badge }, index) => {
            const active = id !== 'tools' && activeView === id;
            /* The two tabs either side of the add button give up a little
               width to it, so nothing sits under a floating circle. */
            const clearsFab = index === 1 ? 'pr-7' : index === 2 ? 'pl-7' : '';
            return (
              <button
                key={id}
                type="button"
                onClick={() => select(id)}
                aria-current={active ? 'page' : undefined}
                className={`relative flex-1 flex flex-col items-center justify-center gap-0.5 pt-2 pb-1.5 min-h-[54px] no-press ${clearsFab} ${
                  active ? 'text-emerald-400' : 'text-slate-400'
                }`}
              >
                <span className="relative">
                  <Icon className="w-[22px] h-[22px]" strokeWidth={active ? 2.4 : 2} />
                  {badge != null && badge > 0 && (
                    <span className="absolute -top-1.5 -right-2.5 min-w-[17px] h-[17px] px-1 rounded-full bg-emerald-500 text-slate-950 text-[11px] font-extrabold flex items-center justify-center">
                      {badge > 99 ? '99+' : badge}
                    </span>
                  )}
                </span>
                <span className="text-[11px] font-bold leading-none">{label}</span>
                {active && (
                  <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-emerald-400" />
                )}
              </button>
            );
          })}
        </div>
      </nav>

      <Sheet
        isOpen={showTools}
        onClose={() => setShowTools(false)}
        title="Tools"
        subtitle="Everything that is not the map itself"
      >
        <div className="p-3 space-y-4">
          {groups.map(({ heading, tools }) => (
            <div key={heading}>
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 px-1 pb-1.5">
                {heading}
              </h3>
              <div className="space-y-1.5">
                {tools.map(({ key, label, blurb, icon: Icon, iconClass, onClick, badge, badgeClass }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => { setShowTools(false); onClick(); }}
                    className="w-full flex items-center gap-3 p-3 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-slate-700/70 text-left"
                  >
                    <span className="w-9 h-9 shrink-0 rounded-lg bg-slate-900/80 border border-slate-700 flex items-center justify-center">
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
        </div>
      </Sheet>
    </>
  );
};

MobileTabBar.displayName = 'MobileTabBar';

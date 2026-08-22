import React from 'react';
import {
  SlidersHorizontal, Users, Activity, AlertTriangle,
  Settings as SettingsIcon, Download, BookOpen, Plus, ChevronRight
} from 'lucide-react';
import { haptic } from '../utils/animation';

/**
 * TOOLS IS A PAGE NOW, NOT A THING THAT COVERS THE PAGE.
 *
 * It was a card that floated over the map with the list scrolling inside it,
 * and it read as an interruption: a dark panel with a shadow, a backdrop, the
 * map dimmed behind it, an × in the corner. Every one of those says "you are
 * in the middle of something and this is on top of it" — and that is a lie
 * about what Tools is. Nobody is halfway through anything when they go
 * looking for the offline downloader. It is a place in the app, exactly like
 * the list of spots and the saved ones, reached by the same row of tabs.
 *
 * So it looks like them: full width, the page's own scroll, a heading, and
 * cards with room to say what each thing is for in a sentence. Nothing is
 * dimmed, nothing has to be dismissed, and the tab bar underneath keeps
 * working the way it does on every other view.
 *
 * The blurbs are the point of the whole screen. The version before this was a
 * three-by-three grid of icons captioned in 10px type, and "Scout" under a
 * squiggle tells you nothing whatever about Scout Mode.
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

export interface ToolsViewProps {
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

export const ToolsView: React.FC<ToolsViewProps> = ({
  activeFilterCount, nearbyCount, onOpenFilterDrawer, onOpenPresence,
  onOpenScout, onOpenReport, onOpenSettings, onOpenOfflineManager,
  onOpenGuideModal, onOpenAddModal
}) => {
  /* Grouped by the question being asked, not by which panel happens to open —
     "narrow down what I'm seeing" and "put something on the map" are
     different intents and were once the same grey square. */
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

  return (
    /* The same frame the list and saved views use, to the class. Three pages
       that behave identically should not be three different shapes. */
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 pb-16 md:pb-6 max-w-7xl mx-auto w-full space-y-5 scroll-soft">
      <div className="pb-3 border-b border-slate-800">
        <h2 className="font-['Outfit'] font-bold text-xl text-slate-100">
          Tools
        </h2>
        <p className="text-xs text-slate-400">
          Everything that is not the map itself
        </p>
      </div>

      {groups.map(({ heading, tools }) => (
        <div key={heading} className="space-y-2">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 px-0.5">
            {heading}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {tools.map(({ key, label, blurb, icon: Icon, iconClass, onClick, badge, badgeClass }) => (
              <button
                key={key}
                type="button"
                onClick={() => { haptic('tap'); onClick(); }}
                className="w-full flex items-center gap-3 p-4 rounded-2xl bg-slate-900/60 hover:bg-slate-800/70 border border-slate-800 hover:border-slate-700 text-left liftable"
              >
                <span className="w-11 h-11 shrink-0 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-center">
                  <Icon className={`w-5 h-5 ${iconClass}`} />
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
                  <span className="block text-xs text-slate-400 leading-snug mt-0.5">
                    {blurb}
                  </span>
                </span>
                <ChevronRight className="w-4 h-4 text-slate-600 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

ToolsView.displayName = 'ToolsView';

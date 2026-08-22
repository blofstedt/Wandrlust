import type React from 'react';
import {
  Map as MapIcon, List, Bookmark, LayoutGrid, SlidersHorizontal, Users,
  Activity, AlertTriangle, Settings as SettingsIcon, Download, BookOpen,
  PlusCircle, Trees, Mountain, TentTree, Landmark
} from 'lucide-react';
import type { AppView, FacilityKind, LandType } from '../types';
import { FACILITY, FACILITY_KINDS } from './facilities';
import type { FacilityIcon } from './facilities';

/**
 * ONE BOX, AND IT ANSWERS FOR THE APP AS WELL AS FOR THE WORLD.
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 *
 * The search box could find a town and nothing else. Everything else this app
 * can do — show the showers around here, download this area before the signal
 * goes, narrow the map to Crown land, report a gate — was behind a symbol
 * somebody had to already know the meaning of, in a panel they had to already
 * know the existence of. A camper who knows exactly what they want ("propane")
 * had no way to say it.
 *
 * So the box takes words for both. Type a place and it moves the map there;
 * type a thing and it finds the part of the app that does it. Both kinds of
 * answer appear in the same list, with the app's own answers first: they are
 * exact, they are instant, and nobody types "settings" hoping for a village in
 * Saskatchewan.
 *
 * ---------------------------------------------------------------------------
 * THE TWO DIFFERENT PROMISES
 * ---------------------------------------------------------------------------
 *
 * A place answer MOVES THE MAP. A layer answer does NOT: it draws what it
 * finds on the ground already on screen, because "show me showers" means the
 * screen you are looking at, not a shower somewhere in the next province. Each
 * entry says which of the two it is, in its own words, so the list never
 * implies a journey it is not about to make.
 *
 * Nothing here promises a RESULT either. Switching on a layer is switching on
 * a layer; whether anything is found, and whether an empty answer means
 * "nothing here" or "nobody has mapped this", is said by the map afterwards
 * (`facilityNotice` in `MapComponent`).
 */

/** Everything the box can do besides go somewhere. */
export interface AppSearchEntry {
  id: string;
  /** The heading of the row: what the thing is called. */
  title: string;
  /** One line saying what pressing it does — including whether the map moves. */
  detail: string;
  icon: FacilityIcon;
  /** Extra words a camper might type for it. Title words are matched anyway. */
  keywords: string[];
  /** Rows that are already doing what they offer say so instead of "off". */
  isOn?: boolean;
  run: () => void;
}

/** What the box needs to be able to reach. All of it already exists. */
export interface AppSearchHandlers {
  setActiveView: (view: AppView) => void;
  toggleFacility: (kind: FacilityKind) => void;
  activeFacilities: FacilityKind[];
  setLandTypes: (types: LandType[]) => void;
  openFilters: () => void;
  openPresence: () => void;
  openScout: () => void;
  openReport: () => void;
  openSettings: () => void;
  openOffline: () => void;
  openGuide: () => void;
  openAddHere: () => void;
}

/**
 * The land types, as words a camper would actually type.
 *
 * These narrow the campsite list rather than repainting the map, and the
 * wording says so — "only" is the honest word for a filter. What they do NOT
 * do is claim the boundary layer is showing only that kind of land; the map
 * draws whatever the government services answered with, and a filter on
 * campsites cannot change that.
 */
const LAND_ROWS: {
  land: LandType;
  title: string;
  icon: FacilityIcon;
  keywords: string[];
}[] = [
  {
    land: 'crown_land', title: 'Crown land', icon: Trees,
    keywords: ['crown', 'canada', 'canadian', 'provincial']
  },
  {
    land: 'blm', title: 'BLM land', icon: Mountain,
    keywords: ['blm', 'bureau of land management', 'public land']
  },
  {
    land: 'usfs', title: 'National forest', icon: Trees,
    keywords: ['usfs', 'forest service', 'national forest']
  },
  {
    land: 'state_forest', title: 'State forest', icon: Landmark,
    keywords: ['state forest', 'state land']
  },
  {
    land: 'dispersed', title: 'Dispersed camping', icon: TentTree,
    keywords: ['dispersed', 'boondock', 'boondocking', 'free camping', 'wild camping']
  }
];

/**
 * Build the index. Called with the handlers the caller already holds, so
 * nothing here has to know how a panel opens.
 */
export const buildAppSearch = (h: AppSearchHandlers): AppSearchEntry[] => {
  const on = new Set(h.activeFacilities);

  /*
    Every kind OpenStreetMap can be asked about, not just the nine on the arc.
    Fishing spots, trailheads and boat ramps have never had a button anywhere
    — there was no room for them on a row of chips — but the layer machinery
    has always been able to draw them, and typing the word is a perfectly good
    way to ask for one. `road` is excluded: it has no selectors of its own and
    is looked up per-pin, not as a layer.
  */
  const facilityRows: AppSearchEntry[] = FACILITY_KINDS
    .filter((kind) => FACILITY[kind].osm.length > 0)
    .map((kind) => {
      const spec = FACILITY[kind];
      const lit = on.has(kind);
      return {
        id: `facility-${kind}`,
        title: spec.plural,
        detail: lit
          ? `Already on. Tap to stop showing ${spec.plural.toLowerCase()}.`
          : `Show ${spec.plural.toLowerCase()} on the piece of map you are looking at.`,
        icon: spec.icon,
        keywords: [spec.label, kind, ...FACILITY_WORDS[kind] ?? []],
        isOn: lit,
        /*
          Switching a layer ON from the list or the saved view goes to the map
          as well, because that is the only place the pins it just asked for
          can appear — leaving somebody on a list of cards after they asked to
          see showers is the app doing the thing and hiding it. Switching one
          OFF stays where it is: nothing new has appeared to go and look at.
        */
        run: () => {
          h.toggleFacility(kind);
          if (!lit) h.setActiveView('map');
        }
      };
    });

  const viewRows: AppSearchEntry[] = [
    {
      id: 'view-map', title: 'The map', detail: 'Go back to the map.',
      icon: MapIcon, keywords: ['map', 'satellite', 'terrain'],
      run: () => h.setActiveView('map')
    },
    {
      id: 'view-list', title: 'Camping spots nearby',
      detail: 'The list of spots around where the map is looking.',
      icon: List,
      keywords: ['list', 'camp spots', 'campsites', 'camping', 'sites', 'spots'],
      run: () => h.setActiveView('list')
    },
    {
      id: 'view-saved', title: 'Saved spots',
      detail: 'The spots you have kept for when there is no signal.',
      icon: Bookmark, keywords: ['saved', 'bookmarks', 'favourites', 'favorites'],
      run: () => h.setActiveView('saved')
    },
    {
      id: 'view-tools', title: 'Tools',
      detail: 'Everything that is not the map itself.',
      icon: LayoutGrid, keywords: ['tools', 'menu', 'more'],
      run: () => h.setActiveView('tools')
    }
  ];

  const toolRows: AppSearchEntry[] = [
    {
      id: 'tool-filters', title: 'Filters',
      detail: 'Land type, distance, road access, water and toilets.',
      icon: SlidersHorizontal,
      keywords: ['filter', 'distance', 'road access', 'rig length', 'pets', 'sort'],
      run: h.openFilters
    },
    {
      id: 'tool-offline', title: 'Offline maps',
      detail: 'Download an area so the map still works with no bars.',
      icon: Download,
      keywords: ['offline', 'download', 'no signal', 'no service', 'save maps'],
      run: h.openOffline
    },
    {
      id: 'tool-add', title: 'Add the spot I am in',
      detail: 'Submit the ground under your feet as a camping spot.',
      icon: PlusCircle,
      keywords: ['add', 'submit', 'new spot', 'contribute'],
      run: h.openAddHere
    },
    {
      id: 'tool-report', title: 'Report a problem',
      detail: 'A hazard, a gate, a closure, or something wrong with a spot.',
      icon: AlertTriangle,
      keywords: ['report', 'hazard', 'gate', 'closed', 'problem', 'wrong'],
      run: h.openReport
    },
    {
      id: 'tool-presence', title: 'Campers nearby',
      detail: 'Who else is out here right now, if they chose to share it.',
      icon: Users,
      keywords: ['campers', 'nearby', 'people', 'friends', 'presence'],
      run: h.openPresence
    },
    {
      id: 'tool-scout', title: 'Scout Mode',
      detail: 'Record road surfaces automatically as you drive them.',
      icon: Activity,
      keywords: ['scout', 'road surface', 'record', 'driving'],
      run: h.openScout
    },
    {
      id: 'tool-guide', title: 'Camping rules and safety',
      detail: 'What is allowed where, stay limits, fire rules.',
      icon: BookOpen,
      keywords: ['rules', 'legal', 'fire ban', 'stay limit', 'safety', 'guide'],
      run: h.openGuide
    },
    {
      id: 'tool-settings', title: 'Settings',
      detail: 'Alerts, units, position sharing, legal.',
      icon: SettingsIcon,
      keywords: ['settings', 'notifications', 'alerts', 'units', 'account', 'privacy'],
      run: h.openSettings
    }
  ];

  const landRows: AppSearchEntry[] = LAND_ROWS.map((row) => ({
    id: `land-${row.land}`,
    title: row.title,
    detail: `Narrow the spot list to ${row.title.toLowerCase()} only.`,
    icon: row.icon,
    keywords: row.keywords,
    run: () => { h.setLandTypes([row.land]); h.setActiveView('list'); }
  }));

  return [...facilityRows, ...landRows, ...toolRows, ...viewRows];
};

/**
 * Words for a facility beyond its own name — what a camper calls it when they
 * are not reading a label. "Dunny" is not in here; "restroom" is, because half
 * the continent says it.
 */
const FACILITY_WORDS: Partial<Record<FacilityKind, string[]>> = {
  toilet: ['restroom', 'bathroom', 'washroom', 'outhouse', 'pit toilet', 'loo'],
  water: ['drinking water', 'potable', 'tap', 'fill up', 'spigot'],
  shower: ['wash', 'bathe', 'hot water'],
  dump: ['dump station', 'black water', 'grey water', 'sani', 'sanidump', 'sewer', 'tanks'],
  fuel: ['gas', 'gas station', 'petrol', 'diesel'],
  propane: ['lpg', 'bottle', 'tank refill', 'gas bottle'],
  laundry: ['laundromat', 'washing', 'wash clothes'],
  groceries: ['grocery', 'food', 'supermarket', 'shop', 'store', 'supplies'],
  waste: ['rubbish', 'trash', 'garbage', 'bin', 'recycling'],
  air: ['tyre', 'tire', 'compressor', 'pump'],
  trail: ['hike', 'hiking', 'walk', 'trailhead', 'trails'],
  fishing: ['fish', 'angling', 'lake', 'river'],
  boat: ['boat ramp', 'launch', 'slipway', 'kayak', 'canoe', 'paddle']
};

/**
 * Match typed text against the index.
 *
 * Ranked, not filtered-and-shuffled: something whose NAME starts with what you
 * typed comes before something that merely contains it, which comes before a
 * synonym match. Typing "wat" should offer Water before Rubbish disposal, and
 * a plain `includes` over every field does not do that.
 *
 * Capped at five. This list shares a dropdown with places, and a camper
 * looking for a town should never have to scroll past nine app rows to find
 * it.
 */
export const matchAppSearch = (
  entries: AppSearchEntry[], query: string, limit = 5
): AppSearchEntry[] => {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const scored: { entry: AppSearchEntry; score: number }[] = [];

  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    let score = -1;

    if (title === q) score = 0;
    else if (title.startsWith(q)) score = 1;
    else if (title.includes(q)) score = 2;
    else {
      for (const word of entry.keywords) {
        const k = word.toLowerCase();
        if (k === q) { score = 1; break; }
        if (k.startsWith(q)) { score = Math.min(score < 0 ? 3 : score, 3); }
        else if (k.includes(q) && score < 0) score = 4;
      }
    }

    if (score >= 0) scored.push({ entry, score });
  }

  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((row) => row.entry);
};

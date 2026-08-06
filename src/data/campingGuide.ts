import type { GuideSection } from '../types';

/**
 * The field guide.
 *
 * This is a plain-language SUMMARY of rules published by land management
 * agencies. It is not the regulation, it is not legal advice, and it goes
 * stale — districts close roads, add fire bans, and change stay limits
 * without warning. Every section names its source so a reader can go and
 * check the original before they drive somewhere.
 *
 * When adding to this file:
 *  - Only write down rules you can point at a published source for.
 *  - Prefer "varies by district, check locally" over inventing a number.
 *  - Keep entries short. This is read on a phone, often at a trailhead.
 */

export const CAMPING_GUIDE: GuideSection[] = [
  /* ---------------------------------------------------------------- */
  {
    id: 'start-here',
    title: 'Start Here',
    summary: 'The four things worth settling before you leave pavement.',
    icon: 'compass',
    accent: 'amber',
    subsections: [
      {
        id: 'start-whose-land',
        title: 'Know whose land you are on',
        entries: [
          {
            term: 'The agency sets the rules',
            text: 'BLM, US Forest Service, a state forest and Canadian Crown land all allow dispersed camping, and all four have different stay limits, fire rules and permit requirements. The rules follow the landowner, not the landscape.'
          },
          {
            term: 'Boundaries on this map are approximate',
            text: 'They come from government data that is generalised, sometimes years old, and silent about private inholdings. A pin inside a green polygon is a strong hint, not permission.'
          },
          {
            term: 'When in doubt, ask',
            text: 'A phone call to the district or field office is the only way to be certain. They will also know about closures that no map shows yet.'
          }
        ],
        caveat: 'Absence of a boundary on this map means "no data", never "no public land".'
      },
      {
        id: 'start-check-first',
        title: 'Check before you drive',
        entries: [
          { term: 'Fire restrictions', text: 'These change weekly in summer and can ban open flame, charcoal, and sometimes gas stoves outright.' },
          { term: 'Road and area closures', text: 'Seasonal gates, washouts, logging and active fire operations all close roads that still appear on maps.' },
          { term: 'Weather and runoff', text: 'A dry wash is a road until it is a river. Spring melt and summer monsoon both strand vehicles every year.' },
          { term: 'Download your maps', text: 'Most dispersed camping is outside cell coverage. Save the area offline while you still have signal.' }
        ]
      },
      {
        id: 'start-self-sufficient',
        title: 'Arrive self-sufficient',
        entries: [
          { term: 'No services', text: 'Dispersed sites have no water, no toilets, no bins, no hookups, and nobody coming to check on you.' },
          { term: 'Water', text: 'Bring more than you plan to use. Treat anything you take from a stream.' },
          { term: 'Waste', text: 'Everything you carry in — including food scraps and gray water — comes back out with you.' },
          { term: 'Recovery', text: 'Traction boards, a spare, and a way to signal for help matter more than any other gear on a rough road.' }
        ]
      }
    ],
    links: [{ label: 'Leave No Trace Center', href: 'https://lnt.org/' }]
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'blm-usfs',
    title: 'BLM Land & National Forest',
    summary: 'The two agencies that manage most dispersed camping in the United States.',
    icon: 'mountain',
    accent: 'emerald',
    scope: 'United States',
    source: 'Bureau of Land Management · USDA Forest Service',
    subsections: [
      {
        id: 'blm-stay-limits',
        title: 'Stay limits',
        entries: [
          {
            term: '14 days in 28',
            text: 'Most BLM and Forest Service land allows free camping for up to 14 days within any 28-day period.'
          },
          {
            term: 'Then move on',
            text: 'After the limit you are generally required to move at least 25 miles away. Shuffling a few hundred feet down the same road does not reset the clock.'
          },
          {
            term: 'Some districts are stricter',
            text: 'Heavily used areas cut the limit — often to 7 days, occasionally less — and post it at the access road.'
          }
        ],
        caveat: 'Stay limits are set locally. The district office is the authority, not this page.'
      },
      {
        id: 'blm-where-to-camp',
        title: 'Where to put your camp',
        entries: [
          { term: 'Use what exists', text: 'Camp on an existing pullout, bare ground, or a previously used site with an established fire ring. Do not create a new clearing or cut live vegetation.' },
          { term: '200 feet from water', text: 'Keep camp at least 200 feet (about 70 paces) from lakes, streams and springs. It protects the bank and leaves wildlife a route to drink.' },
          { term: 'Off the road', text: 'Park clear of the travelled way so trucks, trailers and emergency vehicles can pass.' },
          { term: 'Away from developed sites', text: 'Dispersed camping is usually prohibited within a set distance of campgrounds, day-use areas and trailheads.' }
        ]
      },
      {
        id: 'blm-vehicles',
        title: 'Roads, vehicles and the MVUM',
        entries: [
          {
            term: 'The MVUM is the rulebook',
            text: 'Each National Forest publishes a free Motor Vehicle Use Map showing which roads are legally open, to what kind of vehicle, and in which season. If a route is not on it, driving it is a violation.'
          },
          {
            term: 'Distance from the road',
            text: 'Many forests allow you to pull only a short distance — often one vehicle length — off a designated route to camp. Some allow none at all.'
          },
          { term: 'Stay on the tread', text: 'Driving around a puddle widens the road permanently. Go through it or turn back.' }
        ]
      },
      {
        id: 'blm-permits',
        title: 'Permits and fees',
        entries: [
          { term: 'Dispersed camping is free', text: 'On most BLM and Forest Service land you pay nothing to camp outside a developed campground.' },
          { term: 'Exceptions exist', text: 'High-demand areas run permit systems and quotas. Wilderness areas, some canyons, and popular desert districts all require a permit booked in advance.' },
          { term: 'Groups', text: 'Large groups usually need a special recreation permit regardless of where they camp.' }
        ]
      }
    ],
    links: [
      { label: 'BLM camping regulations', href: 'https://www.blm.gov/programs/recreation/camping' },
      { label: 'US Forest Service', href: 'https://www.fs.usda.gov/' },
      { label: 'Recreation.gov permits', href: 'https://www.recreation.gov/' }
    ]
  },

  /* ---------------------------------------------------------------- *
   * Alberta PLUZ                                                      *
   * ---------------------------------------------------------------- */
  {
    id: 'alberta-pluz',
    title: 'Alberta Public Land Use Zones (PLUZ)',
    summary:
      'Alberta manages parts of its public land as PLUZs — zones with their own camping, fire, vehicle and trail rules layered on top of ordinary Crown land.',
    icon: 'shield',
    accent: 'cyan',
    scope: 'Alberta, Canada',
    source: 'Alberta Environment and Protected Areas',
    subsections: [
      {
        id: 'pluz-recreation-environment',
        title: 'General recreation & environment',
        entries: [
          {
            term: 'Leave No Trace',
            text: 'Follow all signs and the directions of Enforcement Officers. Pack out all garbage. Leave plants, fossils, rocks and artifacts where you found them.'
          },
          {
            term: 'Pets & wildlife',
            text: 'Pets are allowed, but you must clean up after them and keep them from chasing wildlife or people. Never approach or feed wildlife.'
          },
          {
            term: 'Water protection',
            text: 'Dumping sediment, pollution, gray water or sewage into water or onto ice is strictly prohibited.'
          }
        ]
      },
      {
        id: 'pluz-camping-campfires',
        title: 'Camping & campfires',
        entries: [
          {
            term: 'Passes & limits',
            text: 'A Public Lands Camping Pass is required for random camping along the Eastern Slopes. Stays are capped at 14 days per spot, after which you must move at least 1 km away for 72 hours. Equipment must be temporary and portable.'
          },
          {
            term: 'Prohibited zones',
            text: 'No camping or open fires within 1 km of a public or provincial recreation area inside a PLUZ. Camping and fires are also banned within 1 km of roads in the Kananaskis, McLean Creek, Sibbald Snow and Cataract Creek PLUZs.'
          },
          {
            term: 'Fire safety',
            text: 'Campfires are allowed for cooking and warming unless a fire ban is active. They must never be left unattended, and must be soaked, stirred, and soaked again until cool to the touch.'
          }
        ]
      },
      {
        id: 'pluz-motorized',
        title: 'Motorized vehicles',
        entries: [
          {
            term: 'Trail rules',
            text: 'Highway vehicles cannot leave the road except on designated Off-Highway Vehicle (OHV) trails. OHVs must match the designated vehicle type and width, and must stay strictly on the trail tread.'
          },
          {
            term: 'Water restrictions',
            text: 'Keep wheels out of the water. Motorized users cannot drive on the beds or shores of waterbodies and wetlands except at a designated crossing.'
          },
          {
            term: 'Exemptions',
            text: 'Emergency transports, government operations, and permitted trapping, industrial and research activities are exempt from some motorized restrictions.'
          }
        ]
      },
      {
        id: 'pluz-equestrian',
        title: 'Non-motorized & equestrian use',
        entries: [
          {
            term: 'Horses',
            text: 'To prevent erosion and contamination, grazing and tethering horses is prohibited within 100 metres of lakes and streams in some PLUZs — high-lining is encouraged instead. Some zones require riders to bring weed-free supplemental feed to prevent overgrazing and the spread of noxious weeds.'
          }
        ]
      },
      {
        id: 'pluz-provincial-trails',
        title: 'Designated trail specifics (provincial trails)',
        entries: [
          {
            term: 'No obstructions',
            text: 'You cannot leave vehicles, bicycles or camping units unattended on the trail tread itself.'
          },
          {
            term: 'Firearms',
            text: 'Recreational target shooting is prohibited within 400 metres of a provincial trail. Discharging a firearm is only allowed if you are legally hunting under the Wildlife Act.'
          },
          {
            term: 'Pets',
            text: 'Certain provincial trails have strict leash requirements, and some prohibit pets entirely.'
          }
        ]
      },
      {
        id: 'pluz-hunting-fishing',
        title: 'Hunting & sportfishing',
        entries: [
          {
            term: 'Compliance',
            text: 'Standard hunting and sportfishing regulations apply. Hunters are responsible for knowing where Wildlife Management Units (WMUs) overlap with PLUZs, as vehicle access restrictions may still apply.'
          }
        ]
      },
      {
        id: 'pluz-development',
        title: 'Development & land structures',
        entries: [
          {
            term: 'Approvals required',
            text: 'Building, maintaining or modifying trails — adding mountain bike features, for example — or putting up any structure on public land without prior approval from Environment and Protected Areas (EPA) violates the Public Lands Act and can result in enforcement action.'
          }
        ]
      },
      {
        id: 'pluz-enforcement',
        title: 'Enforcement',
        entries: [
          {
            term: 'Reporting',
            text: 'Violating PLUZ rules can result in prosecution by patrolling Conservation Officers, RCMP or Sheriffs. Report illegal activity or safety incidents to 310-LAND (310-5263) at any time.'
          }
        ]
      },
      {
        id: 'pluz-pass',
        title: 'The Public Lands Camping Pass',
        entries: [
          { term: 'Who needs one', text: 'Anyone 18 or over random camping in the Eastern Slopes pass area, which includes the Ghost, McLean Creek and Porcupine Hills PLUZs among others.' },
          { term: 'Cost', text: '$20 per person for three days, or $30 per person for the year.' },
          { term: 'Where to buy', text: 'Online through AlbertaRELM, before you arrive.' },
          { term: 'Day use', text: 'Parking or recreating during the day does not require a camping pass.' }
        ],
        caveat: 'Pass boundaries and prices are set by the province and can change between seasons.'
      }
    ],
    links: [
      { label: 'Alberta PLUZ information', href: 'https://www.alberta.ca/public-land-use-zones' },
      { label: 'Buy a camping pass (AlbertaRELM)', href: 'https://www.albertarelm.com/' },
      { label: 'Alberta fire bans', href: 'https://www.albertafirebans.ca/' }
    ]
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'crown-land',
    title: 'Canadian Crown Land',
    summary: 'Free camping on provincial Crown land, and the residency rules that catch visitors out.',
    icon: 'trees',
    accent: 'sky',
    scope: 'Canada',
    source: 'Provincial land management ministries',
    subsections: [
      {
        id: 'crown-ontario',
        title: 'Ontario',
        entries: [
          {
            term: '21 days',
            text: 'Canadian residents may camp free on most Crown land for up to 21 days at any one site in a calendar year.'
          },
          {
            term: 'Non-residents need a permit',
            text: 'Visitors who are not residents of Canada require a Crown land camping permit to camp on Crown land in much of Northern Ontario.'
          },
          {
            term: 'Not all Crown land is open',
            text: 'Some parcels are withdrawn from camping, licensed to other users, or closed seasonally. Crown land is also interleaved with private property.'
          }
        ]
      },
      {
        id: 'crown-coverage',
        title: 'What this app actually knows',
        entries: [
          {
            term: 'Two provinces of boundary data',
            text: 'Wandrlust currently carries Crown land boundaries for Ontario and Alberta only. Everywhere else in Canada is recorded as a coverage gap.'
          },
          {
            term: 'A gap is not an answer',
            text: 'If no polygon appears, it means nobody has loaded data for that area. It does not mean the land is private, and it does not mean camping is allowed.'
          }
        ],
        caveat: 'Rules differ substantially between provinces. Check with the provincial ministry for anywhere outside Ontario and Alberta.'
      }
    ],
    links: [{ label: 'Ontario Crown land camping', href: 'https://www.ontario.ca/page/crown-land-camping' }]
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'fire',
    title: 'Campfires & Wildfire',
    summary: 'The rules that change most often, and the ones with the worst consequences.',
    icon: 'flame',
    accent: 'rose',
    subsections: [
      {
        id: 'fire-before',
        title: 'Before you light one',
        entries: [
          { term: 'Check the ban', text: 'Fire restrictions are issued by district and change through the season. Stage 1 typically restricts fires to established rings; stage 2 usually bans open flame entirely, sometimes including gas stoves.' },
          { term: 'Permits', text: 'Some jurisdictions require a permit even when fires are allowed. In California a free online campfire permit is required for any open flame or portable gas stove on public land.' },
          { term: 'Wind', text: 'If wind is carrying sparks past the edge of the ring, the answer is no fire tonight, ban or not.' },
          { term: 'Firewood', text: 'Buy or gather locally. Moving firewood moves the insects killing forests. Never cut standing trees, live or dead.' }
        ]
      },
      {
        id: 'fire-during',
        title: 'Building and putting it out',
        entries: [
          { term: 'Use an existing ring', text: 'Do not build new ones. Clear flammable material well back from the edge.' },
          { term: 'Keep it small', text: 'A cooking fire does everything a bonfire does, with a fraction of the risk.' },
          { term: 'Never unattended', text: 'Not for a walk to the truck, not while you sleep.' },
          { term: 'Drown, stir, drown', text: 'Soak it, stir the ashes, soak it again, and keep going until it is cool to the touch. If it is too hot to hold your hand in, it is still alight.' }
        ],
        caveat: 'An escaped campfire can make you liable for the cost of fighting the fire.'
      }
    ],
    links: [
      { label: 'US fire restrictions', href: 'https://www.nifc.gov/fire-information/fire-restrictions' },
      { label: 'Alberta fire bans', href: 'https://www.albertafirebans.ca/' }
    ]
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'waste',
    title: 'Waste, Toilets & Gray Water',
    summary: 'Where it goes when there is no bin and no vault toilet.',
    icon: 'trash',
    accent: 'violet',
    subsections: [
      {
        id: 'waste-trash',
        title: 'Rubbish',
        entries: [
          { term: 'Pack out everything', text: 'Including food scraps, orange peel, and the ash and foil from your fire ring.' },
          { term: 'Burning trash does not work', text: 'It leaves melted plastic and foil in the ring for the next person, and it is prohibited on most public land.' },
          { term: 'Leave it better', text: 'Carrying out somebody else\'s litter is the cheapest way to keep a site open.' }
        ]
      },
      {
        id: 'waste-human',
        title: 'Human waste',
        entries: [
          {
            term: 'WAG bags where required',
            text: 'In fragile desert areas — Moab BLM, Alabama Hills, Grand Staircase-Escalante and others — carrying a portable toilet or approved WAG bag system is legally required. Cat-holes are not permitted in high-impact red rock soils.'
          },
          {
            term: 'Cat-holes where permitted',
            text: 'Where they are allowed, dig 6 to 8 inches deep, at least 200 feet from water, camp and trails, and cover it completely afterwards.'
          },
          { term: 'Toilet paper comes out', text: 'Buried paper gets dug up by animals and blows around for years. Bag it.' },
          { term: 'Black tanks', text: 'Dump only at a sanitary dump station. Emptying a tank on the ground is a serious offence everywhere.' }
        ]
      },
      {
        id: 'waste-gray',
        title: 'Gray water',
        entries: [
          { term: 'Never into water', text: 'Dish and wash water does not go into a lake, a stream, or onto ice.' },
          { term: 'Strain and scatter', text: 'Where disposal on the ground is permitted, strain out the food solids, pack them out, and scatter the water widely at least 200 feet from any water source.' },
          { term: 'Soap', text: 'Even biodegradable soap needs soil to break down. Use it sparingly and well away from streams.' }
        ]
      }
    ]
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'wildlife',
    title: 'Wildlife & Food Storage',
    summary: 'Keeping animals wild, and your camp uneventful.',
    icon: 'paw',
    accent: 'amber',
    subsections: [
      {
        id: 'wildlife-food',
        title: 'Food storage',
        entries: [
          { term: 'Hard-sided storage', text: 'In bear country, food, rubbish and anything scented goes in a locked vehicle, a bear box, or an approved canister overnight.' },
          { term: 'Canisters can be mandatory', text: 'Some areas require an approved bear canister and will not accept a hung bag as compliance.' },
          { term: 'Scented is not just food', text: 'Toothpaste, sunscreen, soap, and the clothes you cooked in all count.' },
          { term: 'Cook away from the tent', text: 'A hundred feet downwind if the terrain allows it.' }
        ]
      },
      {
        id: 'wildlife-encounters',
        title: 'Encounters',
        entries: [
          { term: 'Never feed anything', text: 'A fed animal becomes a problem animal, and problem animals are destroyed.' },
          { term: 'Give room', text: 'If an animal changes its behaviour because of you, you are already too close.' },
          { term: 'Carry deterrent where it is warranted', text: 'And know how to use it before you need it.' },
          { term: 'Pets on a lead', text: 'A loose dog that finds a bear brings the bear back to you.' }
        ]
      }
    ]
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'leave-no-trace',
    title: 'Leave No Trace',
    summary: 'The seven principles, in the order they tend to matter.',
    icon: 'leaf',
    accent: 'emerald',
    source: 'Leave No Trace Center for Outdoor Ethics',
    subsections: [
      {
        id: 'lnt-principles',
        title: 'The seven principles',
        entries: [
          { term: 'Plan ahead and prepare', text: 'Most damage is done by people who arrived without a plan and improvised.' },
          { term: 'Travel and camp on durable surfaces', text: 'Rock, gravel, dry grass and existing sites. Not meadow, not cryptobiotic crust.' },
          { term: 'Dispose of waste properly', text: 'Pack it out. All of it.' },
          { term: 'Leave what you find', text: 'Rocks, plants, antlers, artifacts and fossils stay where they are.' },
          { term: 'Minimise campfire impacts', text: 'Use a stove when you can; keep fires small and in existing rings when you cannot.' },
          { term: 'Respect wildlife', text: 'Watch from a distance, store food, never feed.' },
          { term: 'Be considerate of other visitors', text: 'Quiet, distance, and dark skies are why people came out here.' }
        ]
      }
    ],
    links: [{ label: 'Leave No Trace Center', href: 'https://lnt.org/' }]
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'safety',
    title: 'Safety & Communication',
    summary: 'What to do about being a long way from help.',
    icon: 'alert',
    accent: 'rose',
    subsections: [
      {
        id: 'safety-comms',
        title: 'Communication',
        entries: [
          { term: 'Assume no signal', text: 'Cell coverage estimates in this app are crowd-reported and frequently wrong. Plan as though you have none.' },
          { term: 'Leave a plan', text: 'Tell someone where you are going and when you will be back. It is the single most useful thing you can do.' },
          { term: 'Satellite messengers', text: 'A device with SOS is the difference between an inconvenience and an emergency in most dispersed camping areas.' }
        ]
      },
      {
        id: 'safety-conditions',
        title: 'Conditions',
        entries: [
          { term: 'Flash flooding', text: 'Do not camp in a wash, a slot, or on a low bench. Rain miles away arrives without warning.' },
          { term: 'Widowmakers', text: 'Look up before you pitch. Dead standing timber and hanging limbs come down in wind.' },
          { term: 'Heat and cold', text: 'Desert nights and mountain nights are both colder than the forecast for the nearest town.' },
          { term: 'Hazard alerts here are best-effort', text: 'Wandrlust pulls fire, flood and storm alerts from government feeds. Those feeds go down, lag, and do not cover everything. No alert on screen is not an all-clear.' }
        ]
      }
    ]
  },

  /* ---------------------------------------------------------------- */
  {
    id: 'etiquette',
    title: 'Neighbours & Etiquette',
    summary: 'Dispersed camping stays legal because campers behave.',
    icon: 'users',
    accent: 'sky',
    subsections: [
      {
        id: 'etiquette-neighbours',
        title: 'Sharing the ground',
        entries: [
          { term: 'Distance is the courtesy', text: 'If there is room to camp out of sight and earshot, take it.' },
          { term: 'Generators and music', text: 'Both carry much further than they seem to. Keep them to daylight hours, or leave them off.' },
          { term: 'Lights down', text: 'Aim your lighting at the ground. Dark sky is the reason a lot of people are out there.' },
          { term: 'Drive slow through camp', text: 'Dust settles on everything, including other people\'s dinner.' },
          { term: 'Access roads and gates', text: 'Leave gates as you found them, and never block a road, a trailhead or a pullout.' }
        ]
      }
    ]
  }
];

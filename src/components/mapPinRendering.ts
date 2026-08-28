/**
 * Pin & marker rendering — the icon builders, the expand/collapse chip
 * "unfurl" DOM mini-framework, pin action rows, and the geometry helpers
 * that feed them (bounding-box sizing, destination land labels).
 *
 * Split out of MapComponent.tsx purely to make that file smaller; nothing
 * here behaves any differently than it did inline. This is DOM-string and
 * Leaflet-icon building, not React — MapComponent calls into it, it never
 * calls back.
 */
import L from 'leaflet';
import type {
  FacilityKind, FacilityLookupState, BeaconSpot, MapFacility, DestinationLand
} from '../types';
import { HazardRecord } from '../services/dataService';
import { hazardReportStyle, reportStanding } from '../config/hazardReports';
import { beaconTierStyle } from '../config/beacon';
import { facilitySourceStyle } from '../config/facilities';
import {
  BoundaryCollection, BoundaryFeature, BOUNDARY_GROUP_STYLES, boundaryGroupOf
} from '../services/boundaryService';
import { FACILITY_GLYPH } from '../services/nearbyAmenityService';
import { directionsAppName } from '../utils/handoff';
import { localizedPinHtml } from '../utils/alertOverlay';
import { MarkerDot, FACILITY_COLOR } from '../utils/amenityDots';

export const TENT_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px">' +
  '<path d="M19 20 12 4 5 20"/><path d="M12 4v16"/><path d="M2 20h20"/></svg>';

/**
 * A spot a camper added themselves.
 *
 * TWO STATES, AND THE WHOLE INTERFACE HANGS OFF THE DIFFERENCE.
 *
 * HOLLOW is the resting state: a ring, not a blob. A screenful of solid
 * discs is a screenful of paint over the terrain a camper is trying to read,
 * and every one of them shouts equally hard. A ring lets the ground through
 * and still reads as "a spot is here" at a glance.
 *
 * FILLED is the tapped state: the ring floods with colour and pops once, so
 * "the one I chose" is unmistakable among its neighbours without the others
 * having to dim.
 *
 * Above the pin, either way, sits a row of small coloured dots — one per fact
 * recorded about the spot, hazards first. That row is what used to be a
 * legend in the corner of the map. Tapped, each dot expands into the words it
 * stood for, so the key to the colours is on the thing the colours describe.
 *
 * A dot only ever stands for something somebody recorded. See `amenityDots`.
 */
/**
 * Resting: colour only, no words. The pin is the label.
 *
 * Only a live hazard breathes. Everything else — including a recorded "no
 * water" — is bad news that already happened and holds still, so the one dot
 * that is moving on a screenful of pins is always something burning, blowing
 * or freezing right now.
 */
/**
 * THEY GO ROUND THE PIN, NOT ABOVE IT — AND EVERY FACT GETS ONE.
 *
 * A row above the marker could only ever hold four or five dots before it was
 * wider than the pin and colliding with the row over the next spot along, so
 * everything past the fourth fact became a grey "+n" that said nothing. There
 * is no cap now: a spot with nine recorded facts shows nine beads, because the
 * count itself is information — a pin wearing a full ring is a well-equipped
 * spot at a glance.
 *
 * The ring GROWS to fit rather than the beads crowding: at the base radius the
 * circumference seats about twelve dots with air between them, and past that
 * the radius is widened so the gap stays constant however many there are.
 *
 * Placed with a translate rather than a rotate so the dot itself is never
 * rotated — and on an outer slot rather than on the dot, because the urgent
 * dot's breathing is a `transform: scale` and would otherwise wipe out its
 * position.
 */
export const RING_RADIUS_PX = 19;
/** Dot plus the gap after it — the arc one bead is allowed to occupy. */
export const RING_BEAD_PITCH_PX = 10;

export const collapsedDotRing = (dots: MarkerDot[]): string => {
  if (!dots.length) return '';
  // Widen the ring rather than let beads touch once the circle is full.
  const radius = Math.max(RING_RADIUS_PX, (dots.length * RING_BEAD_PITCH_PX) / (2 * Math.PI));
  const step = 360 / dots.length;
  const cells = dots
    .map((d, i) => {
      // Clockwise from the top, so the first fact — always the most urgent
      // one, since hazards lead the list — sits at twelve o'clock.
      const angle = ((-90 + i * step) * Math.PI) / 180;
      const x = (Math.cos(angle) * radius).toFixed(1);
      const y = (Math.sin(angle) * radius).toFixed(1);
      return (
        `<i class="wl-dot-slot" style="transform:translate(${x}px,${y}px)">` +
        `<i class="wl-dot${d.urgent ? ' wl-dot-urgent' : ''}` +
        `${d.hollow ? ' wl-dot-hollow' : ''}" ` +
        `style="--wl-dot-color:${d.color}"></i></i>`
      );
    })
    .join('');

  return `<div class="wl-dots">${cells}</div>`;
};

/**
 * Escape text before it goes into a divIcon's HTML.
 *
 * A chip's label carries an OpenStreetMap facility name and a campsite's
 * recorded facts, so the worst realistic case is a malformed upstream record —
 * but it lands in innerHTML, so it gets escaped.
 */
export const escapeHtml = (s: string): string => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/**
 * The outline of a shape, as Leaflet wants it: the biggest ring, `[lat, lon]`.
 *
 * A cloud piece is a MultiPolygon — several parcels the grouping pulled
 * together — and the tracker follows the largest of them. Not all of them:
 * a dot that teleported between blocks would read as several separate things
 * being pointed at rather than one area being outlined. Holes are ignored for
 * the same reason; the softened cloud fills them in anyway.
 */
export const outerRing = (shape: GeoJSON.Feature): [number, number][] => {
  const geometry = shape.geometry as { type?: string; coordinates?: unknown };
  const polygons: [number, number][][][] =
    geometry?.type === 'MultiPolygon'
      ? (geometry.coordinates as [number, number][][][])
      : geometry?.type === 'Polygon'
        ? [geometry.coordinates as [number, number][][]]
        : [];

  let best: [number, number][] = [];
  let bestArea = -1;
  polygons.forEach((rings) => {
    const ring = rings?.[0];
    if (!Array.isArray(ring) || ring.length < 4) return;
    // Shoelace, in square degrees. Only ever compared against itself.
    let twice = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      twice += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    const area = Math.abs(twice) / 2;
    if (area > bestArea) { bestArea = area; best = ring; }
  });

  // GeoJSON counts [lon, lat]; everything Leaflet takes is the other way round.
  return best.map(([lon, lat]) => [lat, lon] as [number, number]);
};

/**
 * Tapped: the same dots, each grown into the fact it stood for.
 *
 * The chip is short — a glyph and two or three words — and the whole hedged
 * sentence rides along in `title`, so the caveats are a press away without a
 * paragraph lying across the map.
 *
 * A chip carrying a facility, or an action, is a button rather than a label —
 * it is somewhere you can go, so it opts back into pointer events and carries
 * the id for the delegated click handler.
 *
 * EVERY CHIP POPS, AND EACH ONE POPS EXACTLY ONCE.
 *
 * The row is rebuilt every time a lookup lands — the tap, then the fires,
 * then the weather, then whatever OpenStreetMap has up the road — so "animate
 * the row" and "animate nothing" are both wrong: the first restarts chips
 * that are already sitting there (popcorn), the second means the answers that
 * arrive after the tap simply blink into existence.
 *
 * So the animation is decided per chip, by whether this pin has shown that
 * chip before. `animateKeys` is that set of first-timers, and the stagger is
 * counted across them alone, which is why opening a pin plays the whole stack
 * in sequence while a toilet found two seconds later pops on its own.
 *
 * Chips that have already arrived carry no animation class at all, so the
 * next rebuild leaves them exactly where they are.
 */
/** The beat between one chip landing and the next, in ms. */
export const CHIP_STAGGER_MS = 55;
/**
 * Everything waits this long before starting.
 *
 * Without it the first chip is on screen in the frame the pin opens, which is
 * the "some of them are just there" complaint: the stack has to start from
 * nothing for the sequence to read as a sequence.
 */
export const CHIP_LEAD_MS = 70;

/**
 * Everything about a chip that is visible, as one string.
 *
 * Compared before a chip is touched, so a lookup landing with the same answer
 * leaves the existing element — and any pop it is halfway through — alone.
 */
export const chipSignature = (d: MarkerDot): string => [
  d.color, d.label, d.full ?? '', d.glyph, d.tone,
  d.hollow ? 'h' : '', d.action ?? '', d.badge ?? '', d.facility?.id ?? ''
].join('\u0001');

/**
 * EVERY CHIP IS A BUTTON, AND EVERY CHIP LOOKS LIKE ONE.
 *
 * There used to be two kinds: a facility or the fire count, which were
 * tappable and wore an arrow, and everything else, which was a label that
 * swallowed nothing. That teaches the wrong lesson — a camper who has learned
 * that most chips do nothing stops trying the ones that do.
 *
 * So all of them take taps, and the mark on the right says what kind of answer
 * to expect:
 *
 *   ›   takes the camera to the thing the chip is talking about — the warning
 *       area, the parcel, the track in, the fires — and brings it back.
 *   …   has more to say than fits, and unfurls into the whole hedged sentence
 *       in place.
 *
 * That second one matters more than it looks. The caveats — that a signal
 * estimate is a distance to a mast with the terrain ignored, that a recorded
 * "no water" is one camper's visit — lived in the `title` attribute, which on
 * a phone means nowhere at all.
 */
export const chipHtml = (d: MarkerDot, fresh: boolean, delay: number): string => {
  const go = d.facility;
  const travels = Boolean(d.action) || Boolean(go);
  const full = d.full ?? d.label;
  return (
    `<span class="wl-chip${d.tone === 'bad' ? ' wl-chip-bad' : ''}` +
    `${travels ? ' wl-chip-go' : ''}` +
    `${d.action === 'directions' ? ' wl-chip-nav' : ''}` +
    `${fresh ? ' wl-chip-in' : ''}" ` +
    `data-key="${escapeHtml(d.key)}" data-sig="${escapeHtml(chipSignature(d))}" ` +
    `data-label="${escapeHtml(d.label)}" data-full="${escapeHtml(full)}" ` +
    `${go ? `data-facility="${escapeHtml(go.id)}" ` : ''}` +
    `${d.action ? `data-action="${d.action}" ` : ''}` +
    `${d.badge ? `data-badge="${escapeHtml(d.badge)}" ` : ''}` +
    `role="button" tabindex="0" ` +
    `title="${escapeHtml(full)}" aria-label="${escapeHtml(full)}" ` +
    `style="--wl-chip-color:${d.color}` +
    `${fresh ? `;animation-delay:${delay}ms` : ''}">` +
    `<i class="wl-chip-dot${d.hollow ? ' wl-chip-dot-hollow' : ''}"></i>` +
    `<span class="wl-chip-glyph" aria-hidden="true">${d.glyph}</span>` +
    `<span class="wl-chip-text">${escapeHtml(d.label)}</span>` +
    `<span class="wl-chip-arrow" aria-hidden="true">${travels ? '›' : '…'}</span>` +
    `</span>`
  );
};

/**
 * When each arriving chip pops, counted from the BOTTOM of the stack.
 *
 * The row is a column anchored above the pin, so the LAST chip in DOM order
 * sits nearest the pin and the first sits highest. Staggering in DOM order
 * therefore ran the wave downwards, from the sky into the pin, which reads as
 * falling. Stacking is the other way round: the chip nearest the pin lands
 * first and each one after it piles on top.
 *
 * Returned as a map rather than computed inline because `expandedDotRow` and
 * `patchChipRow` both need the same answer, and two copies of a rule about
 * timing drift into two slightly different animations.
 */
export const chipDelays = (dots: MarkerDot[], animateKeys: Set<string>): Map<string, number> => {
  const freshInOrder = dots.filter((d) => animateKeys.has(d.key));
  const delays = new Map<string, number>();

  freshInOrder.forEach((d, i) => {
    // Reverse the index: the last fresh chip (nearest the pin) goes first.
    const fromBottom = freshInOrder.length - 1 - i;
    delays.set(d.key, CHIP_LEAD_MS + fromBottom * CHIP_STAGGER_MS);
  });

  return delays;
};

/** The chips alone, with no row around them. The peek builds its own row. */
export const chipsHtml = (dots: MarkerDot[], animateKeys: Set<string>): string => {
  const delays = chipDelays(dots, animateKeys);
  return dots
    .map((d) => chipHtml(d, animateKeys.has(d.key), delays.get(d.key) ?? 0))
    .join('');
};

export const expandedDotRow = (dots: MarkerDot[], animateKeys: Set<string>): string =>
  `<div class="wl-chips">${chipsHtml(dots, animateKeys)}</div>`;

/**
 * Add the chips that are new, leave the ones already there completely alone.
 *
 * THIS IS WHY THE PIN NO LONGER FLICKERS. Leaflet's own way to change a
 * marker is `setIcon`, which throws the marker's whole DOM away and builds it
 * again — the pin, the buttons and every chip. A pin answers in four or five
 * instalments (the tap, the fires, the weather, the facilities, the road), so
 * that was four or five full rebuilds in a couple of seconds: the pin blinked
 * each time, and any chip mid-pop was destroyed and replaced by a finished
 * one, which is exactly "some of them just appear".
 *
 * So updates are patched into the existing row instead, keyed by chip. A chip
 * whose wording has not changed keeps its element, its animation and its
 * place; a chip that has gone is removed; a chip that is new is built with
 * the pop on it and slotted into position. Nothing else in the marker is
 * touched, so the pin itself never redraws.
 *
 * Returns false if the marker is not on screen (clustered away, or not yet
 * added), in which case the caller falls back to rebuilding the icon.
 */
/**
 * Measure, change, then slide whatever moved into its new place.
 *
 * The stack is anchored under the pin and grows upwards, so a chip arriving
 * anywhere in it shoves every chip above it up by its own height — instantly,
 * because that is a layout change and layout does not animate. Four lookups
 * landing meant four of those jolts while the camper was reading.
 *
 * FLIP: note where each chip was, let the change happen, then put each chip
 * back where it started with a transform and release it on the next frame, so
 * it travels to its new home on the same curve everything else in the app uses.
 * A chip halfway through its own arrival pop is left alone — its animation owns
 * the transform, and it has nowhere to slide from anyway.
 */
export const flipRow = (row: Element, mutate: () => void): void => {
  const before = new Map<HTMLElement, number>();
  row.querySelectorAll<HTMLElement>(':scope > .wl-chip').forEach((el) => {
    before.set(el, el.getBoundingClientRect().top);
  });

  mutate();

  before.forEach((top, el) => {
    if (!el.isConnected) return;
    const dy = top - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) return;
    el.style.transition = 'none';
    el.style.transform = `translateY(${dy}px)`;
    // Two frames: the first commits the offset, the second releases it. One is
    // not enough — the browser coalesces both writes and nothing moves.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transition = 'transform var(--dur-base) var(--ease-moook)';
        el.style.transform = '';
      });
    });
  });
};

export const patchChipRow = (
  root: HTMLElement | null | undefined,
  dots: MarkerDot[],
  animateKeys: Set<string>
): boolean => {
  const wrap = root?.firstElementChild;
  if (!wrap) return false;

  let row = wrap.querySelector(':scope > .wl-chips');
  const existed = Boolean(row);
  if (!row) {
    if (!dots.length) return true;
    row = document.createElement('div');
    row.className = 'wl-chips';
    wrap.insertBefore(row, wrap.firstChild);
  }
  const target = row;

  const rebuild = (): void => {
    const existing = new Map<string, Element>();
    target.querySelectorAll(':scope > .wl-chip').forEach((el) => {
      const key = el.getAttribute('data-key');
      if (key) existing.set(key, el);
    });

    const wanted = new Set<string>();
    const delays = chipDelays(dots, animateKeys);
    let placed: Element | null = null;

    for (const d of dots) {
      wanted.add(d.key);
      const fresh = animateKeys.has(d.key);
      const delay = fresh ? delays.get(d.key) ?? CHIP_LEAD_MS : 0;
      let node = existing.get(d.key) ?? null;

      if (!node || fresh || node.getAttribute('data-sig') !== chipSignature(d)) {
        const holder = document.createElement('template');
        holder.innerHTML = chipHtml(d, fresh, delay);
        const next = holder.content.firstElementChild;
        if (!next) continue;
        if (node) node.replaceWith(next);
        node = next;
      }

      // Only move a chip that is genuinely out of order: re-inserting an
      // element restarts its animation, which is the popcorn all over again.
      const slot = placed ? placed.nextElementSibling : target.firstElementChild;
      if (node !== slot) target.insertBefore(node, slot);
      placed = node;
    }

    existing.forEach((el, key) => { if (!wanted.has(key)) el.remove(); });
  };

  // A row being built from nothing has nothing to slide — that case is the
  // whole stack arriving, which is the pop.
  if (existed) flipRow(target, rebuild);
  else rebuild();

  if (!dots.length) target.remove();
  return true;
};

/**
 * Show or hide the "more is coming" placeholder at the top of a pin's chip
 * stack, while its nearby-facility lookup is still in flight.
 *
 * Deliberately separate from `patchChipRow`'s own row: that one is rebuilt
 * and sometimes torn down entirely whenever `dots` is empty (`target.remove()`
 * above), which is exactly the moment this placeholder needs to survive — a
 * freshly opened pin usually HAS no chips yet, that's the whole reason to
 * show it. So this manages its own element, keyed by class rather than by
 * `data-key`, which is also what keeps `patchChipRow`'s key-diffing cleanup
 * from ever seeing — and removing — it.
 */
export const setChipsLoading = (
  root: HTMLElement | null | undefined, loading: boolean
): void => {
  const wrap = root?.firstElementChild;
  if (!wrap) return;

  let row = wrap.querySelector(':scope > .wl-chips');
  const existing = row?.querySelector(':scope > .wl-chip-loading') ?? null;

  if (!loading) {
    existing?.remove();
    // Nothing left in a row that only ever held this placeholder.
    if (row && row.children.length === 0) row.remove();
    return;
  }
  if (existing) return;

  if (!row) {
    row = document.createElement('div');
    row.className = 'wl-chips';
    wrap.insertBefore(row, wrap.firstChild);
  }
  const chip = document.createElement('span');
  chip.className = 'wl-chip-loading';
  chip.setAttribute('aria-hidden', 'true');
  chip.innerHTML =
    '<span class="wl-chip-loading-dot"></span>' +
    '<span class="wl-chip-loading-dot"></span>' +
    '<span class="wl-chip-loading-dot"></span>';
  row.insertBefore(chip, row.firstChild);
};

/**
 * Take a stack away, top chip first, and say how long that will take.
 *
 * The wave came up from the pin outwards, so it leaves from the loose end
 * inwards: the top chip goes first and the one resting on the pin goes last.
 * Dismantling it in the order it was built looks like the bottom being pulled
 * out from under the rest.
 */
export const retractChips = (row: Element): number => {
  const chips = Array.from(row.querySelectorAll<HTMLElement>(':scope > .wl-chip'));

  chips.forEach((chip, i) => {
    chip.classList.remove('wl-chip-in');
    chip.style.animationDelay = `${i * PEEK_OUT_STAGGER_MS}ms`;
    chip.classList.add('wl-chip-out');
  });

  return chips.length * PEEK_OUT_STAGGER_MS + PEEK_OUT_DURATION_MS;
};

/* ------------------------------------------------------------------ */
/* The press-and-hold peek                                             */
/* ------------------------------------------------------------------ */

/**
 * Hold a pin down and its chips rise; let go and they fall away again.
 *
 * ---------------------------------------------------------------------------
 * WHY A PEEK RATHER THAN JUST TAPPING THE PIN
 * ---------------------------------------------------------------------------
 *
 * Tapping selects a spot: it flies the camera, opens the sheet, fetches
 * weather, fires, signal and facilities, and closes whatever was open before.
 * That is the right weight for "I am considering this place" and far too much
 * for "what is that one?" — which, three pins into a scan of a valley, is the
 * question you actually have. The peek answers it without moving the map or
 * disturbing the pin you already had open.
 *
 * ---------------------------------------------------------------------------
 * IT ONLY EVER SHOWS WHAT IS ALREADY KNOWN
 * ---------------------------------------------------------------------------
 *
 * The peek fires no requests. It draws the dots the pin is ALREADY wearing —
 * hazards and the spot's own recorded facilities — grown into their words.
 * That is deliberate twice over: a hold has to answer instantly to feel like
 * a peek rather than a load, and firing weather and OSM lookups at every pin
 * somebody rests a thumb on would hammer four upstream services for a glance.
 *
 * So a peeked pin shows less than a tapped one, and nothing it shows is a
 * guess: it is the same set of facts, in the same words, that the ring of dots
 * was already standing for.
 */

/** How long a press has to last before it counts as a hold, in ms. */
export const PEEK_HOLD_MS = 320;

/** Movement that turns a hold into a map drag, in px. */
export const PEEK_SLOP_PX = 10;

/** The beat between one chip leaving and the next, in ms. */
export const PEEK_OUT_STAGGER_MS = 34;

/** Roughly the duration of --dur-tap, for cleaning up after the retract. */
export const PEEK_OUT_DURATION_MS = 160;

/**
 * Draw the peek stack into a pin that is not open.
 *
 * Built as its own row rather than by reusing `patchChipRow`, because that
 * function is the OPEN pin's incremental updater and shares its memory of
 * which chips have already popped. A peek must always play from nothing, and
 * must never teach the open pin's memory that a chip has been seen.
 */
export const openPeek = (wrap: Element, dots: MarkerDot[]): boolean => {
  if (!dots.length) return false;

  // A peek from a moment ago may still be retracting. Take it out at once and
  // start over, rather than refusing — holding a pin again straight away and
  // getting nothing feels like the gesture is broken.
  wrap.querySelector(':scope > .wl-chips-peek')?.remove();

  // A row that is not a peek belongs to an open pin, and that one has real
  // lookups behind it. Never replace it.
  if (wrap.querySelector(':scope > .wl-chips')) return false;

  const row = document.createElement('div');
  row.className = 'wl-chips wl-chips-peek';
  // Every chip counts as fresh: a peek always plays the whole stack from
  // nothing, because each one is its own separate glance.
  row.innerHTML = chipsHtml(dots, new Set(dots.map((d) => d.key)));

  wrap.insertBefore(row, wrap.firstChild);
  return true;
};

/**
 * Take the peek away, top chip first.
 *
 * The stack came up from the pin outwards, so it goes away from the loose end
 * inwards — the top chip leaves first and the one resting on the pin leaves
 * last. Dismantling it in the same order it was built would look like the
 * bottom being pulled out from under the rest.
 */
export const closePeek = (wrap: Element | null | undefined): void => {
  const row = wrap?.querySelector(':scope > .wl-chips-peek');
  if (!row) return;

  // Removed on a timer rather than on animationend: a chip whose animation
  // never fires — reduced motion, a backgrounded tab, an element detached
  // mid-flight — would otherwise leave the row on the map for ever.
  window.setTimeout(() => row.remove(), retractChips(row));
};

/**
 * The same exit, for the OPEN pin's real stack.
 *
 * Closing a spot used to swap the whole icon on the spot, so the stack of
 * answers vanished between one frame and the next while the hold-to-peek
 * stack — the same chips, in the same column — always wound itself down
 * politely. `onDone` is what actually rebuilds the pin, and it runs after the
 * last chip has gone rather than on top of it.
 */
export const retractChipRow = (
  root: HTMLElement | null | undefined,
  onDone: () => void
): void => {
  const row = root?.firstElementChild?.querySelector(':scope > .wl-chips');
  if (!row || !row.querySelector(':scope > .wl-chip')) { onDone(); return; }
  window.setTimeout(() => { row.remove(); onDone(); }, retractChips(row));
};

/* ------------------------------------------------------------------ */
/* One wave, not four                                                  */
/* ------------------------------------------------------------------ */
/**
 * THE OPEN PIN'S STACK ARRIVES THE WAY THE HELD PIN'S DOES: ALL AT ONCE.
 *
 * A pin answers in instalments — the tap, then the fires, then the weather and
 * the drive, then whatever OpenStreetMap has up the road — and each instalment
 * used to redraw the row the moment it landed. Every chip still popped, but the
 * popping was spread over four separate arrivals a second or two apart, which
 * reads as things dribbling in rather than as a stack being built. The
 * press-and-hold peek looks better for one reason only: it has all its
 * information at the moment it opens, so it plays as a single wave.
 *
 * So arrivals are collected and applied together. A change waits `WAIT` for
 * the next one to join it, and the whole batch goes in as one wave — the same
 * bottom-up stagger the peek plays. `MAX` is the backstop: a slow feed
 * trickling in forever must not hold the answers off the screen indefinitely.
 */
export const CHIP_BATCH_WAIT_MS = 420;
export const CHIP_BATCH_MAX_MS = 1400;

export interface ChipBatcher {
  /** Queue the newest version of the row. Later calls replace earlier ones. */
  schedule: (apply: () => void) => void;
  cancel: () => void;
}

export const createChipBatcher = (): ChipBatcher => {
  let timer: number | null = null;
  let firstAt = 0;
  let pending: (() => void) | null = null;

  const fire = (): void => {
    timer = null;
    firstAt = 0;
    const apply = pending;
    pending = null;
    apply?.();
  };

  return {
    schedule(apply) {
      pending = apply;
      const now = Date.now();
      if (!firstAt) firstAt = now;
      if (timer != null) window.clearTimeout(timer);
      const leftOfMax = Math.max(0, CHIP_BATCH_MAX_MS - (now - firstAt));
      timer = window.setTimeout(fire, Math.min(CHIP_BATCH_WAIT_MS, leftOfMax));
    },
    cancel() {
      if (timer != null) window.clearTimeout(timer);
      timer = null;
      firstAt = 0;
      pending = null;
    }
  };
};

/**
 * Which of these chips this pin has never shown, marking them shown as it
 * goes. Mutates deliberately: the caller's set IS the pin's memory, and it is
 * emptied when the pin closes so opening it again replays the whole stack.
 */
export const freshChipKeys = (shown: Set<string>, dots: MarkerDot[]): Set<string> => {
  const fresh = new Set<string>();
  for (const d of dots) {
    if (shown.has(d.key)) continue;
    fresh.add(d.key);
    shown.add(d.key);
  }
  return fresh;
};

export const INFO_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" style="width:12px;height:12px">' +
  '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.2"/></svg>';

/**
 * A TENT WITH A PLUS ON IT, not a bare plus.
 *
 * The plus alone said "add" and nothing else — add what? The tent is the same
 * shape this app uses for a campsite everywhere else, so the button now says
 * "add a campsite" in the two languages it has: a picture of the thing and,
 * beside it, the words.
 */
export const ADD_SPOT_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" ' +
  'stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px">' +
  '<path d="M10 3 2.5 19h15L10 3z"/><path d="M10 10.5 13.5 19"/>' +
  '<path d="M19 4.5v5M16.5 7h5"/></svg>';

export const CLOSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
  'stroke-linecap="round" style="width:12px;height:12px">' +
  '<path d="M18 6 6 18M6 6l12 12"/></svg>';

/** "Google Maps" or "Apple Maps" — the phone's own app, named on the chip. */
export const DIRECTIONS_LABEL = directionsAppName();

/**
 * The car chip, when there is no route to put on it.
 *
 * Navigation lives on the drive chip now, and the drive chip only exists once
 * a router has answered. Offline, or with every routing engine unreachable,
 * that would leave an open pin with no way to set off at all — so a plain car
 * chip stands in. It claims nothing about the drive, because nothing is known
 * about the drive; it is a door to the phone's own maps app.
 */
export const NAV_DOT: MarkerDot = {
  key: 'nav',
  color: '#93C5FD',
  label: 'Take me there',
  full: `Open this spot in ${DIRECTIONS_LABEL}. No route was worked out here, ` +
    'so nothing about the drive is known yet.',
  glyph: '\u{1F697}',
  tone: 'neutral',
  action: 'directions'
};

/**
 * Put the car chip on the bottom of the stack, where the thumb already is.
 *
 * The stack builds upwards from the pin, so its last entry is the one nearest
 * the pin and nearest the hand. That is the right place for the one chip that
 * leaves the app, and it also keeps the drive in the same position whether it
 * is a real route ("1 h 20 · 64 km") or the bare stand-in.
 */
export const withNavChip = (dots: MarkerDot[]): MarkerDot[] => {
  const drive = dots.find((d) => d.key === 'route');
  return [...dots.filter((d) => d.key !== 'route'), drive ?? NAV_DOT];
};

/**
 * What you can DO with the open pin, directly under it.
 *
 * They used to live in the footer of a panel over the bottom half of the
 * screen. Under the pin they are where the thumb already is and, more to the
 * point, they are attached to the thing they act on — tapping something three
 * pins into a browse can no longer mean the pin you were last reading about
 * rather than the one you are looking at.
 *
 * THE GREEN "GO" BUTTON IS GONE FROM HERE. Navigation moved onto the car chip
 * in the stack above, which was already saying "1 h 20 · 64 km" — the button
 * was a second control for a thing the row was describing anyway, and the
 * chip is the one carrying the number you decide on. What is left under the
 * pin is what the chips cannot be: everything recorded about the spot, and
 * the way out.
 */
/**
 * THE ONES THAT DO SOMETHING NEW SAY SO IN WORDS.
 *
 * These were five unlabelled glyphs in a row, and two of them — a bare plus
 * and an abstract standpipe — were asking a camper to guess which one submits
 * a place to sleep and which one logs a tap. Nobody guesses right, and the
 * cost of guessing wrong is a campsite submitted where a dump station was
 * meant. The three that CREATE something now carry their own name.
 *
 * "i" and "×" stay bare on purpose: they are the two glyphs on earth nobody
 * has to be told, and labelling them would push the row that carries the real
 * choices onto a second line for nothing.
 */
export type PinAction = {
  action: 'add' | 'add-facility' | 'details' | 'point' | 'beacon';
  /** The full sentence — the tooltip, and the accessible name. */
  label: string;
  /** The one or two words printed beside the glyph. Bare glyph without it. */
  text?: string;
  glyph: string;
  /** Sets this button apart from the rest of the row — Beacon's blue. */
  tone?: 'beacon';
};

export const pinActionsRow = (secondary: PinAction[] = []): string =>
  `<div class="wl-pin-actions">` +
  secondary
    .map(
      (s) =>
        `<span class="wl-pin-action${s.tone ? ` wl-pin-action-${s.tone}` : ''}" ` +
        `data-action="${s.action}" ` +
        `role="button" tabindex="0" title="${escapeHtml(s.label)}" ` +
        `aria-label="${escapeHtml(s.label)}">${s.glyph}` +
        (s.text ? `<span>${escapeHtml(s.text)}</span>` : '') +
        `</span>`
    )
    .join('') +
  `<span class="wl-pin-action wl-pin-action-close" data-action="close" ` +
  `role="button" tabindex="0" aria-label="Close this spot" title="Close">` +
  `${CLOSE_SVG}</span>` +
  `</div>`;

/**
 * The "more info" button, on both kinds of pin.
 *
 * A submitted spot's version opens everything recorded about it. A dropped
 * pin has no record to open — it is bare ground somebody tapped — so its
 * version opens what the map DOES know about that point: it unfurls every
 * chip on the pin at once, each into its own full, hedged sentence. Same
 * glyph, same place under the pin, same promise ("tell me more about this"),
 * answered from whatever there is to answer with.
 */
export const INFO_ACTION_SPOT: PinAction = {
  action: 'details', label: 'Everything recorded about this spot', glyph: INFO_SVG
};
export const INFO_ACTION_POINT: PinAction = {
  action: 'point', label: 'What is known about this point', glyph: INFO_SVG
};

/**
 * The tap-and-a-half glyph, for logging a toilet you are looking at.
 *
 * A SECOND BUTTON RATHER THAN A CHOICE INSIDE THE FIRST. "Add spot" means
 * somewhere to sleep, and a camper reaching for it while meaning "there's a
 * dump station here" would have had to submit a campsite and then correct it.
 * Two things, two buttons, and the labels say which is which.
 *
 * This is also the only way to mark a facility you are NOT standing at, which
 * is the common case — you notice the tap on the way past and log it that
 * evening. Everything else in the app takes its coordinate from the phone's
 * own fix, which cannot describe the place you drove past this morning.
 */
export const FACILITY_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" ' +
  'stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px">' +
  // A tap with a drop under it. The old glyph was a bare standpipe, which read
  // as anything from a goalpost to a bookmark; a basin under it was tried and
  // turned to mush at 13px. Tap plus drop survives the size.
  '<path d="M4 4h5v8"/>' +
  '<path d="M9 6.5h6a2.5 2.5 0 0 1 2.5 2.5v2.5"/>' +
  '<path d="M17.5 15.5c1.4 1.8 2.2 3 2.2 3.9a2.2 2.2 0 0 1-4.4 0c0-.9.8-2.1 2.2-3.9z"/>' +
  '</svg>';

/**
 * The "nothing switched on" default, hoisted to module scope.
 *
 * A `= []` default in the destructure allocates a NEW array on every render,
 * and the facility layer's effect depends on that array's identity — so an
 * omitted prop would re-run the effect, clear the layer and refetch forever.
 * One frozen instance means the identity is stable.
 */
export const NO_FACILITY_KINDS: FacilityKind[] = [];

/** Same reason as `NO_FACILITY_KINDS`: one frozen instance, stable identity. */
export const FACILITY_IDLE: FacilityLookupState = { status: 'idle' };

/**
 * One shell for every round button in the map's control stack.
 *
 * Same glass, border, size and shadow, written once — they are one set of
 * chrome rather than five floating oddments, and the only thing that ever
 * varies between them is the ring that says which one is live.
 */
export const STACK_BUTTON =
  'pointer-events-auto shrink-0 tap-safe w-11 h-11 rounded-full bg-slate-900/90 ' +
  'backdrop-blur-md border border-slate-700/80 text-slate-200 hover:text-white ' +
  'hover:bg-slate-800 shadow-xl flex items-center justify-center';

export const ADD_FACILITY_ACTION: PinAction = {
  action: 'add-facility',
  label: 'Add a toilet, tap, dump station or other amenity here',
  text: 'Add amenity',
  glyph: FACILITY_SVG
};

/**
 * The radar dish, for the beacon.
 *
 * SAME BUTTON, MOVED UNDER THE PIN. It was a pill floating at the top of the
 * map, which meant asking "what might be around here?" started by pointing at
 * a place and then reaching to the far corner of the screen to ask about it.
 * The question and the place it is about are one thing now: the pin has
 * already answered "where should it look?", so this goes straight to the
 * beacon rather than back through that question.
 *
 * Blue rather than the row's slate, because it is the one button here that
 * goes off and searches rather than recording something.
 */
export const BEACON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" ' +
  'stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px">' +
  '<path d="M12 12v9M8.5 21h7"/>' +
  '<path d="M12 12a4 4 0 1 0-3.4-1.9"/>' +
  '<path d="M5.2 13.5A8 8 0 0 1 16 3.2"/></svg>';

export const BEACON_ACTION: PinAction = {
  action: 'beacon',
  label: 'Search public map data for places you might be able to sleep near here',
  text: 'Beacon',
  glyph: BEACON_SVG,
  tone: 'beacon'
};

/**
 * A campground somebody's government runs, drawn as a plaque rather than a
 * ring.
 *
 * SHAPE CARRIES PROVENANCE HERE, and it does so because colour cannot. The
 * Beacon ladder already owns grey, amber, lime and green as an evidence
 * scale, and red means a camper was moved on — introducing new hues for
 * "official" would put a decorative colour next to a safety one. A silhouette
 * costs nothing, survives sunlight and greyscale, and is legible at 28px.
 *
 * It is a plaque and not a filled circle because a FILLED pin already means
 * "selected": `.wl-pin-on` floods emerald on tap. Fill was taken.
 *
 * The same emerald family as a camper's spot, deliberately. Both are free
 * places to sleep and the colour says so; the shape says who is claiming it.
 */
export const buildCampsiteIcon = (
  isSelected: boolean,
  dots: MarkerDot[] = [],
  /** Chip keys this pin has not shown yet. See `refreshIcon`. */
  animateKeys: Set<string> = new Set(),
  /**
   * Stamped on the wrapper so a delegated pointer handler can tell which pin
   * was pressed. The press-and-hold peek listens on the map container rather
   * than on each marker — markers are torn down and rebuilt by the cluster
   * plugin constantly, and per-marker listeners would have to be reattached
   * every time.
   */
  siteId?: string,
  /**
   * Who says there is a campsite here.
   *
   * `official` is a government-published campground — named, with a known
   * number of pitches, and nobody from this app has been. `camper` is
   * somebody saying "I slept here", which is a completely different claim and
   * gets a completely different silhouette.
   */
  provenance: 'camper' | 'official' = 'camper'
): L.DivIcon => {
  const row = dots.length
    ? (isSelected ? expandedDotRow(dots, animateKeys) : collapsedDotRing(dots))
    : '';
  const official = provenance === 'official';

  return L.divIcon({
    className: 'custom-campsite-marker',
    html:
      `<div class="wl-pin-wrap${isSelected ? ' wl-pin-wrap-on' : ''}"` +
      `${siteId ? ` data-site-id="${escapeHtml(siteId)}"` : ''}>` +
      row +
      `<div class="wl-pin${official ? ' wl-pin-official' : ''}${isSelected ? ' wl-pin-on' : ''}">` +
      `${TENT_SVG}</div>` +
      `${isSelected ? pinActionsRow([INFO_ACTION_SPOT]) : ''}` +
      `</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });
};

/**
 * A camper's hazard report.
 *
 * A TEARDROP PIN, and now the only HAZARD on this map wearing one. Official
 * warnings gave theirs up because an agency warns over a polygon and the
 * middle of a polygon is nobody's location; a camper report is the opposite —
 * somebody drove up to this exact spot and told us what they found, which is
 * the one kind of hazard a pin can honestly claim.
 *
 * A washout, a weak bridge and a downed tree all read as one dark-grey
 * barricade pin — they are the same decision for a driver, and the card names
 * the actual kind when you tap it. Fire and flooding keep the fire and flood
 * colours, so a camper's flood report matches the colour of the flood cloud an
 * agency issued.
 *
 * The behaviour is where the honesty lives: this marker opens a card that
 * spells out it is one person's report and not verified, and a report several
 * people have confirmed gets a pale ring.
 */
export const buildHazardReportIcon = (record: HazardRecord): L.DivIcon => {
  const style = hazardReportStyle(record.kind);
  const confirmed = reportStanding(record.confirms, record.disputes) === 'confirmed';
  // Slightly smaller than an official warning pin: a camper report is one
  // person's account and should not shout over an agency's.
  const size = style.prominent ? 32 : 27;
  const height = Math.round((size * 44) / 36);

  return L.divIcon({
    className: 'hazard-report-marker',
    html: localizedPinHtml({ kind: style.pin, size, ring: confirmed }),
    iconSize: [size, height],
    // The tip of the teardrop sits on the reported point.
    iconAnchor: [size / 2, height]
  });
};

/**
 * A Beacon spot.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LOOKS DELIBERATELY UNLIKE A CAMPSITE PIN
 * ---------------------------------------------------------------------------
 *
 * A campsite pin means somebody put a campsite there. A Beacon spot means the
 * app read some map data and thought "maybe". Drawing the two the same way
 * would let a guess borrow a real site's authority at a glance, from across
 * the map, before any text has been read.
 *
 * So this is a hollow ring, not a filled tent pin: an outline reads as
 * provisional where a solid shape reads as a fact. The grey `lead` ring is
 * dashed on top of that, because grey means nobody has ever been there, and
 * that is the one state a camper most needs to catch without opening anything.
 * A confirmed spot earns a solid ring and a filled centre — and it can only
 * earn those from other campers.
 *
 * The ring fills clockwise as campers report in, so how far a spot has climbed
 * is readable from the shape alone at a zoom where the colour is four pixels
 * wide. Colour and fill say the same thing twice, which is what makes the
 * ladder legible to anyone who cannot easily tell amber from lime.
 *
 * `flagged` breaks every one of those rules on purpose: solid red, filled
 * centre, and a pulse. It is not a rung on the ladder, it is a warning, and it
 * should be the first thing the eye lands on.
 */
export const BEACON_RUNG: Partial<Record<BeaconSpot['tier'], number>> = {
  lead: 0,
  reported: 0.34,
  corroborated: 0.67,
  confirmed: 1
};

/**
 * A Beacon pin you can actually find on the map.
 *
 * WHAT WAS WRONG. A lead was a 26px circle with a 2px DASHED border at 45%
 * opacity over a 16%-opacity fill, wrapped round a 5px dot. Every one of
 * those choices says "tentative", which is the right thing to say and the
 * wrong way to say it: over satellite imagery — dappled forest, bright
 * gravel, water — a translucent grey dashed hairline is not subtle, it is
 * invisible. A camper cannot read a hedge off a pin they cannot see.
 *
 * WHAT CARRIES THE HEDGE INSTEAD. Colour and fill, exactly as everywhere else
 * in this app: grey still means "nobody has been here", and the pin still
 * fills in as the ladder is climbed. What changed is that all of it is now
 * drawn on an opaque dark disc with a light outer ring, so the shape reads at
 * a glance against anything underneath. Being legible is not the same as
 * being confident, and the tooltip and card still say which one this is.
 */
export const buildBeaconIcon = (spot: BeaconSpot): L.DivIcon => {
  const style = beaconTierStyle(spot.tier);
  const isLead = spot.tier === 'lead';
  const isFlagged = spot.tier === 'flagged';
  const rung = BEACON_RUNG[spot.tier] ?? 0;

  /**
   * A LEAD SITS BACK; A KNOCK DOES NOT.
   *
   * Beacon can put a lot of pins on a map, and every one of them means "the
   * map data suggests this and nobody has ever been here". At full size and
   * full strength they read as landmarks and crowd out the things that are
   * actually known — campsites, facilities, warnings. Smaller and half
   * transparent puts them where they belong: visible, clearly secondary,
   * and still tappable.
   *
   * `flagged` is deliberately exempt from both. A red pin means a camper was
   * woken up or moved on here, and fading a warning to half strength to
   * reduce clutter is the one trade this app does not make.
   */
  const size = isFlagged ? 30 : 22;
  const fade = isFlagged ? 1 : 0.5;

  // The progress ring, drawn with a conic gradient behind the hollow centre.
  // Cheap enough to put on 200 markers; no SVG, no extra DOM. A lead has no
  // arc to draw, so it gets the flat dark disc.
  const progress = rung > 0 && !isFlagged
    ? `background:conic-gradient(${style.color} ${rung * 360}deg, rgba(15,23,42,0.92) ${rung * 360}deg);`
    : `background:rgba(15,23,42,0.92);`;

  // Scaled with the ring rather than fixed, so a smaller pin keeps the same
  // proportions instead of turning into a thick donut with a pinhole.
  const inner = isFlagged ? 12 : isLead ? 7 : 8;

  const html =
    `<div style="width:${size}px;height:${size}px;border-radius:9999px;opacity:${fade};` +
    // Solid, not dashed, and at full opacity. The dash was the single biggest
    // reason a lead vanished into gravel.
    `border:2px solid ${style.color};${progress}` +
    `display:flex;align-items:center;justify-content:center;box-sizing:border-box;` +
    // A dark halo under everything, so the pin has an edge over pale ground
    // (a bright gravel pit) as well as dark (forest canopy).
    `box-shadow:0 0 0 1.5px rgba(2,6,23,0.85), 0 2px 6px rgba(2,6,23,0.55)` +
    `${isFlagged ? `, 0 0 0 5px ${style.colorSoft}` : ''};">` +
    `<div style="width:${inner}px;height:${inner}px;border-radius:9999px;` +
    // A lead's centre is hollow — a ring of its own colour rather than a
    // solid dot — which is the same "recorded, unconfirmed" language the
    // facility pins and the chips above a spot already use.
    `${isLead
      ? `background:transparent;box-shadow:inset 0 0 0 2.5px ${style.color};`
      : `background:${style.color};`}` +
    `${!isFlagged && rung > 0 && rung < 1 ? 'box-shadow:0 0 0 2px #0f172a;' : ''}"></div>` +
    `</div>`;

  return L.divIcon({
    // The danger pulse is an existing utility and collapses under
    // prefers-reduced-motion with everything else.
    className: `beacon-spot-marker${isFlagged ? ' anim-pulse-danger' : ''}`,
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
};

/**
 * A facility pin — a toilet, a tap, a dump station.
 *
 * SMALLER AND QUIETER THAN A CAMPSITE PIN, on purpose. These arrive in
 * handfuls when a chip is switched on, and at campsite weight a dozen of them
 * would bury the thing the camper is actually choosing between. A facility is
 * a detail of a trip, not the trip.
 *
 * FILL CARRIES THE EVIDENCE, exactly as it does on the dots above a pin and
 * on Beacon's ladder. Solid means more than one source says so — it is in
 * OpenStreetMap, or another camper agreed. A dashed hollow ring means one
 * person said so and nobody has confirmed it yet. Neither is a promise, and
 * the card the pin opens says which one it is in words.
 */
export const buildFacilityIcon = (facility: MapFacility): L.DivIcon => {
  const color = FACILITY_COLOR[facility.kind];
  const { hollow } = facilitySourceStyle(facility.fromOsm, facility.confirmations);
  const size = 24;

  const html =
    `<div style="width:${size}px;height:${size}px;border-radius:9999px;` +
    `border:2px ${hollow ? 'dashed' : 'solid'} ${color};` +
    `background:${hollow ? 'rgba(15,23,42,0.85)' : color};` +
    `display:flex;align-items:center;justify-content:center;box-sizing:border-box;` +
    `font-size:11px;line-height:1;box-shadow:0 1px 4px rgba(2,6,23,0.6);">` +
    `<span aria-hidden="true">${FACILITY_GLYPH[facility.kind]}</span>` +
    `</div>`;

  return L.divIcon({
    className: 'facility-marker',
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
};

/**
 * The pin the user drops by tapping.
 *
 * A teardrop rather than a circle, so at a glance it never reads as one of the
 * data pins around it. This is the one marker on the map that came from the
 * user rather than from a source.
 *
 * IT CARRIES THE SAME ROW OF FACTS A SUBMITTED SPOT DOES. Tapping bare ground
 * is a camper asking "what is it like here?", and the answer used to be split:
 * warnings and fires were painted across the map as separate features, and the
 * pin itself said nothing. Now whatever is true of this patch of ground —
 * warnings over it, a fire burning near it, a toilet up the road — is stacked
 * above the pin in words, the same as it is above a spot somebody submitted.
 */
/**
 * How far a tour label has to climb to clear the dropped pin.
 *
 * The teardrop is 40px tall and stands ON the point, and a tour label hangs
 * 19px above whatever point it is given — so a label placed at the pin came
 * out underneath it, which is how "Approximate boundary — the edge can be
 * hundreds of…" ended up as a sentence with the middle covered by a pin. This
 * is the difference, plus a gap you can see through. See `atPin` on the tour
 * label, which applies it and drops the glyph at the same time.
 */
export const PIN_LIFT_PX = 34;

export const buildDestinationIcon = (
  dots: MarkerDot[] = [],
  addLabel?: string,
  animateKeys: Set<string> = new Set(),
  /** Whether a beacon can be sent from here — see `canBeacon`. */
  withBeacon = false
): L.DivIcon =>
  L.divIcon({
    className: 'destination-marker',
    html: `
      <div class="relative flex items-end justify-center anim-pin-drop">
        ${dots.length ? expandedDotRow(dots, animateKeys) : ''}
        ${pinActionsRow([
          // The same "i" a submitted spot wears, for the same reason: this is
          // where you ask the pin to say more. "Add spot" keeps its own
          // button — reading about a place and submitting it are different
          // things, and the tent is the only way to do the second.
          INFO_ACTION_POINT,
          ...(addLabel
            ? [{
                action: 'add' as const,
                label: addLabel,
                text: 'Add spot',
                glyph: ADD_SPOT_SVG
              }]
            : []),
          // Always offered, unlike "Add spot" — an amenity is worth marking on
          // ground you would never sleep on, which is most ground.
          ADD_FACILITY_ACTION,
          // Only when a beacon could actually run. See `canBeacon`.
          ...(withBeacon ? [BEACON_ACTION] : [])
        ])}
        <span class="absolute bottom-0 w-6 h-2 rounded-full bg-slate-950/40 blur-[2px]"></span>
        <svg viewBox="0 0 24 32" class="w-8 h-10 drop-shadow-xl relative" aria-hidden="true">
          <path d="M12 1c5.2 0 9.4 4.2 9.4 9.4 0 6.8-9.4 20.6-9.4 20.6S2.6 17.2 2.6 10.4C2.6 5.2 6.8 1 12 1z"
                fill="#F43F5E" stroke="#0F172A" stroke-width="1.7" stroke-linejoin="round"/>
          <circle cx="12" cy="10.4" r="3.5" fill="#0F172A"/>
        </svg>
      </div>`,
    iconSize: [32, 40],
    iconAnchor: [16, 40]
  });

/**
 * Rough size of a shape, as the area of its bounding box in square degrees.
 *
 * Only ever used to rank two overlapping parcels against each other, so the
 * distortion of treating degrees as a flat grid does not matter — both shapes
 * sit at the same latitude, because they both contain the same tapped point.
 */
export const bboxExtent = (geometry: unknown): number => {
  const g = geometry as { coordinates?: unknown };
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;

  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [lon, lat] = node as [number, number];
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    node.forEach(walk);
  };

  walk(g?.coordinates);
  if (minLon === Infinity) return Number.MAX_SAFE_INTEGER;
  return (maxLon - minLon) * (maxLat - minLat);
};

/** A geometry's bounding box as [minLon, minLat, maxLon, maxLat], or null. */
export const geometryBbox = (
  geometry: unknown
): [number, number, number, number] | null => {
  const g = geometry as { coordinates?: unknown };
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [lon, lat] = node as [number, number];
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    node.forEach(walk);
  };
  walk(g?.coordinates);
  if (minLon === Infinity) return null;
  return [minLon, minLat, maxLon, maxLat];
};

/**
 * The NARROWEST side of a feature's bounding box, in screen pixels at the
 * current view. This is what tells a razor-thin sliver apart from a real
 * parcel: a sliver is long but only a pixel or two wide, so its narrow side is
 * tiny however big its area or its long side is. A genuine parcel is wide on
 * both axes. Used to drop slivers before they draw, so leftover hairline
 * splinters from the source data simply never appear.
 */
export const featureMinDimPx = (map: L.Map, geometry: unknown): number => {
  const box = geometryBbox(geometry);
  if (!box) return Number.MAX_SAFE_INTEGER;
  const [minLon, minLat, maxLon, maxLat] = box;
  const a = map.latLngToLayerPoint([minLat, minLon]);
  const b = map.latLngToLayerPoint([maxLat, maxLon]);
  return Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
};

/**
 * A cheap content fingerprint for a boundary collection.
 *
 * Answers one question: is this the same set of parcels the map is already
 * drawing? A refetch — triggered by panning past the edge of the loaded box —
 * hands back a brand new response object, and comparing object identity says
 * "different" even when every parcel in it is one already on screen. Acting on
 * that meant rebuilding the entire layer for no visible change, which is what
 * made panning feel like the map was constantly redrawing itself.
 *
 * A parcel is identified by its source, name and designation plus its first
 * vertex rounded to about a metre. Two genuinely different parcels sharing all
 * four is not a thing the feeds produce; two responses describing the same
 * parcel always agree on all four. The order the server returns them in is not
 * guaranteed, so the parts are sorted before joining.
 *
 * Cost is one pass over the features with no geometry maths — trivial next to
 * the dissolve pass and layer rebuild it exists to avoid.
 */
export const fingerprintCache = new WeakMap<BoundaryCollection, string>();

export const parcelFingerprint = (collection: BoundaryCollection): string => {
  const memo = fingerprintCache.get(collection);
  if (memo !== undefined) return memo;

  const parts = collection.features.map((f) => {
    const p = f.properties ?? ({} as BoundaryFeature['properties']);
    const g = f.geometry as { coordinates?: unknown };

    // Walk to the first coordinate pair, whatever the nesting depth, and
    // count the vertices on the way past.
    let vertices = 0;
    let first = '';
    const walk = (node: unknown): void => {
      if (!Array.isArray(node)) return;
      if (typeof node[0] === 'number' && typeof node[1] === 'number') {
        vertices += 1;
        if (!first) first = `${(node[0] as number).toFixed(5)},${(node[1] as number).toFixed(5)}`;
        return;
      }
      node.forEach(walk);
    };
    walk(g?.coordinates);

    /**
     * The vertex count is the part that stops this being too clever.
     *
     * Zooming in refetches the same parcels at FINER generalisation — same
     * source, same name, same first vertex, more detail. Without the count
     * they fingerprint identically, the rebuild is skipped as "no change",
     * and the map keeps drawing the coarse outline it already had while
     * claiming to be at full detail. Edges that are more approximate than the
     * app says they are is exactly the failure this codebase refuses to ship.
     */
    return `${p._source ?? ''}~${p._name ?? ''}~${p._designation ?? ''}~${first}~${vertices}`;
  });
  parts.sort();
  const out = `${parts.length}#${parts.join('|')}`;

  // Memoised per response object: `fetchBoundaries` hands back the same object
  // for a cache hit, so a settled pan costs a WeakMap lookup rather than a
  // fresh walk over every vertex on screen.
  fingerprintCache.set(collection, out);
  return out;
};

/* ------------------------------------------------------------------ */
/* Active fires: no longer drawn on the map                             */
/* ------------------------------------------------------------------ */
/**
 * The flame markers, the burn perimeters and their popups used to live here.
 * They are gone, and the fire data is not.
 *
 * Scattering every incident in the viewport across the map made the feed look
 * like the subject of the app: a dozen flames over country the camper was
 * never going to visit, each one tappable and each one competing with the
 * pins for the same square inch. What a camper actually asks is about a
 * PLACE — "is anything burning near here?" — so fires now answer as part of a
 * point: a breathing dot above the pin you tapped (`fireDots`), and the full
 * list with sizes and containment in the card underneath it
 * (`NearbyFiresCard`). Same feed, same numbers, asked at the moment it means
 * something.
 */

/** Pull the fields we show from a boundary feature's properties. */
export const landFromFeature = (properties: Record<string, any> | undefined): DestinationLand | undefined => {
  const p = properties;
  if (!p) return undefined;
  return {
    name: p._name ?? 'Public land',
    // Falls back to the group's words, never to a raw enum — `_confidence`
    // used to surface here as the literal string "managing_agency".
    designation: p._designation ?? BOUNDARY_GROUP_STYLES[boundaryGroupOf(p)].label,
    // Which agency's rulebook applies when the parcel's own record is silent.
    sourceId: p._source ?? undefined,
    attribution: p._attribution ?? undefined,
    stayLimitDays: p._stayLimitDays ?? undefined,
    moveDistanceKm: p._moveDistanceKm ?? undefined,
    permitRequired: p._permitRequired ?? undefined,
    permitName: p._permitName ?? undefined,
    permitUrl: p._permitUrl ?? undefined,
    fireBanActive: p._fireBanActive ?? undefined,
    campfirePolicy: p._campfirePolicy ?? undefined
  };
};

/**
 * The name usually carries the designation already ("… National Forest"), and
 * repeating it under the title is a wasted line on a bubble this small.
 */
export const landSubtitle = (land: DestinationLand): string | undefined =>
  land.designation && !land.name.toLowerCase().includes(land.designation.toLowerCase())
    ? land.designation
    : undefined;


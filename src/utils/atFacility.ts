import { distanceKm } from './geo';

/**
 * YOU HAVE TO BE STANDING THERE TO WRITE THE DIRECTIONS.
 *
 * A note on a facility is one thing and one thing only: what somebody who has
 * just found it can tell the next person. "Behind the yellow wall, right at the
 * back" is worth having because whoever wrote it was looking at the wall.
 *
 * Written from a sofa it is something else entirely — a guess, a memory of a
 * different trip, or an advert — and it arrives on the pin looking exactly like
 * the real thing. There is no way to tell them apart after the fact, so the app
 * asks the only question it can actually check: is the phone there now?
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is a FRESH fix every time, not the last position the app happened to hold.
 * A camper who located themselves in Calgary at breakfast is not in Calgary at
 * dusk, and letting a stale fix authorise a note would make the check
 * theatre.
 *
 * It is not security. A phone can be told to report any position it likes, and
 * nothing in a browser can stop that. What it stops is the ordinary case — a
 * note written from somewhere else, with no ill intent, that is wrong in a way
 * nobody downstream can detect.
 *
 * A phone that will not share its position gets a clear no rather than a silent
 * pass. "We could not check" and "you are here" must not be the same answer.
 */

/**
 * 300 metres.
 *
 * Generous on purpose: a phone under trees or against a canyon wall can be a
 * hundred metres out on its own, the car park of a rest area is bigger than it
 * sounds, and a camper writing the note from their van thirty seconds after
 * walking back is exactly who this feature is for. Tight enough that it still
 * means "here" — the next facility of the same kind is rarely this close.
 */
export const NOTE_RADIUS_M = 300;

export interface ProximityCheck {
  ok: boolean;
  /** How far off they were, when we managed to find out. */
  metres?: number;
  /** What to tell them. Empty when `ok`. */
  message: string;
}

/**
 * Take a fix and say whether it is close enough to write about the place.
 *
 * Never throws and never hangs: geolocation gets ten seconds, after which the
 * answer is "could not check", which reads as a no.
 */
export const checkStandingAt = (
  latitude: number,
  longitude: number,
  radiusMetres = NOTE_RADIUS_M
): Promise<ProximityCheck> =>
  new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve({
        ok: false,
        message: 'This phone will not share its position, so a note cannot be checked against where you are.'
      });
      return;
    }

    let settled = false;
    const finish = (result: ProximityCheck) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const metres = Math.round(
          distanceKm(pos.coords.latitude, pos.coords.longitude, latitude, longitude) * 1000
        );

        if (metres <= radiusMetres) { finish({ ok: true, metres, message: '' }); return; }

        finish({
          ok: false,
          metres,
          message:
            metres > 2000
              ? `You are about ${Math.round(metres / 1000)} km away. Notes are for directions somebody standing there can give — leave one when you are next at it.`
              : `You are about ${metres} m away. Get a bit closer and the note will save — it is meant to be written where you can see the place.`
        });
      },
      () => {
        finish({
          ok: false,
          message: 'Could not get your position, so there is no way to check you are at it. Notes are written where the facility is.'
        });
      },
      /* A fresh fix, and a real one. `maximumAge: 0` is the whole point: a
         cached position from an hour ago would authorise a note from anywhere
         the camper had been that day. */
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
    );
  });

/**
 * Getting spots off the phone and onto the server.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE DEVICE LIST IS FOR NOW
 * ---------------------------------------------------------------------------
 *
 * `custom_campsites` used to be where a submitted spot LIVED. It is now an
 * outbox: the only spots in it are ones that could not be shared yet, and each
 * one leaves the moment the server accepts it.
 *
 * That is a real change in meaning and it is the right one. A spot sitting in
 * browser storage is one cleared cache away from gone, invisible to every other
 * camper, and — because the server is what decides whether a spot is yours to
 * take down — awkward to even delete. The server copy is the real one. The
 * device copy exists to survive the drive out of the canyon, and no longer.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER, WHICH IS THE WHOLE SAFETY ARGUMENT
 * ---------------------------------------------------------------------------
 *
 *   1. write to the device
 *   2. try the server
 *   3. delete the device copy ONLY after the server has said yes
 *
 * There is no moment in that sequence where the spot exists nowhere. Somebody
 * standing at a pullout with one bar has just typed coordinates they may not be
 * able to recover; the rule that they never lose them is older than this file
 * and survives it intact.
 *
 * Nothing here throws. A spot that cannot be uploaded stays exactly where it
 * is and is tried again next time.
 */
import type { Campsite } from '../types';
import { submitCampsite } from './dataService';
import { getCustomCampsites, deleteCustomCampsite } from './offlineStorage';

export interface SpotSyncResult {
  /**
   * Spots the server has now accepted, and whose device copy has been dropped.
   * Carries the updated record so the caller can restate the chip without
   * refetching.
   */
  uploaded: Campsite[];
  /** How many are still waiting — no signal, no account, or a refusal. */
  pending: number;
  /**
   * Why the last one that failed did, when one did.
   *
   * Shown to nobody automatically. It exists so a camper who ASKS why their
   * spot has not gone up gets the server's own sentence rather than a shrug.
   */
  message?: string;
}

const NOTHING: SpotSyncResult = { uploaded: [], pending: 0 };

/**
 * Send everything the device is still holding.
 *
 * Sequential, not parallel: this runs the moment a phone reports a connection,
 * which is the moment that connection is least likely to be real. One at a time
 * means a queue of six spots on a flickering signal uploads what it can rather
 * than failing all six together.
 *
 * A duplicate id comes back as success from `submitCampsite` — that is a spot
 * whose upload landed but whose device copy outlived it, and dropping the copy
 * is exactly right.
 */
export const flushPendingSpots = async (): Promise<SpotSyncResult> => {
  let queued: Campsite[];
  try {
    queued = await getCustomCampsites();
  } catch {
    return NOTHING;
  }
  if (queued.length === 0) return NOTHING;

  const uploaded: Campsite[] = [];
  let pending = 0;
  let message: string | undefined;

  for (const site of queued) {
    const result = await submitCampsite(site);

    if (!result.ok) {
      pending += 1;
      message = result.message;
      continue;
    }

    await deleteCustomCampsite(site.id);
    uploaded.push({ ...site, submissionState: 'pending_review', submittedByMe: true });
  }

  return { uploaded, pending, message };
};

/**
 * Handing the drive to the maps app that's already in the car.
 *
 * ---------------------------------------------------------------------------
 * WHY WANDRLUST DOES NOT DRIVE YOU THERE
 * ---------------------------------------------------------------------------
 *
 * The app used to have its own navigation mode — a chase camera, a rotating
 * map, a heads-up display. It was never turn-by-turn: no maneuver
 * instructions, no voice, no re-routing. It could not have been, without
 * building and maintaining a real navigation engine.
 *
 * Apple Maps and Google Maps already do that, better, and — the part that
 * actually matters — they are already on CarPlay and Android Auto. Opening one
 * of them puts the drive on the car's screen with zero native code on our
 * side. So the highway miles are theirs.
 *
 * WHAT WE KEEP IS THE LAST MILE, and that split is the whole point rather than
 * a consolation prize. Google will happily route a sedan down a washed-out
 * forest track, or snap the destination to the nearest road it knows and
 * announce "you have arrived" with six kilometres of two-track still to go.
 * That is precisely the kind of confident wrong answer this app exists not to
 * give. So Wandrlust keeps the parts it can stand behind — how far the route
 * falls short of the actual spot, whether the routing engine could see unpaved
 * tracks at all, what the road warnings are for your rig — and hands over only
 * the part somebody else does better.
 */

/**
 * iOS and iPadOS, including iPadOS pretending to be a Mac.
 *
 * `MSStream` is checked because old IE11 on Windows Phone matched the iPhone
 * pattern; it costs one comparison to not care. The iPad branch is the one
 * that matters in practice — since iPadOS 13 the user agent says "Macintosh",
 * so the touch-point count is the only reliable tell.
 */
const isApplePlatform = (): boolean => {
  if (typeof navigator === 'undefined') return false;

  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) && !('MSStream' in window)) return true;

  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
};

/**
 * A driving-directions URL for the platform's own maps app.
 *
 * Both of these are ordinary https links rather than custom schemes, which is
 * deliberate: a scheme like `comgooglemaps://` fails silently and leaves the
 * user staring at nothing when the app isn't installed. These always resolve —
 * to the native app when it is there, to the web map when it isn't.
 *
 * `dirflg=d` asks Apple Maps for driving rather than whatever the user last
 * used, which for a camper towing a trailer should never be walking.
 */
export const getDirectionsUrl = (latitude: number, longitude: number): string => {
  const destination = `${latitude},${longitude}`;

  return isApplePlatform()
    ? `https://maps.apple.com/?daddr=${destination}&dirflg=d`
    : `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
};

/** Which app the Directions button is about to open, so the label can say so. */
export const directionsAppName = (): string =>
  isApplePlatform() ? 'Apple Maps' : 'Google Maps';

/**
 * Open the directions, in a new tab.
 *
 * `noopener` because the opened page gets a handle on `window.opener`
 * otherwise, and a maps URL is still a third-party page.
 */
export const openDirections = (latitude: number, longitude: number): void => {
  if (typeof window === 'undefined') return;
  window.open(getDirectionsUrl(latitude, longitude), '_blank', 'noopener,noreferrer');
};
import { useEffect, useState } from 'react';

/**
 * Is this device connected right now?
 *
 * WHAT THE BROWSER ACTUALLY KNOWS, AND WHAT IT DOESN'T.
 *
 * `navigator.onLine` is honest in exactly one direction. `false` is a fact:
 * the operating system has no network at all, so nothing we ask for can
 * possibly arrive. `true` is only a hopeful "there is a network adapter with
 * something attached to it" — a campground wifi that authenticates nobody, a
 * single bar of LTE that times out, and a full-strength connection all report
 * the same `true`.
 *
 * So this returns the device's own belief and nothing more, and every place
 * that shows it must say it that way: "connected", never "everything works".
 * The services already assume any request can fail; this only decides what
 * the app SAYS about the connection, and whether it bothers asking.
 *
 * Server-rendered or ancient browsers with no `navigator.onLine` get `true`,
 * because assuming offline would silently stop the app fetching anything.
 */
export const useOnlineStatus = (): boolean => {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' || navigator.onLine === undefined
      ? true
      : navigator.onLine
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);

    /* Read once more on mount: the connection can drop between the first
       render and this effect, and on iOS it routinely does while the app is
       being restored from the background. */
    if (typeof navigator !== 'undefined' && navigator.onLine !== undefined) {
      setOnline(navigator.onLine);
    }

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
};

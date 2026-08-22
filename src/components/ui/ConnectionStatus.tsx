import React from 'react';
import { Wifi, WifiOff } from 'lucide-react';

/**
 * The connection light. It reports; it does not switch.
 *
 * There was a plug button here for a long time that toggled a pretend
 * "offline mode". It was the app asking the camper a question the phone
 * already knows the answer to, and it could be set to the WRONG answer —
 * "Online" glowing green in a canyon with no bars. This reads the device
 * instead and cannot be pressed.
 *
 * What it is allowed to claim is narrow, and the wording keeps it there.
 * Green means the phone has a network attached, which is not the same as
 * every service answering — a campground wifi that never authenticates you
 * looks identical to full LTE from in here. Red is the certain one: no
 * network at all, so nothing new is arriving and the map is running on what
 * is already on the phone.
 */
export const CONNECTION_NOTE = {
  online:
    'Connected. Your phone has a network — that is not a promise every service answers.',
  offline:
    'No connection. The map is running on what is already saved to this phone.'
} as const;

export const ConnectionStatus: React.FC<{
  isOnline: boolean;
  /** `icon` is the square badge in the phone header; `pill` is the labelled
   *  chip on the desktop toolbar. */
  variant?: 'icon' | 'pill';
  className?: string;
}> = ({ isOnline, variant = 'icon', className = '' }) => {
  const note = isOnline ? CONNECTION_NOTE.online : CONNECTION_NOTE.offline;
  const tone = isOnline
    ? 'bg-emerald-950/80 text-emerald-400 border-emerald-500/50'
    : 'bg-rose-950/80 text-rose-400 border-rose-500/60';

  return (
    /*
      `role="status"` with `aria-live="polite"` rather than a button: a screen
      reader should hear "connection lost" when it happens and never be
      offered a press that does nothing.
    */
    <div
      role="status"
      aria-live="polite"
      title={note}
      aria-label={note}
      className={`${
        variant === 'pill'
          ? 'px-3 py-1.5 rounded-xl text-xs font-semibold gap-1.5'
          : 'p-2 rounded-lg'
      } border flex items-center select-none ${tone} ${className}`}
    >
      {isOnline
        ? <Wifi className={variant === 'pill' ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
        : <WifiOff className={variant === 'pill' ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
      {variant === 'pill' && (isOnline ? 'Online' : 'No connection')}
    </div>
  );
};

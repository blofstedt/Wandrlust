import React from 'react';
import { CloudOff, Clock, EyeOff } from 'lucide-react';
import type { SubmissionState } from '../types';

/**
 * What happened to a spot this user added.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Submitting a campsite used to write to browser storage and stop. The spot
 * appeared on the author's map looking exactly like every other pin, so there
 * was no way to tell that nobody else could see it — and no reason to suspect
 * it. People believed they were contributing to a shared map and were not.
 *
 * Now the submission really does go to a review queue, which introduces a
 * second state that also needs saying out loud: filed, but not yet visible to
 * anyone else. Both of those are the app being honest about the difference
 * between "saved" and "shared", which is exactly the kind of distinction this
 * codebase refuses to paper over.
 *
 * Renders nothing for a published site, or for anyone but the author. A spot
 * that IS shared needs no explanation, and the state of somebody else's
 * submission is none of your business.
 */

const COPY: Record<
  Exclude<SubmissionState, 'published'>,
  { label: string; icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  local_only: {
    label: 'Only on this device',
    icon: CloudOff,
    className: 'bg-slate-800/80 border-slate-600/60 text-slate-300'
  },
  pending_review: {
    label: 'Waiting for review',
    icon: Clock,
    className: 'bg-amber-950/60 border-amber-700/50 text-amber-200'
  },
  /**
   * Hidden after being reported. Shown ONLY to the author.
   *
   * They can still see their own spot — hiding it from them too would look
   * like the app lost it — but they are told it is no longer public, because
   * quietly serving them a private copy of something they think is live is a
   * worse lie than the bad news.
   */
  rejected: {
    label: 'Hidden while we look at it',
    icon: EyeOff,
    className: 'bg-rose-950/60 border-rose-700/50 text-rose-200'
  }
};

export const SubmissionChip: React.FC<{
  state?: SubmissionState;
  submittedByMe?: boolean;
  /** Adds the one-line explanation underneath. Off in tight card layouts. */
  withDetail?: boolean;
}> = ({ state, submittedByMe, withDetail = false }) => {
  if (!submittedByMe || !state || state === 'published') return null;

  const { label, icon: Icon, className } = COPY[state];

  return (
    <div>
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-bold uppercase tracking-wide ${className}`}
      >
        <Icon className="w-2.5 h-2.5 shrink-0" />
        {label}
      </span>
      {withDetail && (
        <p className="text-[12px] text-slate-500 leading-snug mt-1">
          {state === 'local_only'
            ? 'Saved here, but not sent anywhere. Sign in and add it again to share it with other campers.'
            : state === 'pending_review'
            ? 'Filed for review. It stays visible to you and hidden from everyone else until it is approved.'
            : 'Somebody reported this spot, so it is hidden from other campers while it is checked.'}
        </p>
      )}
    </div>
  );
};
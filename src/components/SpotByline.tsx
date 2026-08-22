/**
 * Who put this spot on the map.
 *
 * ---------------------------------------------------------------------------
 * WHY A SPOT GETS A BYLINE AND A CURATED SITE DOES NOT
 * ---------------------------------------------------------------------------
 *
 * A dispersed spot is one camper's word about a place — they drove in, they
 * decided it was somewhere you could sleep, they typed the coordinates. The
 * camper reading it is deciding whether to drive an hour down a forest road on
 * the strength of that, and knowing it came from a person rather than from a
 * survey is part of what they are weighing.
 *
 * The curated sites carry no byline, because nobody submitted them. Putting an
 * "added by" on one would invent an author for a row that came out of a seed
 * file, and a name is a claim about provenance like any other.
 *
 * WHAT IT NEVER SHOWS. The account id, the email, anything that identifies a
 * person outside this app. `profiles` is world-readable on purpose — it holds
 * the handle somebody chose to be known by — and the handle is the ceiling.
 *
 * "a camper" is the honest fallback while the lookup is in flight, or when the
 * account has no name set, or when the lookup failed. The spot IS somebody's;
 * drawing nothing there would read as though the app itself had checked it.
 */
import React, { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import { fetchSpotAuthor } from '../services/dataService';
import type { Campsite } from '../types';

export const SpotByline: React.FC<{
  campsite: Campsite;
  /** Tailwind size classes, so the list card can run larger than the sheet. */
  className?: string;
}> = ({ campsite, className = 'text-xs' }) => {
  const [author, setAuthor] = useState<string | null>(null);

  const { submittedBy, submittedByMe } = campsite;

  useEffect(() => {
    setAuthor(null);
    // Ours needs no lookup, and a spot with no author has none to look up.
    if (!submittedBy || submittedByMe) return;

    let cancelled = false;
    fetchSpotAuthor(submittedBy).then((name) => {
      if (!cancelled) setAuthor(name);
    });

    return () => { cancelled = true; };
  }, [submittedBy, submittedByMe]);

  if (!submittedByMe && !submittedBy) return null;

  return (
    <p className={`${className} text-slate-400 flex items-center gap-1`}>
      <UserRound className="w-3 h-3 shrink-0 text-slate-500" />
      <span className="truncate">
        Added by {submittedByMe ? 'you' : author ?? 'a camper'}
      </span>
    </p>
  );
};

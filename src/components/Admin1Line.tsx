/**
 * "United States — Montana" line for the per-pin card.
 *
 * Reads the region the point sits in from the bundled outlines. Renders
 * nothing while the lookup is in flight (the user opens the card,
 * the line appears within 250 ms; no spinner) and nothing on
 * failure (a missing country is a missing country, not a "we don't
 * know" message).
 *
 * The line goes directly under the coords in the destination sheet
 * header and under the "Camper spot" / "Your pin" badge in the
 * campsite bottom sheet — the user is reading the coordinates, then
 * reading "what country and state is that", in that order.
 */
import React, { useEffect, useState } from 'react';
import { MapPin, Flag } from 'lucide-react';
import { findAdmin1At, Admin1 } from '../services/admin1Service';

interface Admin1LineProps {
  latitude: number;
  longitude: number;
  /** Visual flavour: 'inline' sits next to the coords; 'badge' is a
   *  pill like the existing 'CAMPER SPOT' / 'YOUR PIN' badges. */
  variant?: 'inline' | 'badge';
}

export const Admin1Line: React.FC<Admin1LineProps> = ({
  latitude,
  longitude,
  variant = 'inline'
}) => {
  const [admin1, setAdmin1] = useState<Admin1 | null>(null);
  const [loaded, setLoaded] = useState(false);

  /**
   * The lookup is local now — the outlines are a bundled file, so this
   * is a point-in-polygon test rather than a request. The old version
   * waited 200 ms before even starting, to avoid firing a round trip at
   * a card the user was scrolling past; with no round trip to avoid,
   * the delay bought nothing and cost a visible flash of missing text.
   */
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);

    void findAdmin1At(latitude, longitude).then((hit) => {
      if (cancelled) return;
      setAdmin1(hit);
      setLoaded(true);
    });

    return () => { cancelled = true; };
  }, [latitude, longitude]);

  if (!loaded || !admin1) return null;

  // "Montana, United States" — name first, country second, the
  // way English readers expect ("Where is this? Montana. Which
  // country? United States."). The state/province type tag
  // ("State", "Province", "Territory") is omitted for the
  // common case because the country already implies it; a
  // Canadian territory lookup would surface "Nunavut" with no
  // type tag, which is fine because at the territory level the
  // user knows what they're looking at.
  const text = `${admin1.name}, ${admin1.country}`;

  if (variant === 'badge') {
    return (
      <span className="px-1.5 py-0.5 rounded bg-slate-700/60 border border-slate-600/80 text-[9px] font-bold text-slate-200 uppercase tracking-wide flex items-center gap-1">
        <Flag className="w-2.5 h-2.5" />
        {text}
      </span>
    );
  }

  return (
    <span className="text-[10px] text-slate-400 flex items-center gap-1 mt-0.5">
      <MapPin className="w-2.5 h-2.5" />
      {text}
    </span>
  );
};

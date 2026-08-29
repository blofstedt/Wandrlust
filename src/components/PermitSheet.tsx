import React from 'react';
import { TicketCheck, ExternalLink, Building2, Users, Tag } from 'lucide-react';
import { Sheet } from './ui/Sheet';
import type { PermitMatch } from '../config/permits';

/**
 * WHAT THE PERMIT CHIP OPENS INTO.
 *
 * The chip said "Permit required" and stopped, which is the first half of a
 * sentence. Required by whom, costing what, and got from where? A camper
 * reading that on a forestry road has no way to answer any of it, and the
 * answer is the difference between a legal night's sleep and a fine.
 *
 * So the chip is a door now, and this is behind it: the issuer, who actually
 * needs one, what it costs, the thing they would otherwise be caught out by,
 * and a link that goes to the agency's own page — never to a reseller, never
 * to a summary of one.
 *
 * TWO STRENGTHS OF CLAIM, SAID DIFFERENTLY. A permit recorded against this
 * exact spot is a requirement. A permit matched because the spot falls inside
 * a regime's approximate area is a thing to check, because the real boundary
 * belongs to the agency and this app holds a rectangle around it. Those must
 * never read alike, and the difference is the whole top of this card.
 */
interface PermitSheetProps {
  match: PermitMatch | null;
  onClose: () => void;
}

export const PermitSheet: React.FC<PermitSheetProps> = ({ match, onClose }) => {
  const permit = match?.permit;
  const how = match?.certainty ?? 'area';

  return (
    <Sheet
      isOpen={Boolean(match)}
      onClose={onClose}
      title={permit?.name ?? 'Permit'}
      subtitle={
        how === 'area'
          ? 'May apply here — worth checking'
          : 'Required to camp here'
      }
      icon={<TicketCheck className="w-5 h-5 text-indigo-400" />}
      variant="dock"
      fitContent
    >
      {permit && (
        <div className="space-y-3.5 text-sm">
          {/*
            The hedge goes FIRST when there is one. Putting it under the price
            would let somebody read the cost, decide, and never reach the line
            saying we are not certain this applies to them.
          */}
          {how === 'area' && (
            <p className="rounded-lg bg-amber-500/10 border border-amber-500/25 px-3 py-2.5 text-xs text-amber-200/90 leading-snug">
              This spot sits inside a rectangle drawn around the area this
              permit covers, which is not the same as the real boundary — that
              one belongs to {permit.issuer}. Check with them before you rely on
              either answer.
            </p>
          )}

          {/*
            A boundary match is the agency's own outline, held to about two
            kilometres. That is an answer, not a hedge, so it is said quietly
            and only where it matters: near the edge.
          */}
          {how === 'boundary' && (
            <p className="rounded-lg bg-slate-800/60 px-3 py-2.5 text-xs text-slate-400 leading-snug">
              This spot is inside {permit.issuer}’s own published area for the
              pass. The outline this app holds is simplified to about two
              kilometres, so if you are camping right on the edge of it, check.
            </p>
          )}

          <div className="flex items-start gap-2.5">
            <Tag className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Cost</p>
              <p className="text-slate-100">{permit.cost}</p>
            </div>
          </div>

          <div className="flex items-start gap-2.5">
            <Users className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Who needs one</p>
              <p className="text-slate-300 leading-snug">{permit.whoNeeds}</p>
            </div>
          </div>

          <div className="flex items-start gap-2.5">
            <Building2 className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Issued by</p>
              <p className="text-slate-300">{permit.issuer}</p>
            </div>
          </div>

          {permit.note && (
            <p className="rounded-lg bg-slate-800/60 px-3 py-2.5 text-xs text-slate-300 leading-snug">
              {permit.note}
            </p>
          )}

          {/*
            Out to the agency itself. `noopener` because this opens a tab from
            our origin, and `noreferrer` because where somebody camps is not
            the agency's business to log against us.
          */}
          <a
            href={permit.url}
            target="_blank"
            rel="noopener noreferrer"
            className="anim-press flex items-center justify-center gap-2 w-full rounded-xl bg-emerald-500 hover:bg-emerald-400 px-4 py-3 font-semibold text-slate-950"
          >
            <ExternalLink className="w-4 h-4" />
            {permit.free ? 'Get the permit' : 'Buy the pass'}
          </a>

          {/*
            A price with no date is a claim with no shelf life. Fees change,
            and an old answer should look old rather than sounding current.
          */}
          <p className="text-[11px] text-slate-500 text-center">
            Checked against {permit.issuer}’s own page on {permit.checked}. Fees
            and rules change — the link above is the authority, not this card.
          </p>
        </div>
      )}
    </Sheet>
  );
};

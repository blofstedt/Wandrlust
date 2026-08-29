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
 *
 * ---------------------------------------------------------------------------
 * IT HAS TO FIT ON THE SCREEN IN ONE GO
 * ---------------------------------------------------------------------------
 *
 * This card used to run past the bottom of a phone, and the thing below the
 * fold was the BUY button. A camper who has to scroll to find it does not know
 * it is there — the card reads as a warning with no way out of it, which is
 * the opposite of what it is for.
 *
 * So the layout is built to a budget rather than laid out and hoped for. The
 * two one-line facts share a row instead of taking one each; the labels sit
 * beside their icons rather than above them; the hedge, the caveat and the
 * date are set at the small size they deserve. Nothing was cut — every fact
 * that was on this card is still on it. Anything added here has to earn its
 * height, because the button is what pays for it.
 */
interface PermitSheetProps {
  match: PermitMatch | null;
  onClose: () => void;
}

/** One short fact and its label, on a single line, beside its icon. */
const Fact: React.FC<{
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}> = ({ icon, label, children }) => (
  <div className="flex items-start gap-2 min-w-0">
    <div className="shrink-0 mt-[3px]">{icon}</div>
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-slate-500 leading-none mb-1">
        {label}
      </p>
      <p className="text-[13px] text-slate-100 leading-snug">{children}</p>
    </div>
  </div>
);

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
        <div className="space-y-2.5">
          {/*
            The hedge goes FIRST when there is one. Putting it under the price
            would let somebody read the cost, decide, and never reach the line
            saying we are not certain this applies to them.
          */}
          {how === 'area' && (
            <p className="rounded-lg bg-amber-500/10 border border-amber-500/25 px-2.5 py-2 text-[11px] text-amber-200/90 leading-snug">
              This spot sits inside a rectangle drawn around the area this
              permit covers, which is not the same as the real boundary — that
              one belongs to {permit.issuer}. Check with them before you rely
              on either answer.
            </p>
          )}

          {/*
            A boundary match is the agency's own outline, held to about two
            kilometres. That is an answer, not a hedge, so it is said quietly
            and only where it matters: near the edge.
          */}
          {how === 'boundary' && (
            <p className="rounded-lg bg-slate-800/60 px-2.5 py-2 text-[11px] text-slate-400 leading-snug">
              Inside {permit.issuer}’s own published area for the pass. The
              outline this app holds is simplified to about two kilometres, so
              if you are camping right on the edge of it, check.
            </p>
          )}

          {/*
            The two one-line facts share a row. They are a price and a name —
            neither ever wraps far — and giving each its own row cost a
            phone-height of nothing.
          */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
            <Fact
              icon={<Tag className="w-3.5 h-3.5 text-emerald-400" />}
              label="Cost"
            >
              {permit.cost}
            </Fact>
            <Fact
              icon={<Building2 className="w-3.5 h-3.5 text-violet-400" />}
              label="Issued by"
            >
              {permit.issuer}
            </Fact>
          </div>

          <Fact
            icon={<Users className="w-3.5 h-3.5 text-sky-400" />}
            label="Who needs one"
          >
            <span className="text-slate-300">{permit.whoNeeds}</span>
          </Fact>

          {permit.note && (
            <p className="rounded-lg bg-slate-800/60 px-2.5 py-2 text-[11px] text-slate-300 leading-snug">
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
            className="anim-press flex items-center justify-center gap-2 w-full rounded-xl bg-emerald-500 hover:bg-emerald-400 px-4 py-2.5 text-[15px] font-semibold text-slate-950"
          >
            <ExternalLink className="w-4 h-4" />
            {permit.free ? 'Get the permit' : 'Buy the pass'}
          </a>

          {/*
            A price with no date is a claim with no shelf life. Fees change,
            and an old answer should look old rather than sounding current.
          */}
          <p className="text-[10px] text-slate-500 text-center leading-snug">
            Checked against {permit.issuer}’s own page on {permit.checked}. The
            link above is the authority, not this card.
          </p>
        </div>
      )}
    </Sheet>
  );
};

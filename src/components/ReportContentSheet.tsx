import React, { useState } from 'react';
import { Flag, Loader2 } from 'lucide-react';
import { Sheet } from './ui/Sheet';
import { useToast } from './ui/Feedback';
import {
  reportContent,
  type ReportTargetKind,
  type ContentReportReason
} from '../services/dataService';

/**
 * Report a record as bad.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AND WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * Until now there was no flag, edit, or remove path for user content anywhere
 * in the app — no way to take down a listing on private land, a fabricated
 * spot, or an abusive review. That is not survivable for an app that asks
 * strangers to drive somewhere on another stranger's word.
 *
 * IT SHOWS NO REPORT COUNT, to anyone, ever. A visible tally is a brigading
 * tool and an invitation to argue with it. The row-level security policy backs
 * that up: you can read your own reports and nobody else's.
 *
 * A REPORT IS NOT A COMPLAINT ABOUT THE PLACE. Washed-out roads, gates and
 * closures go through the "Site problem" tab in ReportPanel, which feeds the
 * zone-alert clustering. This is about the RECORD — spam, wrong location,
 * private property, abuse. Mixing them buries real spam under road conditions.
 */

const REASONS: { id: ContentReportReason; label: string; detail: string }[] = [
  {
    id: 'private_property',
    label: 'This is private land',
    detail: 'The spot is on land the public cannot camp on.'
  },
  {
    id: 'wrong_location',
    label: 'The location is wrong',
    detail: 'The pin is not where the spot actually is.'
  },
  {
    id: 'not_camping',
    label: 'You cannot camp here',
    detail: 'A real place, but not somewhere you can stay.'
  },
  {
    id: 'unsafe',
    label: 'Unsafe or dangerous',
    detail: 'Getting here or staying here puts people at risk.'
  },
  {
    id: 'spam',
    label: 'Spam or advertising',
    detail: 'Not a genuine contribution.'
  },
  {
    id: 'abusive',
    label: 'Abusive or offensive',
    detail: 'Harassment, slurs, or content aimed at a person.'
  },
  {
    id: 'other',
    label: 'Something else',
    detail: 'Tell us below.'
  }
];

interface ReportContentSheetProps {
  isOpen: boolean;
  onClose: () => void;
  targetKind: ReportTargetKind;
  targetId: string;
  /** What is being reported, so the sheet can name it. */
  targetLabel: string;
  /** Signed out, reporting is impossible — the policy requires a session. */
  onRequireAuth: () => void;
  isSignedIn: boolean;
}

export const ReportContentSheet: React.FC<ReportContentSheetProps> = ({
  isOpen, onClose, targetKind, targetId, targetLabel, onRequireAuth, isSignedIn
}) => {
  const toast = useToast();
  const [reason, setReason] = useState<ContentReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [isSending, setIsSending] = useState(false);

  const submit = async () => {
    if (!reason) return;
    if (!isSignedIn) { onRequireAuth(); return; }

    setIsSending(true);
    const result = await reportContent(targetKind, targetId, reason, detail);
    setIsSending(false);

    if (!result.ok) {
      toast.error('Could not send that report', result.message);
      return;
    }

    /**
     * Says thanks, promises nothing.
     *
     * Not "this will be removed" — three distinct reporters hide it
     * automatically and one might not, and an app that promises a takedown it
     * may not perform is doing the thing this codebase exists not to do.
     */
    toast.success('Thanks — we will take a look', 'Reports are private.');
    setReason(null);
    setDetail('');
    onClose();
  };

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      title="Report this"
      subtitle={targetLabel}
      icon={<Flag className="w-4 h-4 text-rose-400" />}
      footer={
        <button
          onClick={submit}
          disabled={!reason || isSending}
          className="w-full px-4 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:hover:bg-rose-600"
        >
          {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Flag className="w-4 h-4" />}
          {isSending ? 'Sending…' : isSignedIn ? 'Send report' : 'Sign in to report'}
        </button>
      }
    >
      <div className="space-y-2">
        {REASONS.map((r) => (
          <button
            key={r.id}
            onClick={() => setReason(r.id)}
            className={`w-full text-left px-3 py-2.5 rounded-xl border ${
              reason === r.id
                ? 'bg-rose-950/50 border-rose-600/60'
                : 'bg-slate-800/50 border-slate-700/60 hover:bg-slate-800'
            }`}
          >
            <span className="block text-xs font-bold text-slate-100">{r.label}</span>
            <span className="block text-[12px] text-slate-400 mt-0.5">{r.detail}</span>
          </button>
        ))}

        <label className="block pt-1">
          <span className="text-[12px] font-bold uppercase tracking-wider text-slate-400">
            Anything else worth knowing
          </span>
          <textarea
            rows={3}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            maxLength={1000}
            placeholder="Optional. What did you see?"
            className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl p-2.5 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-rose-500"
          />
        </label>

        <p className="text-[12px] text-slate-500 leading-snug">
          Reports are private — nobody sees who filed one, and no count is shown
          anywhere. If a few people report the same thing it is hidden while it
          is checked, not deleted.
        </p>
      </div>
    </Sheet>
  );
};
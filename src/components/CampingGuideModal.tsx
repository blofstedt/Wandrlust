import React from 'react';
import { BookOpen, ShieldCheck, Flame, Trash2, TreePine, AlertTriangle, X, Compass, ExternalLink } from 'lucide-react';

interface CampingGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CampingGuideModal: React.FC<CampingGuideModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[2600] bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-3xl shadow-2xl p-6 text-slate-100 space-y-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/40">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-['Outfit'] font-bold text-lg">Public Lands & Dispersed Camping Field Guide</h2>
              <p className="text-xs text-slate-400">Rules, Regulations & Leave No Trace Etiquette</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white border border-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4 text-xs text-slate-300">
          {/* BLM vs USFS Section */}
          <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-2">
            <h3 className="font-bold text-slate-100 text-sm flex items-center gap-2">
              <Compass className="w-4 h-4 text-amber-400" />
              BLM Land vs. National Forest (USFS) Dispersed Rules
            </h3>
            <ul className="space-y-2 text-slate-300 list-disc list-inside leading-relaxed">
              <li>
                <strong className="text-amber-300">14-Day Limit:</strong> Most BLM and Forest Service lands allow free camping for up to 14 days within any 28-day period. After 14 days, you must move your camp at least 25 miles away.
              </li>
              <li>
                <strong className="text-emerald-300">Setback Distances:</strong> Camp at least 200 feet away from lakes, streams, and natural water sources to protect fragile habitats.
              </li>
              <li>
                <strong className="text-teal-300">Existing Pulloffs:</strong> Always use existing cleared pulloffs or established fire rings. Do not create new clearings or cut live vegetation.
              </li>
            </ul>
          </div>

          {/* Waste & Human Waste */}
          <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-2">
            <h3 className="font-bold text-slate-100 text-sm flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-rose-400" />
              Human Waste & Portable Toilets (WAG Bags)
            </h3>
            <p className="leading-relaxed">
              In fragile desert areas (such as Moab BLM, Alabama Hills, and Grand Staircase-Escalante), campers are <strong>legally required</strong> to carry a portable toilet or approved WAG waste bag system. Cat-holes are not permitted in high-impact red rock desert soils.
            </p>
          </div>

          {/* Fire Safety & Permits */}
          <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-2">
            <h3 className="font-bold text-slate-100 text-sm flex items-center gap-2">
              <Flame className="w-4 h-4 text-red-400" />
              Wildfire Prevention & Campfire Permits
            </h3>
            <div className="space-y-1.5 text-slate-300">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <span>Always check stage 1 and stage 2 fire restrictions before lighting any campfire.</span>
              </div>
              <div>
                In states like California, a free online <strong className="text-amber-300">Campfire Permit</strong> is required even for portable gas stoves on public land.
              </div>
            </div>
          </div>

          {/* Official Agency Links */}
          <div className="pt-2 flex flex-wrap gap-3 text-[11px]">
            <a
              href="https://www.blm.gov/programs/recreation/camping"
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-700 flex items-center gap-1 font-semibold"
            >
              BLM Camping Regulations <ExternalLink className="w-3 h-3" />
            </a>
            <a
              href="https://www.fs.usda.gov/"
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700 flex items-center gap-1 font-semibold"
            >
              US Forest Service Guides <ExternalLink className="w-3 h-3" />
            </a>
            <a
              href="https://lnt.org/"
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-teal-300 border border-slate-700 flex items-center gap-1 font-semibold"
            >
              Leave No Trace Center <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};



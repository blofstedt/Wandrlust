import React, { useState, useEffect } from 'react';
import { OfflineRegion, Campsite } from '../types';
import {
  getDownloadedRegions,
  downloadOfflineRegion,
  deleteOfflineRegion
} from '../services/offlineStorage';
import { Download, WifiOff, Trash2, CheckCircle2, Shield, HardDrive, MapPin, X } from 'lucide-react';

interface OfflineManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentLocationName: string;
  center: [number, number];
  campsitesInView: Campsite[];
  isOfflineMode: boolean;
  setIsOfflineMode: (offline: boolean) => void;
}

export const OfflineManagerModal: React.FC<OfflineManagerModalProps> = ({
  isOpen,
  onClose,
  currentLocationName,
  center,
  campsitesInView,
  isOfflineMode,
  setIsOfflineMode
}) => {
  const [regions, setRegions] = useState<OfflineRegion[]>([]);
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState(0);

  const loadRegions = async () => {
    const list = await getDownloadedRegions();
    setRegions(list);
  };

  useEffect(() => {
    if (isOpen) {
      loadRegions();
    }
  }, [isOpen]);

  const handleDownloadCurrentRegion = async () => {
    setIsDownloading(true);
    setProgress(0);

    const regionName = `${currentLocationName || 'Dispersed Area'} Sector`;
    const bounds = {
      north: center[0] + 0.3,
      south: center[0] - 0.3,
      east: center[1] + 0.3,
      west: center[1] - 0.3
    };

    await downloadOfflineRegion(
      regionName,
      center,
      bounds,
      campsitesInView,
      (pct) => setProgress(pct)
    );

    await loadRegions();
    setIsDownloading(false);
  };

  const handleDelete = async (id: string) => {
    await deleteOfflineRegion(id);
    await loadRegions();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[2600] bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200">
      <div className="relative w-full max-w-xl bg-slate-900 border border-slate-700 rounded-3xl shadow-2xl p-6 text-slate-100 space-y-6">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-teal-500/20 text-teal-400 border border-teal-500/40">
              <Download className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-['Outfit'] font-bold text-lg">Offline Map Package Manager</h2>
              <p className="text-xs text-slate-400">Download topographic tiles & campsites for remote wilderness</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl bg-slate-800 text-slate-400 hover:text-white border border-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Offline Mode Switch Box */}
        <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <WifiOff className={`w-5 h-5 ${isOfflineMode ? 'text-amber-400 animate-pulse' : 'text-slate-500'}`} />
            <div>
              <div className="font-bold text-xs text-slate-200">Simulate Wilderness Connection (Offline Mode)</div>
              <div className="text-[11px] text-slate-400">Forces map to use stored offline tiles & downloaded sites</div>
            </div>
          </div>
          <button
            onClick={() => setIsOfflineMode(!isOfflineMode)}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all ${
              isOfflineMode
                ? 'bg-amber-500 text-slate-950 border-amber-300'
                : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
            }`}
          >
            {isOfflineMode ? 'OFFLINE ON' : 'OFFLINE OFF'}
          </button>
        </div>

        {/* Download Current Area Action */}
        <div className="p-4 rounded-2xl bg-emerald-950/40 border border-emerald-800/60 space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">Current Search Viewport</span>
              <h3 className="font-bold text-base text-slate-100 mt-0.5">{currentLocationName || 'Selected Public Land Zone'}</h3>
              <p className="text-xs text-slate-300">
                Includes {campsitesInView.length} free campsites and surrounding 30-mile topomap tiles.
              </p>
            </div>
            <HardDrive className="w-5 h-5 text-emerald-400 shrink-0" />
          </div>

          {isDownloading ? (
            <div className="space-y-1.5 pt-2">
              <div className="flex justify-between text-xs font-bold text-emerald-300">
                <span>Caching Map Tiles & Coordinates...</span>
                <span>{progress}%</span>
              </div>
              <div className="w-full bg-slate-950 rounded-full h-2.5 overflow-hidden border border-emerald-900">
                <div
                  className="bg-gradient-to-r from-teal-500 to-emerald-400 h-full transition-all duration-150"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          ) : (
            <button
              onClick={handleDownloadCurrentRegion}
              className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-950 transition-all"
            >
              <Download className="w-4 h-4" />
              Download Offline Package for "{currentLocationName || 'Current Map'}" (~12 MB)
            </button>
          )}
        </div>

        {/* Saved Offline Regions List */}
        <div>
          <h4 className="font-bold text-xs text-slate-400 uppercase tracking-wider mb-2">
            Stored Offline Regions ({regions.length})
          </h4>

          {regions.length === 0 ? (
            <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 text-center text-xs text-slate-400">
              No offline packages stored yet. Download your target camping region before heading out!
            </div>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {regions.map((reg) => (
                <div
                  key={reg.id}
                  className="p-3 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <div>
                      <div className="font-bold text-slate-200">{reg.name}</div>
                      <div className="text-[10px] text-slate-400">
                        {reg.sizeMb} MB • {reg.campsiteCount} Sites • Downloaded {reg.downloadedAt}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(reg.id)}
                    className="p-1.5 rounded-lg text-rose-400 hover:bg-rose-950/50 transition-colors"
                    title="Delete package"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

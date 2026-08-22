import React, { useState, useEffect, useMemo } from 'react';
import { OfflineRegion, Campsite } from '../types';
import { distanceMiles } from '../utils/geo';
import {
  getDownloadedRegions,
  downloadOfflineRegion,
  deleteOfflineRegion,
  type OfflineDownloadResult
} from '../services/offlineStorage';
import {
  MapDataChoice,
  PackStatus,
  PackProgress,
  getMapDataChoice,
  setMapDataChoice,
  getPackStatus,
  downloadLandPack,
  deleteLandPack
} from '../services/landOverlayService';
import {
  Download, WifiOff, Trash2, CheckCircle2, HardDrive, X,
  Zap, AlertTriangle, Loader2
} from 'lucide-react';

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
  /** The last download's real outcome. Cleared when a new one starts. */
  const [downloadResult, setDownloadResult] = useState<OfflineDownloadResult | null>(null);

  /* Which map data this device carries — see landOverlayService. */
  const [choice, setChoice] = useState<MapDataChoice>(null);
  const [packStatus, setPackStatus] = useState<PackStatus | null>(null);
  const [packProgress, setPackProgress] = useState<PackProgress | null>(null);
  const [packBusy, setPackBusy] = useState(false);
  const [packMessage, setPackMessage] = useState<string | null>(null);

  const loadRegions = async () => {
    const list = await getDownloadedRegions();
    setRegions(list);
  };

  const loadLandState = async () => {
    setChoice(await getMapDataChoice());
    setPackStatus(await getPackStatus());
  };

  useEffect(() => {
    if (isOpen) {
      loadRegions();
      loadLandState();
    }
  }, [isOpen]);

  const handleDownloadPack = async () => {
    setPackBusy(true);
    setPackMessage(null);

    const result = await downloadLandPack((p) => setPackProgress(p));

    /*
     * Only a COMPLETE download flips the setting to "full". A partial one
     * leaves the device on the quick map and says how far it got — telling a
     * camper they hold detailed maps for a continent when they hold two thirds
     * of one is a lie they would discover by driving into the missing third.
     */
    if (result.ok) await setMapDataChoice('full');

    setPackMessage(result.message);
    setPackBusy(false);
    setPackProgress(null);
    await loadLandState();
  };

  const handleDeletePack = async () => {
    await deleteLandPack();
    await setMapDataChoice('quick');
    setPackMessage('Full-detail maps removed. Back to the quick map.');
    await loadLandState();
  };

  const handleUseQuick = async () => {
    await setMapDataChoice('quick');
    await loadLandState();
  };

  /** Half-width of the downloaded box, in degrees, each way from centre. */
  const REGION_HALF_SPAN_DEG = 0.3;

  /**
   * How far the pack actually reaches, in miles.
   *
   * The box is a fixed span in DEGREES, and a degree of longitude shrinks as
   * you go north — 0.3° is about 21 miles north-south everywhere, but only
   * ~13 east-west at Calgary and less again further up. Quoting one round
   * number for "around this point" would overstate the narrow direction by
   * half, so both are measured from the real bounds and shown.
   */
  const reachMiles = useMemo(() => ({
    northSouth: Math.round(
      distanceMiles(center[0], center[1], center[0] + REGION_HALF_SPAN_DEG, center[1])
    ),
    eastWest: Math.round(
      distanceMiles(center[0], center[1], center[0], center[1] + REGION_HALF_SPAN_DEG)
    )
  }), [center]);

  const handleDownloadCurrentRegion = async () => {
    setIsDownloading(true);
    setProgress(0);
    setDownloadResult(null);

    const regionName = `${currentLocationName || 'Dispersed Area'} Sector`;
    const bounds = {
      north: center[0] + REGION_HALF_SPAN_DEG,
      south: center[0] - REGION_HALF_SPAN_DEG,
      east: center[1] + REGION_HALF_SPAN_DEG,
      west: center[1] - REGION_HALF_SPAN_DEG
    };

    const result = await downloadOfflineRegion(
      regionName,
      center,
      bounds,
      campsitesInView,
      (pct) => setProgress(pct)
    );

    // Said out loud, whichever way it went. A pack that is short is exactly
    // the thing a camper needs to know about BEFORE they lose signal.
    setDownloadResult(result);

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
              <div className="text-xs text-slate-400">Forces map to use stored offline tiles & downloaded sites</div>
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

        {/* ------------------------------------------------------------ */}
        {/* Public land map data                                          */}
        {/* ------------------------------------------------------------ */}
        {/*
          The same choice made on first run, changeable here.

          The quick map's limitation is repeated in full rather than
          summarised, because this is where somebody checks what they are
          carrying the night before they leave — and a caveat they only saw
          once, weeks ago, on a screen they tapped through, is not a caveat
          they have.
        */}
        <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="font-bold text-xs text-slate-200">Public land boundaries</h4>
              <p className="text-xs text-slate-400">
                Which BLM / National Forest / Crown land data this phone carries
              </p>
            </div>
            {choice === 'full' ? (
              <span className="px-2.5 py-1 rounded-lg bg-sky-500/15 text-sky-300 border border-sky-500/40 text-[12px] font-bold shrink-0">
                FULL DETAIL
              </span>
            ) : (
              <span className="px-2.5 py-1 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 text-[12px] font-bold shrink-0">
                QUICK MAP
              </span>
            )}
          </div>

          {choice === 'full' && packStatus?.downloadedAt ? (
            <div className="space-y-2">
              <div className="flex items-start gap-2 p-2.5 rounded-xl bg-sky-950/40 border border-sky-800/50">
                <CheckCircle2 className="w-4 h-4 text-sky-400 shrink-0 mt-px" />
                <p className="text-xs text-sky-100/90 leading-relaxed">
                  Real boundaries stored on this phone —{' '}
                  {packStatus.parcelCount.toLocaleString()} areas, {packStatus.sizeMb} MB.
                  These work with no signal.
                  {packStatus.truncated && (
                    <>
                      {' '}
                      <span className="text-amber-300">
                        Some dense areas hit a per-section limit, so a few parcels are
                        missing.
                      </span>
                    </>
                  )}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleDownloadPack}
                  disabled={packBusy}
                  className="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 font-bold text-xs transition-colors"
                >
                  Refresh
                </button>
                <button
                  onClick={handleDeletePack}
                  disabled={packBusy}
                  className="px-3 py-2 rounded-xl bg-rose-950/50 hover:bg-rose-900/50 disabled:opacity-40 text-rose-300 font-bold text-xs flex items-center gap-1.5 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-start gap-2 p-2.5 rounded-xl bg-amber-950/40 border border-amber-800/50">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-px" />
                <p className="text-xs text-amber-200/90 leading-relaxed">
                  You’re on the quick map: edges are approximate — up to about a
                  kilometre out — and small areas are missing.{' '}
                  <strong className="text-amber-100">
                    With no signal it won’t tell you where a boundary really is.
                  </strong>
                </p>
              </div>

              {packBusy ? (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-bold text-sky-300">
                    <span className="flex items-center gap-1.5">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Downloading full detail…
                    </span>
                    <span>
                      {packProgress
                        ? `${packProgress.cellsDone}/${packProgress.cellsTotal} · ${packProgress.sizeMb} MB`
                        : 'starting'}
                    </span>
                  </div>
                  <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-sky-900">
                    <div
                      className="bg-gradient-to-r from-sky-500 to-cyan-400 h-full"
                      style={{
                        width: packProgress
                          ? `${Math.round((packProgress.cellsDone / Math.max(packProgress.cellsTotal, 1)) * 100)}%`
                          : '0%'
                      }}
                    />
                  </div>
                </div>
              ) : (
                <button
                  onClick={handleDownloadPack}
                  className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs flex items-center justify-center gap-2 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download full detail (large — use wifi)
                </button>
              )}

              {choice === null && !packBusy && (
                <button
                  onClick={handleUseQuick}
                  className="w-full py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold text-xs flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Zap className="w-3.5 h-3.5" />
                  Stay on the quick map
                </button>
              )}
            </div>
          )}

          {packMessage && (
            <p className="text-xs text-slate-400 leading-relaxed">{packMessage}</p>
          )}
        </div>

        {/* Download Current Area Action */}
        <div className="p-4 rounded-2xl bg-emerald-950/40 border border-emerald-800/60 space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[12px] font-bold text-emerald-400 uppercase tracking-wider">Current Search Viewport</span>
              <h3 className="font-bold text-base text-slate-100 mt-0.5">{currentLocationName || 'Selected Public Land Zone'}</h3>
              <p className="text-xs text-slate-300">
                {campsitesInView.length} free campsites, plus topo tiles reaching about{' '}
                {reachMiles.eastWest} miles east and west and {reachMiles.northSouth} north
                and south of here.
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
            <>
              <button
                onClick={handleDownloadCurrentRegion}
                className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-950 transition-all"
              >
                <Download className="w-4 h-4" />
                Download this area for offline use
              </button>

              {/*
                The honest answer, good or bad. The size is only known after
                the fact — the button used to promise "~12 MB" for every
                region regardless, which was a guess wearing a number.
              */}
              {downloadResult && (
                <div
                  role="status"
                  className={`flex items-start gap-2 p-2.5 rounded-xl text-xs leading-relaxed border ${
                    downloadResult.ok
                      ? 'bg-emerald-950/50 border-emerald-800/60 text-emerald-200'
                      : 'bg-amber-950/50 border-amber-800/60 text-amber-200'
                  }`}
                >
                  {downloadResult.ok ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-px text-emerald-400" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-px text-amber-400" />
                  )}
                  <span>{downloadResult.message}</span>
                </div>
              )}
            </>
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
                  {/*
                    A tick is a claim. Regions saved before this app knew the
                    difference have no `complete` flag at all, so they are
                    treated as unknown rather than quietly passed as whole.
                  */}
                  <div className="flex items-center gap-2.5">
                    {reg.complete === false ? (
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    )}
                    <div>
                      <div className="font-bold text-slate-200">{reg.name}</div>
                      <div className="text-[12px] text-slate-400">
                        {reg.sizeMb} MB • {reg.campsiteCount} sites • {reg.downloadedAt}
                      </div>
                      {reg.complete === false && (
                        <div className="text-[12px] text-amber-300/90">
                          Partial — {reg.tileCount} of {reg.tilesRequested} tiles.
                          Some of this area will be blank.
                        </div>
                      )}
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


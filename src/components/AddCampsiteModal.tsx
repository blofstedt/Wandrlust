import React, { useEffect, useState } from 'react';
import { PlusCircle, X, Check, AlertTriangle, Loader2 } from 'lucide-react';
import type { Campsite, LandType, RoadAccess, ToiletType, WaterType } from '../types';
import { newUserCampsiteId } from '../utils/campsiteId';

interface AddCampsiteModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Saves the spot and tries to share it.
   *
   * Async because the share is a network write and the form must not close
   * before it resolves — a modal that vanishes while the request is in flight
   * gives the user no way to know whether it worked.
   */
  onAdd: (site: Campsite) => Promise<void> | void;
  defaultCenter: [number, number];
}

const inputClass =
  'w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500';
const labelClass = 'text-[11px] font-bold text-slate-400 uppercase';

export const AddCampsiteModal: React.FC<AddCampsiteModalProps> = ({
  isOpen, onClose, onAdd, defaultCenter
}) => {
  const [name, setName] = useState('');
  const [landType, setLandType] = useState<LandType>('blm');
  const [landManager, setLandManager] = useState('Bureau of Land Management');
  const [lat, setLat] = useState(defaultCenter[0].toFixed(5));
  const [lon, setLon] = useState(defaultCenter[1].toFixed(5));
  const [city, setCity] = useState('');
  const [stateProvince, setStateProvince] = useState('');
  const [description, setDescription] = useState('');
  const [roadAccess, setRoadAccess] = useState<RoadAccess>('gravel');
  const [water, setWater] = useState<WaterType>('none');
  const [toilet, setToilet] = useState<ToiletType>('none');
  const [maxRvLength, setMaxRvLength] = useState(30);
  const [imageUrl, setImageUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Seed the coordinates from wherever the map is each time it opens — the
  // form used to keep whatever the centre was on first mount.
  useEffect(() => {
    if (!isOpen) return;
    setLat(defaultCenter[0].toFixed(5));
    setLon(defaultCenter[1].toFixed(5));
    setError(null);
  }, [isOpen, defaultCenter]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);

    if (!name.trim() || !city.trim()) {
      setError('A name and a nearest town are required.');
      return;
    }
    // A NaN or out-of-range coordinate used to sail straight through and put a
    // pin at (NaN, NaN), which silently vanishes from the map.
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      setError('Latitude must be a number between -90 and 90.');
      return;
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      setError('Longitude must be a number between -180 and 180.');
      return;
    }

    setIsSaving(true);
    await onAdd({
      id: newUserCampsiteId(),
      name: name.trim(),
      landType,
      landManager: landManager.trim(),
      latitude,
      longitude,
      address: {
        nearestCity: city.trim(),
        stateProvince: stateProvince.trim(),
        country: ''
      },
      description: description.trim() || 'User submitted public land camping site.',
      /**
       * Only what the person filling in the form actually told us.
       *
       * This used to attach signal bars, shade and a 14-day stay limit that
       * appear nowhere on the form — so a user reporting a site they had
       * visited unknowingly published four facts they had never been asked
       * about, indistinguishable from the ones they had.
       */
      amenities: {
        water,
        toilet,
        roadAccess,
        maxRvLengthFeet: Number(maxRvLength) || undefined
      },
      images: imageUrl.trim() ? [imageUrl.trim()] : [],
      reviews: [],
      // No reviews means no rating. It used to ship as 5.0 with one phantom
      // review, which quietly inflated every user submission to the top of the
      // "highest rated" sort.
      rating: 0,
      reviewCount: 0,
      source: 'user_submitted'
    });
    setIsSaving(false);

    setName('');
    setCity('');
    setDescription('');
    setImageUrl('');
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[2600] bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto anim-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Submit a campsite"
        className="relative w-full max-w-xl bg-slate-900 border border-slate-700 rounded-3xl shadow-2xl p-6 text-slate-100 space-y-5 max-h-[90vh] overflow-y-auto scroll-soft anim-expand"
      >
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <PlusCircle className="w-5 h-5 text-emerald-400" />
            <h2 className="font-['Outfit'] font-bold text-lg">Submit a dispersed campsite</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white border border-slate-700"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div>
            <label className={labelClass} htmlFor="site-name">Campsite or area name *</label>
            <input
              id="site-name" type="text" required value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Gemini Bridges BLM camping"
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="site-land">Land type</label>
              <select
                id="site-land" value={landType}
                onChange={(e) => setLandType(e.target.value as LandType)}
                className={inputClass}
              >
                <option value="blm">BLM land</option>
                <option value="usfs">USFS national forest</option>
                <option value="state_forest">State recreation land</option>
                <option value="crown_land">Crown land (Canada)</option>
                <option value="dispersed">Free dispersed area</option>
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="site-manager">Managing agency</label>
              <input
                id="site-manager" type="text" value={landManager}
                onChange={(e) => setLandManager(e.target.value)}
                placeholder="e.g. BLM Moab Field Office"
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="site-lat">Latitude</label>
              <input
                id="site-lat" type="number" step="any" required value={lat}
                onChange={(e) => setLat(e.target.value)} className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="site-lon">Longitude</label>
              <input
                id="site-lon" type="number" step="any" required value={lon}
                onChange={(e) => setLon(e.target.value)} className={inputClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="site-city">Nearest town *</label>
              <input
                id="site-city" type="text" required value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. Moab" className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="site-state">State or province</label>
              <input
                id="site-state" type="text" value={stateProvince}
                onChange={(e) => setStateProvince(e.target.value)}
                placeholder="e.g. Utah" className={inputClass}
              />
            </div>
          </div>

          <div>
            <label className={labelClass} htmlFor="site-desc">Description and access notes</label>
            <textarea
              id="site-desc" rows={3} value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Pullouts, terrain, views, road conditions…"
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="site-road">Road access</label>
              <select
                id="site-road" value={roadAccess}
                onChange={(e) => setRoadAccess(e.target.value as RoadAccess)}
                className={inputClass}
              >
                <option value="paved">Paved</option>
                <option value="gravel">Dirt or gravel (2WD)</option>
                <option value="high_clearance">High clearance</option>
                <option value="4x4_only">4x4 only</option>
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="site-rig">Biggest rig that fits</label>
              <select
                id="site-rig" value={maxRvLength}
                onChange={(e) => setMaxRvLength(Number(e.target.value))}
                className={inputClass}
              >
                <option value={0}>Tent only</option>
                <option value={20}>20 ft camper van</option>
                <option value={30}>30 ft Class C</option>
                <option value={45}>40 ft+ big rig</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="site-water">Water</label>
              <select
                id="site-water" value={water}
                onChange={(e) => setWater(e.target.value as WaterType)}
                className={inputClass}
              >
                <option value="none">None</option>
                <option value="potable">Potable</option>
                <option value="natural_stream">Stream or creek</option>
                <option value="seasonal_creek">Seasonal creek</option>
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="site-toilet">Toilet</label>
              <select
                id="site-toilet" value={toilet}
                onChange={(e) => setToilet(e.target.value as ToiletType)}
                className={inputClass}
              >
                <option value="none">None — pack it out</option>
                <option value="vault">Vault toilet</option>
                <option value="flush">Flush toilet</option>
                <option value="pack_out">Pack-out required</option>
              </select>
            </div>
          </div>

          <div>
            <label className={labelClass} htmlFor="site-photo">Photo URL (optional)</label>
            <input
              id="site-photo" type="url" value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://…"
              className={inputClass}
            />
            <p className="text-[10px] text-slate-500 mt-1">
              Leave this blank and we&apos;ll show a satellite view of the coordinates.
            </p>
          </div>

          {error && (
            <p className="flex items-start gap-1.5 text-[11px] text-rose-300 bg-rose-950/50 border border-rose-800/50 rounded-lg p-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={isSaving}
            className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-950 disabled:opacity-60 disabled:hover:bg-emerald-600"
          >
            {isSaving
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Check className="w-4 h-4" />}
            {isSaving ? 'Saving…' : 'Add this spot'}
          </button>
          {/*
            Said before they commit, not after. A spot added while signed out
            is genuinely only on this device — the insert policy requires a
            session — and finding that out afterwards feels like the app lost
            it.
          */}
          <p className="text-[10px] text-slate-500 leading-snug text-center">
            Saved to this device straight away. Signed in, it also goes to the
            review queue so other campers can eventually see it.
          </p>
        </form>
      </div>
    </div>
  );
};
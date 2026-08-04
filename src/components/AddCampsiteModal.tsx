import React, { useState } from 'react';
import { Campsite, LandType, RoadAccess, ToiletType, WaterType } from '../types';
import { PlusCircle, X, MapPin, Check } from 'lucide-react';

interface AddCampsiteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (site: Campsite) => void;
  defaultCenter: [number, number];
}

export const AddCampsiteModal: React.FC<AddCampsiteModalProps> = ({
  isOpen,
  onClose,
  onAdd,
  defaultCenter
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
  const [verizonBars, setVerizonBars] = useState(3);
  const [attBars, setAttBars] = useState(3);
  const [maxRvLength, setMaxRvLength] = useState(30);
  const [fireRing, setFireRing] = useState(true);
  const [petFriendly, setPetFriendly] = useState(true);
  const [imageUrl, setImageUrl] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !city.trim()) return;

    const newSite: Campsite = {
      id: `custom-${Date.now()}`,
      name: name.trim(),
      landType,
      landManager: landManager.trim(),
      latitude: parseFloat(lat),
      longitude: parseFloat(lon),
      address: {
        nearestCity: city.trim(),
        stateProvince: stateProvince.trim() || 'US',
        country: 'United States'
      },
      description: description.trim() || 'User submitted public land camping site.',
      amenities: {
        water,
        toilet,
        roadAccess,
        cellSignal: { verizon: verizonBars, att: attBars, tmobile: 2 },
        maxRvLengthFeet: Number(maxRvLength),
        fireRing,
        petFriendly,
        trashService: false,
        shade: 'partial',
        stayLimitDays: 14,
        isFree: true,
        permitRequired: false
      },
      images: [
        imageUrl.trim() ||
          'https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?auto=format&fit=crop&w=1000&q=80'
      ],
      reviews: [],
      rating: 5.0,
      reviewCount: 1,
      source: 'user_submitted'
    };

    onAdd(newSite);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[2600] bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto animate-in fade-in duration-200">
      <div className="relative w-full max-w-xl bg-slate-900 border border-slate-700 rounded-3xl shadow-2xl p-6 text-slate-100 space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <PlusCircle className="w-5 h-5 text-emerald-400" />
            <h2 className="font-['Outfit'] font-bold text-lg">Submit Dispersed Campsite</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl bg-slate-800 text-slate-400 hover:text-white border border-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div>
            <label className="text-[11px] font-bold text-slate-400 uppercase">Campsite / Area Name *</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Gemini Bridges BLM Camping"
              className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase">Land Type</label>
              <select
                value={landType}
                onChange={(e) => setLandType(e.target.value as LandType)}
                className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100"
              >
                <option value="blm">BLM Land</option>
                <option value="usfs">USFS National Forest</option>
                <option value="state_forest">State Recreation Land</option>
                <option value="crown_land">Crown Land (Canada)</option>
                <option value="dispersed">Free Dispersed Area</option>
              </select>
            </div>

            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase">Managing Agency</label>
              <input
                type="text"
                value={landManager}
                onChange={(e) => setLandManager(e.target.value)}
                placeholder="e.g. BLM Moab Office"
                className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase">Latitude</label>
              <input
                type="number"
                step="any"
                required
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100"
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase">Longitude</label>
              <input
                type="number"
                step="any"
                required
                value={lon}
                onChange={(e) => setLon(e.target.value)}
                className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase">Nearest City *</label>
              <input
                type="text"
                required
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. Moab"
                className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100"
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase">State / Province</label>
              <input
                type="text"
                value={stateProvince}
                onChange={(e) => setStateProvince(e.target.value)}
                placeholder="e.g. Utah"
                className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100"
              />
            </div>
          </div>

          <div>
            <label className="text-[11px] font-bold text-slate-400 uppercase">Description & Access Directions</label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe pullouts, terrain, views, and road conditions..."
              className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl p-2.5 text-slate-100"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase">Road Access</label>
              <select
                value={roadAccess}
                onChange={(e) => setRoadAccess(e.target.value as RoadAccess)}
                className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100"
              >
                <option value="paved">Paved Road</option>
                <option value="gravel">Dirt / Gravel (2WD)</option>
                <option value="high_clearance">High Clearance 2WD</option>
                <option value="4x4_only">4x4 Rough Track</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase">Max RV Rig Size</label>
              <select
                value={maxRvLength}
                onChange={(e) => setMaxRvLength(Number(e.target.value))}
                className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100"
              >
                <option value={0}>Tent Only</option>
                <option value={20}>20ft Camper Van</option>
                <option value={30}>30ft Class C / Rig</option>
                <option value={45}>40ft+ Big Rig Friendly</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-[11px] font-bold text-slate-400 uppercase">Photo Image URL</label>
            <input
              type="url"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://..."
              className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-slate-100"
            />
          </div>

          <button
            type="submit"
            className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-950"
          >
            <Check className="w-4 h-4" />
            Add Spot to Wandrlust Map
          </button>
        </form>
      </div>
    </div>
  );
};



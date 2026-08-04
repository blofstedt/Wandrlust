import React, { useState } from 'react';
import { Campsite, CamperReview } from '../types';
import { getCampsiteDisplayImage, getCloseSatelliteImageUrl, getStreetViewUrl } from '../utils/imageUtils';
import {
  X,
  MapPin,
  Star,
  Compass,
  Wifi,
  Droplet,
  Truck,
  Flame,
  Dog,
  Trash2,
  Calendar,
  ShieldCheck,
  Bookmark,
  Share2,
  Copy,
  Check,
  ExternalLink,
  MessageSquare,
  Send,
  Navigation,
  TreePine,
  Maximize2,
  Camera,
  Layers
} from 'lucide-react';

interface CampsiteDetailModalProps {
  campsite: Campsite;
  isSaved: boolean;
  onClose: () => void;
  onToggleSave: (site: Campsite) => void;
  onAddReview: (siteId: string, review: CamperReview) => void;
}

export const CampsiteDetailModal: React.FC<CampsiteDetailModalProps> = ({
  campsite,
  isSaved,
  onClose,
  onToggleSave,
  onAddReview
}) => {
  const [copiedCoords, setCopiedCoords] = useState(false);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [imageMode, setImageMode] = useState<'photo' | 'aerial'>('photo');

  // Add review form state
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [authorName, setAuthorName] = useState('');
  const [rating, setRating] = useState(5);
  const [commentText, setCommentText] = useState('');
  const [vehicleType, setVehicleType] = useState('Van / Camper');

  const coordsString = `${campsite.latitude.toFixed(5)}, ${campsite.longitude.toFixed(5)}`;

  const handleCopyCoords = () => {
    navigator.clipboard.writeText(coordsString);
    setCopiedCoords(true);
    setTimeout(() => setCopiedCoords(false), 2000);
  };

  const handleSubmitReview = (e: React.FormEvent) => {
    e.preventDefault();
    if (!authorName.trim() || !commentText.trim()) return;

    const newReview: CamperReview = {
      id: `rev-${Date.now()}`,
      author: authorName,
      date: new Date().toISOString().split('T')[0],
      rating,
      comment: commentText,
      vehicleType
    };

    onAddReview(campsite.id, newReview);
    setAuthorName('');
    setCommentText('');
    setShowReviewForm(false);
  };

  return (
    <div className="fixed inset-0 z-[2000] bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 overflow-y-auto animate-in fade-in duration-200">
      <div className="relative w-full max-w-3xl bg-slate-900 border border-slate-700 rounded-3xl shadow-2xl overflow-hidden text-slate-100 max-h-[90vh] flex flex-col">
        {/* Modal Header Bar */}
        <div className="sticky top-0 z-20 bg-slate-900/95 border-b border-slate-800 px-5 py-3.5 flex items-center justify-between backdrop-blur-md">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-1 rounded-md bg-emerald-950 text-emerald-400 font-bold text-xs border border-emerald-800 uppercase">
              {campsite.landType.replace('_', ' ')}
            </span>
            <span className="text-xs text-slate-400 truncate max-w-[200px] sm:max-w-none">
              {campsite.landManager}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onToggleSave(campsite)}
              className={`p-2 rounded-xl border transition-all ${
                isSaved
                  ? 'bg-amber-500 text-slate-950 border-amber-300'
                  : 'bg-slate-800 text-slate-300 border-slate-700 hover:text-white'
              }`}
              title={isSaved ? 'Saved Offline' : 'Save Offline'}
            >
              <Bookmark className="w-4 h-4 fill-current" />
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-xl bg-slate-800 text-slate-400 hover:text-white border border-slate-700 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body Scroll Area */}
        <div className="overflow-y-auto p-5 space-y-6">
          {/* Main Photo Carousel & Header */}
          <div className="space-y-4">
            <div className="relative w-full h-64 sm:h-80 rounded-2xl overflow-hidden bg-slate-950 border border-slate-800">
              <img
                src={
                  imageMode === 'aerial'
                    ? getCloseSatelliteImageUrl(campsite.latitude, campsite.longitude)
                    : (campsite.images[activeImageIndex] || getCampsiteDisplayImage(campsite))
                }
                alt={campsite.name}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).src = getCloseSatelliteImageUrl(campsite.latitude, campsite.longitude);
                }}
                className="w-full h-full object-cover transition-all duration-300"
              />

              {/* View Switcher Controls Overlay */}
              <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5 bg-slate-950/80 border border-slate-700/80 p-1 rounded-xl backdrop-blur-md">
                <button
                  onClick={() => setImageMode('photo')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                    imageMode === 'photo'
                      ? 'bg-emerald-500 text-slate-950 font-bold shadow-md'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  <Camera className="w-3.5 h-3.5" />
                  Ground View
                </button>
                <button
                  onClick={() => setImageMode('aerial')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                    imageMode === 'aerial'
                      ? 'bg-emerald-500 text-slate-950 font-bold shadow-md'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  <Layers className="w-3.5 h-3.5" />
                  Zoomed Aerial
                </button>
                <a
                  href={getStreetViewUrl(campsite.latitude, campsite.longitude)}
                  target="_blank"
                  rel="noreferrer"
                  className="px-2.5 py-1 rounded-lg text-xs font-semibold text-cyan-300 hover:bg-cyan-950/60 border border-cyan-500/30 flex items-center gap-1.5 transition-all"
                  title="Open 360° Street View at GPS Location"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Street View
                </a>
              </div>

              {imageMode === 'photo' && campsite.images.length > 1 && (
                <div className="absolute bottom-3 left-3 flex gap-2 z-10">
                  {campsite.images.map((img, i) => (
                    <button
                      key={i}
                      onClick={() => setActiveImageIndex(i)}
                      className={`w-3 h-3 rounded-full border transition-all ${
                        activeImageIndex === i ? 'bg-emerald-400 border-white scale-125' : 'bg-slate-900/80 border-slate-600'
                      }`}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Title & Coordinates Strip */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h1 className="font-['Outfit'] font-extrabold text-2xl sm:text-3xl text-slate-100">
                  {campsite.name}
                </h1>
                <div className="flex items-center gap-2 text-sm text-slate-400 mt-1">
                  <MapPin className="w-4 h-4 text-emerald-400" />
                  <span>
                    {campsite.address.nearestCity}, {campsite.address.stateProvince}, {campsite.address.country}
                  </span>
                  {campsite.elevationFt && (
                    <>
                      <span>•</span>
                      <span className="text-slate-300">Elevation: {campsite.elevationFt.toLocaleString()} ft</span>
                    </>
                  )}
                </div>
              </div>

              {/* GPS Coords Copy & Map Links */}
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleCopyCoords}
                  className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 border border-slate-700 flex items-center gap-1.5 transition-all"
                  title="Copy Lat/Lon"
                >
                  {copiedCoords ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4 text-slate-400" />}
                  <span>{copiedCoords ? 'Copied!' : coordsString}</span>
                </button>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${campsite.latitude},${campsite.longitude}`}
                  target="_blank"
                  rel="noreferrer"
                  className="p-2 rounded-xl bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 border border-emerald-500/40 transition-all"
                  title="Open in Google Maps"
                >
                  <Navigation className="w-4 h-4" />
                </a>
              </div>
            </div>
          </div>

          {/* Location Description */}
          <div className="bg-slate-950/60 border border-slate-800/80 rounded-2xl p-4 text-sm text-slate-300 leading-relaxed">
            <h4 className="font-semibold text-slate-100 mb-1 flex items-center gap-1.5">
              <TreePine className="w-4 h-4 text-emerald-400" />
              Site Overview & Landscape
            </h4>
            <p>{campsite.description}</p>
          </div>

          {/* Alberta Crown Land Pass Regulations Callout */}
          {(campsite.landType === 'crown_land' || campsite.address.stateProvince.toLowerCase().includes('alberta')) && (
            <div className="bg-cyan-950/40 border border-cyan-500/40 rounded-2xl p-4 text-xs text-slate-200 space-y-3 shadow-lg">
              <div className="flex items-center justify-between pb-2 border-b border-cyan-500/20">
                <div className="flex items-center gap-2 font-bold text-sm text-cyan-300">
                  <ShieldCheck className="w-4 h-4 text-cyan-400" />
                  <span>Alberta Public Land Camping Pass Regulations</span>
                </div>
                <a
                  href="https://www.albertarelm.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="px-2.5 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 font-semibold text-[11px] border border-cyan-400/30 flex items-center gap-1 transition-all"
                >
                  <span>Buy on AlbertaRELM</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* When You Need a Pass */}
                <div className="bg-slate-900/80 p-3 rounded-xl border border-cyan-500/20 space-y-1.5">
                  <div className="font-bold text-cyan-300 text-[11px] uppercase tracking-wider flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                    When You Need a Pass
                  </div>
                  <ul className="space-y-1 text-slate-300 text-[11px] list-disc list-inside">
                    <li><strong>Eastern Slopes:</strong> Mandatory for anyone 18+ random camping along Rocky Mountains.</li>
                    <li><strong>Pass Cost:</strong> $20 per person for a 3-day pass, or $30 per person for an annual pass.</li>
                    <li><strong>Where to buy:</strong> Available online via AlbertaRELM.</li>
                    <li><strong>Specific Zones:</strong> Ghost PLUZ, McLean Creek PLUZ, Porcupine Hills PLUZ, Willmore Wilderness, etc.</li>
                  </ul>
                </div>

                {/* When You Do Not Need a Pass */}
                <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-700/60 space-y-1.5">
                  <div className="font-bold text-slate-400 text-[11px] uppercase tracking-wider flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    When You Do NOT Need a Pass
                  </div>
                  <ul className="space-y-1 text-slate-300 text-[11px] list-disc list-inside">
                    <li><strong>General Crown Land:</strong> Random camping on public land outside designated Eastern Slopes pass area is free.</li>
                    <li><strong>Day Use Exempt:</strong> Parking or recreating on public land during the day requires no pass.</li>
                    <li><strong>Exemptions:</strong> Status card holders, specific local residents, and low-income assistance recipients.</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Cellular Connectivity Matrix */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-4">
            <h4 className="font-semibold text-slate-100 text-sm mb-3 flex items-center gap-2">
              <Wifi className="w-4 h-4 text-teal-400" />
              Verified Cell Coverage (Signal Strength)
            </h4>
            <div className="grid grid-cols-3 gap-3 text-center text-xs">
              <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
                <div className="font-bold text-slate-300">Verizon</div>
                <div className="text-emerald-400 font-extrabold text-sm mt-0.5">
                  {'★'.repeat(campsite.amenities.cellSignal.verizon)}{'☆'.repeat(5 - campsite.amenities.cellSignal.verizon)}
                </div>
                <div className="text-[10px] text-slate-400 mt-1">{campsite.amenities.cellSignal.verizon}/5 Bars</div>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
                <div className="font-bold text-slate-300">AT&T</div>
                <div className="text-emerald-400 font-extrabold text-sm mt-0.5">
                  {'★'.repeat(campsite.amenities.cellSignal.att)}{'☆'.repeat(5 - campsite.amenities.cellSignal.att)}
                </div>
                <div className="text-[10px] text-slate-400 mt-1">{campsite.amenities.cellSignal.att}/5 Bars</div>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
                <div className="font-bold text-slate-300">T-Mobile</div>
                <div className="text-emerald-400 font-extrabold text-sm mt-0.5">
                  {'★'.repeat(campsite.amenities.cellSignal.tmobile)}{'☆'.repeat(5 - campsite.amenities.cellSignal.tmobile)}
                </div>
                <div className="text-[10px] text-slate-400 mt-1">{campsite.amenities.cellSignal.tmobile}/5 Bars</div>
              </div>
            </div>
          </div>

          {/* Amenities & Road Access Grid */}
          <div>
            <h4 className="font-semibold text-slate-100 text-sm mb-3">Key Site Features & Amenities</h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center gap-2.5">
                <Droplet className="w-4 h-4 text-sky-400 shrink-0" />
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-bold">Water Source</div>
                  <div className="font-semibold text-slate-200 capitalize">{campsite.amenities.water.replace('_', ' ')}</div>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center gap-2.5">
                <Truck className="w-4 h-4 text-amber-400 shrink-0" />
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-bold">Road Access</div>
                  <div className="font-semibold text-slate-200 capitalize">{campsite.amenities.roadAccess.replace('_', ' ')}</div>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center gap-2.5">
                <Flame className="w-4 h-4 text-red-400 shrink-0" />
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-bold">Fire Ring</div>
                  <div className="font-semibold text-slate-200">{campsite.amenities.fireRing ? 'Allowed' : 'Prohibited'}</div>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center gap-2.5">
                <Dog className="w-4 h-4 text-emerald-400 shrink-0" />
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-bold">Pets</div>
                  <div className="font-semibold text-slate-200">{campsite.amenities.petFriendly ? 'Allowed' : 'No Dogs'}</div>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center gap-2.5">
                <Calendar className="w-4 h-4 text-teal-400 shrink-0" />
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-bold">Stay Limit</div>
                  <div className="font-semibold text-slate-200">{campsite.amenities.stayLimitDays} Days</div>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center gap-2.5">
                <ShieldCheck className="w-4 h-4 text-indigo-400 shrink-0" />
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-bold">Permit</div>
                  <div className="font-semibold text-slate-200">{campsite.amenities.permitRequired ? 'Required (Free)' : 'None Needed'}</div>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center gap-2.5">
                <Compass className="w-4 h-4 text-amber-400 shrink-0" />
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-bold">Max RV Rig</div>
                  <div className="font-semibold text-slate-200">{campsite.amenities.maxRvLengthFeet ? `${campsite.amenities.maxRvLengthFeet}ft Rig` : 'Tent Only'}</div>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center gap-2.5">
                <Trash2 className="w-4 h-4 text-rose-400 shrink-0" />
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-bold">Trash</div>
                  <div className="font-semibold text-slate-200">{campsite.amenities.trashService ? 'Dumpsters' : 'Pack In / Pack Out'}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Camper Community Reviews */}
          <div className="border-t border-slate-800 pt-5">
            <div className="flex items-center justify-between mb-4">
              <h4 className="font-semibold text-slate-100 text-base flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-emerald-400" />
                Camper Reviews ({campsite.reviews.length})
              </h4>
              <button
                onClick={() => setShowReviewForm(!showReviewForm)}
                className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-emerald-400 border border-slate-700 transition-all"
              >
                {showReviewForm ? 'Cancel' : '+ Leave Review'}
              </button>
            </div>

            {/* Review Form Drawer */}
            {showReviewForm && (
              <form onSubmit={handleSubmitReview} className="mb-4 p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase">Your Name</label>
                    <input
                      type="text"
                      required
                      value={authorName}
                      onChange={(e) => setAuthorName(e.target.value)}
                      placeholder="e.g. Alex M."
                      className="w-full mt-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase">Vehicle / Rig Type</label>
                    <input
                      type="text"
                      value={vehicleType}
                      onChange={(e) => setVehicleType(e.target.value)}
                      placeholder="e.g. Sprinter Van, 4x4 Truck, Tent"
                      className="w-full mt-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-bold text-slate-400 uppercase">Rating (1 to 5 Stars)</label>
                  <div className="flex gap-1 mt-1">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <button
                        type="button"
                        key={star}
                        onClick={() => setRating(star)}
                        className={`p-1.5 rounded-lg border text-xs font-bold ${
                          rating >= star ? 'bg-amber-500 text-slate-950 border-amber-400' : 'bg-slate-900 text-slate-500 border-slate-800'
                        }`}
                      >
                        ★ {star}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-bold text-slate-400 uppercase">Review & Conditions</label>
                  <textarea
                    required
                    rows={3}
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder="Share cell signal quality, road clearance needed, and campsite vibes..."
                    className="w-full mt-1 bg-slate-900 border border-slate-700 rounded-xl p-2.5 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-md"
                >
                  <Send className="w-3.5 h-3.5" />
                  Post Review
                </button>
              </form>
            )}

            {/* Review List */}
            {campsite.reviews.length === 0 ? (
              <p className="text-xs text-slate-400 italic">No camper reviews yet. Be the first to leave a report!</p>
            ) : (
              <div className="space-y-3">
                {campsite.reviews.map((rev) => (
                  <div key={rev.id} className="p-3.5 rounded-2xl bg-slate-950/70 border border-slate-800/80">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <div className="font-bold text-slate-200">
                        {rev.author}{' '}
                        {rev.vehicleType && <span className="font-normal text-slate-400">({rev.vehicleType})</span>}
                      </div>
                      <div className="text-amber-400 font-bold">★ {rev.rating}</div>
                    </div>
                    <p className="text-xs text-slate-300">{rev.comment}</p>
                    <div className="text-[10px] text-slate-500 mt-1.5">{rev.date}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};



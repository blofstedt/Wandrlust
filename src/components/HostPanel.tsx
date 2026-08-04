import React, { useState, useEffect } from 'react';
import {
  Home, Plus, Coins, Star, Loader2, Check, Calendar,
  Droplet, Zap, Wifi, Flame, Dog, Trash2, ShowerHead, Truck
} from 'lucide-react';
import {
  fetchMyListings, saveListing, fetchMyBookings, updateBookingStatus,
  submitBookingReview, HostListing, Booking
} from '../services/dataService';
import { useAuth } from '../contexts/AuthContext';

interface HostPanelProps {
  isOpen: boolean;
  onClose: () => void;
  defaultCenter: [number, number];
  onRequireAuth: () => void;
}

const AMENITIES: {
  key: keyof HostListing;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { key: 'has_water', label: 'Water', icon: Droplet },
  { key: 'has_toilet', label: 'Toilet', icon: Home },
  { key: 'has_shower', label: 'Shower', icon: ShowerHead },
  { key: 'has_power', label: 'Power', icon: Zap },
  { key: 'has_dump_station', label: 'Dump station', icon: Trash2 },
  { key: 'has_wifi', label: 'Wi-Fi', icon: Wifi },
  { key: 'allows_fires', label: 'Fires OK', icon: Flame },
  { key: 'allows_pets', label: 'Pets OK', icon: Dog },
  { key: 'is_pull_through', label: 'Pull-through', icon: Truck }
];

/**
 * Host tools: list your land, manage bookings, and exchange reviews.
 *
 * Reviews are DOUBLE-BLIND. Neither side sees the other's until both have
 * submitted, or 14 days pass. Without that, the second reviewer just mirrors
 * whatever they received and the ratings stop meaning anything.
 */
export const HostPanel: React.FC<HostPanelProps> = ({
  isOpen, onClose, defaultCenter, onRequireAuth
}) => {
  const { user, profile } = useAuth();
  const [tab, setTab] = useState<'listings' | 'bookings' | 'new'>('listings');
  const [listings, setListings] = useState<HostListing[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [form, setForm] = useState<Record<string, any>>({
    title: '',
    description: '',
    latitude: defaultCenter[0],
    longitude: defaultCenter[1],
    token_price: 500,
    max_nights: 3,
    max_rigs: 1,
    surface_type: 'gravel',
    quiet_hours: '10pm – 7am',
    arrival_notes: '',
    allows_pets: true,
    allows_generators: true
  });

  const [reviewFor, setReviewFor] = useState<Booking | null>(null);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');

  const load = async () => {
    setListings(await fetchMyListings());
    setBookings(await fetchMyBookings());
  };

  useEffect(() => {
    if (isOpen && user) load();
  }, [isOpen, user]);

  const handleCreate = async () => {
    if (!user) { onRequireAuth(); return; }
    if (!form.title.trim()) { setNotice('Give your listing a title'); return; }
    setBusy(true);
    const result = await saveListing(form as any);
    setNotice(result.message);
    setBusy(false);
    if (result.ok) { setTab('listings'); load(); }
  };

  const handleReview = async () => {
    if (!reviewFor || !user) return;
    const isHost = reviewFor.host_id === user.id;
    setBusy(true);
    const result = await submitBookingReview({
      bookingId: reviewFor.id,
      subjectId: isHost ? reviewFor.guest_id : reviewFor.host_id,
      direction: isHost ? 'host_to_guest' : 'guest_to_host',
      rating,
      comment
    });
    setNotice(result.message);
    setBusy(false);
    if (result.ok) { setReviewFor(null); setComment(''); load(); }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[1800] flex items-end sm:items-center justify-center bg-slate-950/70 p-0 sm:p-4 anim-backdrop">
      <div className="w-full sm:max-w-lg bg-slate-900 border-t sm:border border-slate-700 rounded-t-3xl sm:rounded-2xl shadow-2xl max-h-[90vh] flex flex-col anim-sheet-up sm:anim-expand">
        <div className="flex items-center justify-between p-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2">
            <Home className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-bold text-slate-100">Host</h2>
            {profile && profile.host_review_count > 0 && (
              <span className="flex items-center gap-1 text-[10px] text-amber-300 font-bold">
                <Star className="w-3 h-3" fill="currentColor" />
                {profile.host_rating} ({profile.host_review_count})
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-sm font-bold px-2" aria-label="Close">✕</button>
        </div>

        <div className="flex border-b border-slate-800 shrink-0">
          {(['listings', 'bookings', 'new'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 px-3 py-2 text-[11px] font-bold ${
                tab === t ? 'text-emerald-400 border-b-2 border-emerald-500' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t === 'new' ? 'List property' : t === 'listings' ? 'My listings' : 'Bookings'}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 scroll-soft">
          {!user && (
            <div className="text-center py-6">
              <p className="text-xs text-slate-400 mb-3">Sign in to list property or manage bookings.</p>
              <button onClick={onRequireAuth} className="px-4 py-2 rounded-xl bg-emerald-600 text-white font-bold text-xs">
                Sign in
              </button>
            </div>
          )}

          {user && tab === 'new' && (
            <>
              <div>
                <label className="text-[11px] font-semibold text-slate-400">Title</label>
                <input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="Quiet meadow behind the barn"
                  className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100"
                />
              </div>

              <div>
                <label className="text-[11px] font-semibold text-slate-400">Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={3}
                  placeholder="What's the spot like? Access, terrain, what to expect."
                  className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] font-semibold text-slate-400">Latitude</label>
                  <input
                    type="number" step="0.00001" value={form.latitude}
                    onChange={(e) => setForm({ ...form, latitude: parseFloat(e.target.value) })}
                    className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-slate-400">Longitude</label>
                  <input
                    type="number" step="0.00001" value={form.longitude}
                    onChange={(e) => setForm({ ...form, longitude: parseFloat(e.target.value) })}
                    className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[11px] font-semibold text-slate-400">Tokens/night</label>
                  <input
                    type="number" value={form.token_price}
                    onChange={(e) => setForm({ ...form, token_price: parseInt(e.target.value, 10) })}
                    className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-slate-400">Max nights</label>
                  <input
                    type="number" value={form.max_nights}
                    onChange={(e) => setForm({ ...form, max_nights: parseInt(e.target.value, 10) })}
                    className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-slate-400">Max rigs</label>
                  <input
                    type="number" value={form.max_rigs}
                    onChange={(e) => setForm({ ...form, max_rigs: parseInt(e.target.value, 10) })}
                    className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-slate-400 block mb-1.5">Amenities</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {AMENITIES.map(({ key, label, icon: Icon }) => {
                    const active = Boolean(form[key as string]);
                    return (
                      <button
                        key={key as string}
                        onClick={() => setForm({ ...form, [key]: !active })}
                        className={`px-2 py-2 rounded-xl border text-[10px] font-semibold flex flex-col items-center gap-1 ${
                          active ? 'bg-emerald-950/60 border-emerald-500/60 text-emerald-200' : 'bg-slate-800/50 border-slate-700 text-slate-400'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-slate-400">Arrival notes</label>
                <textarea
                  value={form.arrival_notes}
                  onChange={(e) => setForm({ ...form, arrival_notes: e.target.value })}
                  rows={2}
                  placeholder="Gate code, where to park, who to text on arrival"
                  className="w-full mt-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100"
                />
              </div>

              <button
                onClick={handleCreate}
                disabled={busy}
                className="w-full px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Publish listing
              </button>

              <p className="text-[10px] text-slate-500 leading-snug">
                Exact coordinates stay hidden until you confirm a booking — guests see an
                approximate location while browsing.
              </p>
            </>
          )}

          {user && tab === 'listings' && (
            <>
              {listings.length === 0 ? (
                <p className="text-[11px] text-slate-500 text-center py-6">
                  No listings yet. Tap &ldquo;List property&rdquo; to add one.
                </p>
              ) : (
                listings.map((l, i) => (
                  <div
                    key={l.id}
                    data-stagger={Math.min(i, 8)}
                    className="rounded-xl border border-slate-700 bg-slate-800/50 p-3 anim-in-up"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-slate-100 truncate">{l.title}</p>
                        <p className="text-[10px] text-slate-400 line-clamp-2 mt-0.5">{l.description}</p>
                      </div>
                      <span className="flex items-center gap-1 text-[11px] font-bold text-amber-300 shrink-0">
                        <Coins className="w-3 h-3" />
                        {l.token_price}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {AMENITIES.filter(({ key }) => (l as any)[key]).map(({ key, label }) => (
                        <span key={key as string} className="px-1.5 py-0.5 rounded bg-slate-700/60 text-[9px] text-slate-300">
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </>
          )}

          {user && tab === 'bookings' && (
            <>
              {bookings.length === 0 ? (
                <p className="text-[11px] text-slate-500 text-center py-6">No bookings yet.</p>
              ) : (
                bookings.map((b, i) => {
                  const isHost = b.host_id === user.id;
                  const myReviewDone = isHost ? b.host_reviewed : b.guest_reviewed;
                  return (
                    <div
                      key={b.id}
                      data-stagger={Math.min(i, 8)}
                      className="rounded-xl border border-slate-700 bg-slate-800/50 p-3 anim-in-up"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="flex items-center gap-1.5 text-[11px] text-slate-300">
                          <Calendar className="w-3 h-3" />
                          {b.starts_on} → {b.ends_on}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-slate-700 text-[9px] font-bold text-slate-300 uppercase">
                          {b.status}
                        </span>
                      </div>

                      <div className="flex gap-1.5 flex-wrap">
                        {isHost && b.status === 'requested' && (
                          <>
                            <button
                              onClick={async () => { await updateBookingStatus(b.id, 'confirmed'); load(); }}
                              className="px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-[10px] font-bold"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={async () => { await updateBookingStatus(b.id, 'cancelled'); load(); }}
                              className="px-2.5 py-1 rounded-lg bg-slate-700 text-slate-300 text-[10px] font-bold"
                            >
                              Decline
                            </button>
                          </>
                        )}
                        {b.status === 'confirmed' && (
                          <button
                            onClick={async () => { await updateBookingStatus(b.id, 'completed'); load(); }}
                            className="px-2.5 py-1 rounded-lg bg-slate-700 text-slate-200 text-[10px] font-bold"
                          >
                            Mark completed
                          </button>
                        )}
                        {b.status === 'completed' && !myReviewDone && (
                          <button
                            onClick={() => setReviewFor(b)}
                            className="px-2.5 py-1 rounded-lg bg-amber-600 text-white text-[10px] font-bold flex items-center gap-1"
                          >
                            <Star className="w-2.5 h-2.5" />
                            Leave review
                          </button>
                        )}
                        {b.status === 'completed' && myReviewDone && (
                          <span className="px-2.5 py-1 rounded-lg bg-slate-700/50 text-slate-400 text-[10px] font-bold flex items-center gap-1">
                            <Check className="w-2.5 h-2.5" />
                            Reviewed
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </>
          )}

          {notice && <p className="text-[11px] text-emerald-300 text-center anim-in-up">{notice}</p>}
        </div>

        {reviewFor && (
          <div className="border-t border-slate-800 p-4 space-y-2 shrink-0 bg-slate-900 anim-in-up">
            <p className="text-[11px] font-bold text-slate-200">
              Review this {reviewFor.host_id === user?.id ? 'guest' : 'host'}
            </p>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((s) => (
                <button
                  key={s}
                  onClick={() => setRating(s)}
                  className={`w-8 h-8 rounded-lg text-sm font-bold ${
                    rating >= s ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-500'
                  }`}
                >
                  ★
                </button>
              ))}
            </div>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              placeholder="How was it?"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100"
            />
            <p className="text-[10px] text-slate-500 leading-snug">
              Hidden until both parties review, so nobody can react to what the other
              wrote. Both of you get a 10% token bonus once it&apos;s mutual.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setReviewFor(null)} className="px-3 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold">
                Cancel
              </button>
              <button
                onClick={handleReview}
                disabled={busy || !comment.trim()}
                className="flex-1 px-3 py-2 rounded-xl bg-emerald-600 text-white text-xs font-bold disabled:opacity-50"
              >
                Submit review
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

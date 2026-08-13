import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera, Check, Loader2, MapPin, Plus, X, ShieldAlert, Signal, Info
} from 'lucide-react';
import { Sheet } from './ui/Sheet';
import { ScalePicker, TriToggle } from './ui/ScalePicker';
import { useToast } from './ui/Feedback';
import { uploadSpotPhoto } from '../services/dataService';
import { fetchSpotContext, fallbackSpotName } from '../services/spotContextService';
import { fetchCellCoverage, bestCarrier } from '../services/cellCoverageService';
import { positionTells } from '../services/beaconService';
import {
  SPOT_SCALE_FIELDS, AMENITY_QUESTIONS, KNOCK_QUESTION, KNOCK_CONSEQUENCE,
  REPORT_INTRO, REPORT_VISIBILITY_NOTE, PHOTO_REQUIRED_REASON, MAX_PHOTOS,
  POI_RADIUS_M
} from '../config/spotReport';
import { haptic } from '../utils/animation';
import type { SpotContext, SpotScale, SpotVisitReport } from '../types';

/**
 * The one form a camper fills in about a place they have been.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ONE SCROLL AND NOT A WIZARD
 * ---------------------------------------------------------------------------
 *
 * A stepped wizard was the obvious shape — one big question per card, swipe
 * through, very pretty. It was rejected for a specific reason: a wizard hides
 * how much is left. Somebody standing in the dark next to their van needs to
 * see at a glance that this is twelve short taps and not forty, and a card
 * that says "3 of ?" is exactly the thing that makes people abandon a form.
 *
 * So it is one scroll, grouped, with everything visible. What makes it feel
 * quick instead of long is that nothing is required — see below.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE IS REQUIRED EXCEPT THE PHOTO
 * ---------------------------------------------------------------------------
 *
 * Every scale starts at "Not answered" and stays there unless touched. A
 * camper who answers two questions and submits has filed a perfectly good
 * report; the other ten stay unknown and are stored as null rather than as a
 * middle value nobody meant. This is the same rule the rest of the app follows
 * about absent data, applied to the input side: a form that quietly invents
 * confident answers is the input-side version of a map that draws a boundary
 * it is not sure about.
 *
 * The photo is the exception because it is the proof, and the sheet says why
 * in those words rather than just marking the field with an asterisk.
 */

export type SpotReportMode = 'create' | 'report';

export interface SpotReportSubmission {
  report: SpotVisitReport;
  position: GeolocationPosition;
  /** The generated name. Only meaningful when creating a new spot. */
  name: string;
  nameBasis?: string;
  clientFlags: Record<string, unknown>;
}

interface SpotReportSheetProps {
  isOpen: boolean;
  onClose: () => void;
  mode: SpotReportMode;
  /** Where the spot is. For `report`, the spot's own position. */
  at: [number, number] | null;
  /** Shown as the title in `report` mode, where the name already exists. */
  existingName?: string;
  onRequireAuth: () => void;
  /**
   * Does the actual write. The sheet owns the form, the photos and the
   * position; the caller owns which RPC that becomes, because creating a spot
   * and reporting on one are different calls with different rules.
   */
  onSubmit: (submission: SpotReportSubmission) => Promise<{ ok: boolean; message: string }>;
  /** True when a four-hour dwell is behind this. Changes the copy, not the form. */
  overnight?: boolean;
}

interface PendingPhoto {
  id: string;
  file: File;
  previewUrl: string;
  path?: string;
  uploading: boolean;
  failed: boolean;
}

export const SpotReportSheet: React.FC<SpotReportSheetProps> = ({
  isOpen, onClose, mode, at, existingName, onRequireAuth, onSubmit, overnight = false
}) => {
  const toast = useToast();

  const [report, setReport] = useState<SpotVisitReport>({});
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [context, setContext] = useState<SpotContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [position, setPosition] = useState<GeolocationPosition | null>(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const set = useCallback(<K extends keyof SpotVisitReport>(
    key: K, value: SpotVisitReport[K]
  ) => {
    setReport((r) => ({ ...r, [key]: value }));
  }, []);

  /* ---------------------------------------------------------------- */
  /* Context: the name, and which facilities we can already see        */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!isOpen || !at) return;

    const controller = new AbortController();
    setContextLoading(true);

    void fetchSpotContext(at[0], at[1], controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setContext(result);
      setContextLoading(false);
    });

    return () => controller.abort();
  }, [isOpen, at?.[0], at?.[1]]);

  /* ---------------------------------------------------------------- */
  /* Cell signal, captured without asking                              */
  /* ---------------------------------------------------------------- */

  /**
   * Zero taps. The camper is standing at the spot and the app already knows
   * how to estimate signal there, so making them answer a question the app
   * can answer itself would be the same mistake as asking about a gas station
   * OpenStreetMap already knows about.
   */
  useEffect(() => {
    if (!isOpen || !at) return;

    const controller = new AbortController();
    void fetchCellCoverage(at[0], at[1], controller.signal).then((coverage) => {
      if (controller.signal.aborted || !coverage.ok) return;
      const best = bestCarrier(coverage);
      if (!best || typeof best.bars !== 'number') return;
      setReport((r) => ({ ...r, cellBars: best.bars, cellCarrier: best.label }));
    });

    return () => controller.abort();
  }, [isOpen, at?.[0], at?.[1]]);

  /* ---------------------------------------------------------------- */
  /* Position — the proof that the camper is here                      */
  /* ---------------------------------------------------------------- */

  const locate = useCallback(async () => {
    if (!('geolocation' in navigator)) {
      toast.error('No location', 'This device cannot report where it is.');
      return;
    }
    setLocating(true);

    const fix = await new Promise<GeolocationPosition | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        resolve,
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 12_000 }
      );
    });

    setLocating(false);

    if (!fix) {
      toast.error('Could not find you', 'Check that location access is allowed, then try again.');
      return;
    }
    setPosition(fix);
  }, [toast]);

  // Ask for the fix as soon as the sheet opens. It takes a few seconds on a
  // cold GPS, and the alternative is the camper filling in the whole form and
  // then waiting at the submit button.
  useEffect(() => {
    if (!isOpen) return;
    void locate();
  }, [isOpen, locate]);

  /* ---------------------------------------------------------------- */
  /* Photos                                                            */
  /* ---------------------------------------------------------------- */

  const addPhotos = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) {
      toast.info('That is enough photos', `${MAX_PHOTOS} is the limit.`);
      return;
    }

    const chosen = Array.from(files).slice(0, room);

    const pending: PendingPhoto[] = chosen.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      previewUrl: URL.createObjectURL(file),
      uploading: true,
      failed: false
    }));

    setPhotos((current) => [...current, ...pending]);
    haptic('tap');

    // Uploaded as they are picked rather than at submit time. On a bad
    // connection that is the difference between a slow tap and a form that
    // appears frozen for thirty seconds at the very end.
    await Promise.all(pending.map(async (item) => {
      const result = await uploadSpotPhoto(item.file);
      setPhotos((current) => current.map((p) =>
        p.id === item.id
          ? { ...p, uploading: false, failed: !result.ok, path: result.data }
          : p
      ));
      if (!result.ok) toast.error('Photo did not upload', result.message);
    }));
  }, [photos.length, toast]);

  const removePhoto = useCallback((id: string) => {
    setPhotos((current) => {
      const target = current.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((p) => p.id !== id);
    });
  }, []);

  // Preview URLs are object URLs and leak if they are not released.
  useEffect(() => () => {
    photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    // Intentionally on unmount only — the remove handler revokes its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start clean each time. A report left over from the last spot is how
  // somebody publishes last night's answers about tonight's pullout.
  useEffect(() => {
    if (isOpen) return;
    setReport({});
    setPhotos([]);
    setContext(null);
    setPosition(null);
  }, [isOpen]);

  /* ---------------------------------------------------------------- */
  /* Which amenity questions survive the sweep                          */
  /* ---------------------------------------------------------------- */

  /**
   * Ask only about what we could not find ourselves.
   *
   * When the lookup failed outright we ask about all three, because "we could
   * not check" is not "there is nothing here" and the sheet must not present
   * one as the other.
   */
  const amenityState = useMemo(() => {
    const found = new Set(context?.pois.map((p) => p.kind) ?? []);
    const couldNotCheck = !context || context.poiLookupFailed;

    return AMENITY_QUESTIONS.map((question) => ({
      question,
      foundPoi: context?.pois.find((p) => p.kind === question.kind),
      shouldAsk: couldNotCheck || !found.has(question.kind)
    }));
  }, [context]);

  /* ---------------------------------------------------------------- */

  const uploading = photos.some((p) => p.uploading);
  const uploadedPaths = photos.filter((p) => p.path).map((p) => p.path as string);
  const hasPhoto = uploadedPaths.length > 0;

  const name = mode === 'create'
    ? (context?.name || (at ? fallbackSpotName(at[0], at[1]) : ''))
    : (existingName ?? 'This spot');

  const answeredCount = useMemo(() => {
    const keys: (keyof SpotVisitReport)[] = [
      ...SPOT_SCALE_FIELDS.map((f) => f.key),
      'hasShower', 'hasRestroom', 'hasFuel', 'gotKnocked'
    ];
    return keys.filter((k) => report[k] != null).length;
  }, [report]);

  const handleSubmit = async () => {
    if (!position) {
      toast.error('No location yet', 'Give it a moment to find you, then try again.');
      return;
    }
    if (!hasPhoto) {
      toast.error('A photo is needed', PHOTO_REQUIRED_REASON);
      return;
    }

    setBusy(true);

    // Client-side spoof tells are a hint for the log and NEVER a verdict —
    // everything that decides anything runs in SQL, because anything checked
    // here is editable by whoever is faking the position in the first place.
    const tells = positionTells(position);

    const result = await onSubmit({
      report: {
        ...report,
        photoPaths: uploadedPaths,
        comment: report.comment?.trim() || undefined,
        stayedOvernight: overnight
      },
      position,
      name,
      nameBasis: context?.nameBasis,
      clientFlags: {
        tells,
        accuracy: position.coords.accuracy,
        // A photo picked from the gallery rather than taken now is the most
        // common way this gets gamed. Not a rejection on its own; a note.
        photoAges: photos.map((p) => Math.round((Date.now() - p.file.lastModified) / 60_000))
      }
    });

    setBusy(false);

    if (result.ok) {
      haptic('success');
      toast.success(mode === 'create' ? 'Spot added' : 'Report sent', result.message);
      onClose();
    } else {
      haptic('error');
      toast.warning('Not sent', result.message);
    }
  };

  if (!at) return null;

  const knocked = report.gotKnocked === true;

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      title={mode === 'create' ? 'Add this spot' : 'How was it?'}
      subtitle={overnight ? 'After a four-hour stay' : `${at[0].toFixed(4)}, ${at[1].toFixed(4)}`}
      icon={<MapPin className="w-4 h-4 text-emerald-400" />}
      footer={
        <div className="space-y-2">
          <button
            onClick={busy || uploading ? undefined : handleSubmit}
            disabled={busy || uploading || !hasPhoto || !position}
            className={`w-full px-4 py-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 disabled:opacity-50 text-white ${
              knocked
                ? 'bg-red-600 hover:bg-red-500'
                : 'bg-emerald-600 hover:bg-emerald-500'
            }`}
          >
            {busy || uploading
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Check className="w-4 h-4" />}
            {busy
              ? 'Sending…'
              : uploading
              ? 'Waiting for the photo…'
              : mode === 'create'
              ? 'Put this spot on the map'
              : 'Send my report'}
          </button>

          {/* Why the button is off, said plainly, rather than a dead button
              nobody can explain. */}
          {!busy && !uploading && (!hasPhoto || !position) && (
            <p className="text-[10px] text-slate-500 text-center leading-snug">
              {!position
                ? locating ? 'Finding your position…' : 'Waiting on your position.'
                : PHOTO_REQUIRED_REASON}
            </p>
          )}

          {answeredCount > 0 && (
            <p className="text-[10px] text-slate-500 text-center">
              {answeredCount} question{answeredCount === 1 ? '' : 's'} answered.
              The rest stay blank — that is fine.
            </p>
          )}
        </div>
      }
    >
      <div className="p-4 space-y-4">
        {/* ---- The name, built not typed ---- */}
        {mode === 'create' && (
          <div className="rounded-2xl border border-slate-700 bg-slate-800/40 p-3">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-1">
              This spot will be called
            </p>
            {contextLoading ? (
              <div className="h-5 w-40 rounded bg-slate-700/60 anim-pulse" />
            ) : (
              <p className="text-sm font-bold text-slate-100">{name}</p>
            )}
            {/*
              Where the name came from. Shown rather than hidden because a
              camper who sees a name they did not choose should be able to find
              out instantly why it is that and not something else.
            */}
            {context?.nameBasis && !contextLoading && (
              <p className="text-[10px] text-slate-500 mt-1 leading-snug flex items-start gap-1.5">
                <Info className="w-3 h-3 shrink-0 mt-px" />
                {context.nameBasis}
              </p>
            )}
          </div>
        )}

        <p className="text-[11px] text-slate-400 leading-snug">{REPORT_INTRO}</p>

        {/* ---- Photos ---- */}
        <section>
          <SectionLabel>Photo{photos.length === 1 ? '' : 's'}</SectionLabel>

          <div className="grid grid-cols-4 gap-2">
            {photos.map((photo, i) => (
              <div
                key={photo.id}
                data-stagger={Math.min(i, 8)}
                className="relative aspect-square rounded-xl overflow-hidden border border-slate-700 anim-pop"
              >
                <img
                  src={photo.previewUrl}
                  alt=""
                  className="w-full h-full object-cover"
                />
                {photo.uploading && (
                  <div className="absolute inset-0 bg-slate-950/70 flex items-center justify-center">
                    <Loader2 className="w-4 h-4 animate-spin text-slate-300" />
                  </div>
                )}
                {photo.failed && (
                  <div className="absolute inset-0 bg-red-950/70 flex items-center justify-center">
                    <span className="text-[9px] font-bold text-red-200 px-1 text-center">
                      Failed
                    </span>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removePhoto(photo.id)}
                  aria-label="Remove this photo"
                  className="absolute top-1 right-1 p-1 rounded-lg bg-slate-950/80 text-slate-300 hover:text-white"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}

            {photos.length < MAX_PHOTOS && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="aspect-square rounded-xl border border-dashed border-slate-600 bg-slate-800/40 text-slate-400 hover:border-emerald-600/60 hover:text-emerald-300 flex flex-col items-center justify-center gap-1"
              >
                {photos.length === 0
                  ? <Camera className="w-5 h-5" />
                  : <Plus className="w-5 h-5" />}
                <span className="text-[9px] font-bold">
                  {photos.length === 0 ? 'Take one' : 'Add'}
                </span>
              </button>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={(e) => { void addPhotos(e.target.files); e.target.value = ''; }}
            className="hidden"
          />

          <p className="text-[10px] text-slate-500 mt-2 leading-snug">
            {PHOTO_REQUIRED_REASON}
          </p>
        </section>

        {/* ---- The stay ---- */}
        <section className="space-y-2">
          <SectionLabel>The stay</SectionLabel>
          {SPOT_SCALE_FIELDS.filter((f) => f.group === 'stay').map((field, i) => (
            <div key={field.key} data-stagger={Math.min(i, 8)} className="anim-in-up">
              <ScalePicker
                stops={field.stops}
                value={report[field.key] as number | undefined}
                onChange={(v) => set(field.key, v as SpotScale | undefined)}
                label={field.question}
                emoji={field.emoji}
                hint={field.hint}
              />
            </div>
          ))}
        </section>

        {/* ---- The ground ---- */}
        <section className="space-y-2">
          <SectionLabel>The ground</SectionLabel>
          {SPOT_SCALE_FIELDS.filter((f) => f.group === 'ground').map((field, i) => (
            <div key={field.key} data-stagger={Math.min(i, 8)} className="anim-in-up">
              <ScalePicker
                stops={field.stops}
                value={report[field.key] as number | undefined}
                onChange={(v) => set(field.key, v as SpotScale | undefined)}
                label={field.question}
                emoji={field.emoji}
                hint={field.hint}
              />
            </div>
          ))}
        </section>

        {/* ---- Facilities ---- */}
        <section className="space-y-2">
          <SectionLabel>Nearby</SectionLabel>

          {contextLoading && (
            <p className="text-[11px] text-slate-500">Checking what is around here…</p>
          )}

          {/* What we found ourselves. Shown, not asked. */}
          {amenityState
            .filter((a) => a.foundPoi)
            .map(({ question, foundPoi }) => (
              <div
                key={question.key}
                className="rounded-2xl border border-emerald-800/40 bg-emerald-950/20 p-3 flex items-center justify-between gap-3 anim-in-up"
              >
                <p className="text-[11px] text-slate-200 font-semibold flex items-center gap-1.5 min-w-0">
                  <span aria-hidden="true">{question.emoji}</span>
                  <span className="truncate">
                    {question.foundPrefix}: {foundPoi?.name}
                  </span>
                </p>
                <span className="text-[10px] text-emerald-300 shrink-0 font-bold">
                  {foundPoi && foundPoi.metresAway < 1000
                    ? `${foundPoi.metresAway} m`
                    : `${((foundPoi?.metresAway ?? 0) / 1000).toFixed(1)} km`}
                </span>
              </div>
            ))}

          {/* And only what we could not. */}
          {amenityState
            .filter((a) => a.shouldAsk)
            .map(({ question }) => (
              <div key={question.key} className="anim-in-up">
                <TriToggle
                  value={report[question.key]}
                  onChange={(v) => set(question.key, v)}
                  label={question.question}
                  emoji={question.emoji}
                />
              </div>
            ))}

          {context && !context.poiLookupFailed && (
            <p className="text-[10px] text-slate-500 leading-snug">
              We looked within {POI_RADIUS_M / 1000} km on OpenStreetMap. It misses
              plenty — if you know of one we did not list, say so above.
            </p>
          )}

          {/* Auto-captured, and labelled as an estimate rather than a reading. */}
          {typeof report.cellBars === 'number' && (
            <div className="rounded-2xl border border-slate-700/80 bg-slate-800/40 p-3 flex items-center justify-between gap-3">
              <p className="text-[11px] text-slate-200 font-semibold flex items-center gap-1.5">
                <Signal className="w-3.5 h-3.5 text-sky-400" />
                Signal here
              </p>
              <span className="text-[10px] text-slate-300 font-bold">
                {report.cellBars}/5 {report.cellCarrier ? `· ${report.cellCarrier}` : ''}
              </span>
            </div>
          )}
        </section>

        {/* ---- The knock ---- */}
        <section className="space-y-2">
          <SectionLabel danger>Did it go badly?</SectionLabel>

          <TriToggle
            value={report.gotKnocked}
            onChange={(v) => set('gotKnocked', v)}
            label={KNOCK_QUESTION}
            emoji="🚨"
            danger
          />

          {/*
            The consequence, shown the moment they say yes rather than in small
            print underneath from the start. This is the only answer on the
            form that changes what every other camper sees.
          */}
          {knocked && (
            <div className="rounded-2xl border border-red-800/50 bg-red-950/30 p-3 anim-in-up">
              <p className="text-[11px] text-red-200 leading-snug flex items-start gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
                {KNOCK_CONSEQUENCE}
              </p>
            </div>
          )}
        </section>

        {/* ---- Comment ---- */}
        <section className="space-y-2">
          <SectionLabel>{knocked ? 'What happened?' : 'Anything else?'}</SectionLabel>
          <textarea
            value={report.comment ?? ''}
            onChange={(e) => set('comment', e.target.value)}
            rows={3}
            maxLength={600}
            placeholder={knocked
              ? 'Who knocked, what time, what they said — this is what the next camper reads first.'
              : 'What should the next camper know?'}
            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </section>

        <p className="text-[10px] text-slate-500 leading-snug">{REPORT_VISIBILITY_NOTE}</p>
      </div>
    </Sheet>
  );
};

/* ------------------------------------------------------------------ */

const SectionLabel: React.FC<{ children: React.ReactNode; danger?: boolean }> = ({
  children, danger = false
}) => (
  <p className={`text-[10px] font-bold uppercase tracking-wide mb-2 ${
    danger ? 'text-red-400' : 'text-slate-400'
  }`}>
    {children}
  </p>
);

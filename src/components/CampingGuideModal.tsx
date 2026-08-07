import React, { useEffect, useMemo, useState } from 'react';
import {
  BookOpen, Search, X, ChevronDown, ExternalLink, Info,
  Compass, Mountain, ShieldCheck, TreePine, Flame, Trash2, PawPrint, Leaf, AlertTriangle, Users
} from 'lucide-react';
import { Sheet } from './ui/Sheet';
import { EmptyState } from './ui/Feedback';
import { CAMPING_GUIDE } from '../data/campingGuide';
import type { GuideAccent, GuideSection, GuideSubsection } from '../types';

/**
 * The field guide.
 *
 * Content is data, not markup — it lives in src/data/campingGuide.ts so that
 * search can walk it. This file only decides how it looks.
 *
 * Sections are collapsed by default so the whole guide reads as a table of
 * contents. Typing a query expands everything that matched and highlights the
 * hits, so a rule can be found at a trailhead without scrolling for it.
 */

interface CampingGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  compass: Compass,
  mountain: Mountain,
  shield: ShieldCheck,
  trees: TreePine,
  flame: Flame,
  trash: Trash2,
  paw: PawPrint,
  leaf: Leaf,
  alert: AlertTriangle,
  users: Users
};

/** Full class strings — Tailwind scans source text, so these cannot be built up. */
const ACCENT: Record<GuideAccent, { chip: string; term: string; dot: string }> = {
  amber: { chip: 'bg-amber-500/15 text-amber-300 border-amber-500/30', term: 'text-amber-300', dot: 'bg-amber-400' },
  emerald: { chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', term: 'text-emerald-300', dot: 'bg-emerald-400' },
  cyan: { chip: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30', term: 'text-cyan-300', dot: 'bg-cyan-400' },
  rose: { chip: 'bg-rose-500/15 text-rose-300 border-rose-500/30', term: 'text-rose-300', dot: 'bg-rose-400' },
  violet: { chip: 'bg-violet-500/15 text-violet-300 border-violet-500/30', term: 'text-violet-300', dot: 'bg-violet-400' },
  sky: { chip: 'bg-sky-500/15 text-sky-300 border-sky-500/30', term: 'text-sky-300', dot: 'bg-sky-400' }
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Tokens match from the start of a word only, so "camp" finds "camping" but
 * "ban" no longer lights up inside "bank".
 */
const tokenRe = (tokens: string[], flags: string) =>
  new RegExp(`(\\b(?:${tokens.map(escapeRe).join('|')})\\w*)`, flags);

/** Wraps every matched token in the text. Renders plain text when not searching. */
const Highlight: React.FC<{ text: string; tokens: string[] }> = ({ text, tokens }) => {
  if (tokens.length === 0) return <>{text}</>;

  const parts = text.split(tokenRe(tokens, 'ig'));
  const test = tokenRe(tokens, 'i');

  return (
    <>
      {parts.map((part, i) =>
        part && test.test(part) ? (
          <mark key={i} className="bg-amber-400/25 text-amber-200 rounded px-0.5">{part}</mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      )}
    </>
  );
};

interface Match {
  section: GuideSection;
  subsections: GuideSubsection[];
}

/** Everything a subsection can be found by, flattened once per query. */
const haystack = (section: GuideSection, sub: GuideSubsection) =>
  [
    section.title, section.summary, section.scope ?? '', section.source ?? '',
    sub.title, sub.caveat ?? '',
    ...sub.entries.map((e) => `${e.term ?? ''} ${e.text}`)
  ].join(' ').toLowerCase();

export const CampingGuideModal: React.FC<CampingGuideModalProps> = ({ isOpen, onClose }) => {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Reopening the guide should feel like opening it fresh, not resuming a search.
  useEffect(() => {
    if (!isOpen) { setQuery(''); setExpanded(new Set()); }
  }, [isOpen]);

  const tokens = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query]
  );

  const matches: Match[] = useMemo(() => {
    if (tokens.length === 0) {
      return CAMPING_GUIDE.map((section) => ({ section, subsections: section.subsections }));
    }
    return CAMPING_GUIDE.reduce<Match[]>((acc, section) => {
      const subsections = section.subsections.filter((sub) => {
        const hay = haystack(section, sub);
        return tokens.every((t) => tokenRe([t], 'i').test(hay));
      });
      if (subsections.length > 0) acc.push({ section, subsections });
      return acc;
    }, []);
  }, [tokens]);

  const searching = tokens.length > 0;
  const hitCount = matches.reduce((n, m) => n + m.subsections.length, 0);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const allExpanded = !searching && expanded.size === CAMPING_GUIDE.length;

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      variant="dialog"
      maxWidthClass="sm:max-w-2xl"
      title="Public Lands Field Guide"
      subtitle="Rules, regulations & Leave No Trace etiquette"
      icon={
        <div className="p-2 rounded-xl bg-amber-500/15 text-amber-400 border border-amber-500/30">
          <BookOpen className="w-4 h-4" />
        </div>
      }
    >
      <div className="p-4 space-y-3">
        {/* Search */}
        <div className="sticky top-0 -mx-4 -mt-4 px-4 pt-4 pb-3 bg-slate-900/95 backdrop-blur-sm z-10 border-b border-slate-800">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the guide — fire ban, PLUZ, stay limit, gray water…"
              aria-label="Search the field guide"
              className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-9 pr-9 py-2.5 text-xs text-slate-100 placeholder:text-slate-500 outline-none focus:border-amber-500/60 focus:ring-1 focus:ring-amber-500/30 [&::-webkit-search-cancel-button]:appearance-none"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-lg text-slate-500 hover:text-slate-100 hover:bg-slate-800"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 mt-2 text-[11px]">
            <span className="text-slate-500">
              {searching
                ? `${hitCount} ${hitCount === 1 ? 'result' : 'results'} in ${matches.length} ${matches.length === 1 ? 'section' : 'sections'}`
                : `${CAMPING_GUIDE.length} sections`}
            </span>
            {!searching && (
              <button
                onClick={() =>
                  setExpanded(allExpanded ? new Set() : new Set(CAMPING_GUIDE.map((s) => s.id)))
                }
                className="font-semibold text-slate-400 hover:text-slate-100"
              >
                {allExpanded ? 'Collapse all' : 'Expand all'}
              </button>
            )}
          </div>
        </div>

        {/* The standing caveat. This guide summarises rules; it is not the rules. */}
        <div className="flex items-start gap-2 p-3 rounded-2xl bg-slate-950 border border-slate-800 text-[11px] text-slate-400 leading-relaxed">
          <Info className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
          <p>
            A plain-language summary of published agency rules — not legal advice, and not current by
            guarantee. Stay limits, fire bans and closures are set locally and change without notice.
            <strong className="text-slate-300"> Confirm with the managing agency before you go.</strong>
          </p>
        </div>

        {/* Sections */}
        {matches.length === 0 ? (
          <EmptyState
            icon={Search}
            title="Nothing matched"
            description={`No section of the guide mentions “${query.trim()}”. Try a shorter or more general word.`}
            action={{ label: 'Clear search', onClick: () => setQuery('') }}
          />
        ) : (
          <div className="space-y-2.5">
            {matches.map(({ section, subsections }) => {
              const Icon = ICONS[section.icon] ?? Compass;
              const accent = ACCENT[section.accent];
              const open = searching || expanded.has(section.id);

              return (
                <section
                  key={section.id}
                  className="rounded-2xl bg-slate-950 border border-slate-800 overflow-hidden"
                >
                  <button
                    onClick={() => toggle(section.id)}
                    aria-expanded={open}
                    className="w-full flex items-start gap-3 p-3.5 text-left hover:bg-slate-900/60 transition-colors duration-200"
                  >
                    <div className={`p-2 rounded-xl border shrink-0 ${accent.chip}`}>
                      <Icon className="w-4 h-4" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-bold text-slate-100 text-sm">
                          <Highlight text={section.title} tokens={tokens} />
                        </h3>
                        {section.scope && (
                          <span className="px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-400 text-[10px] font-semibold border border-slate-700">
                            <Highlight text={section.scope} tokens={tokens} />
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 leading-snug mt-0.5">
                        <Highlight text={section.summary} tokens={tokens} />
                      </p>
                      <p className="text-[10px] text-slate-500 mt-1">
                        {subsections.length}{' '}
                        {subsections.length === 1 ? 'topic' : 'topics'}
                        {searching && subsections.length < section.subsections.length && ' matched'}
                      </p>
                    </div>

                    <ChevronDown
                      className={`w-4 h-4 text-slate-500 shrink-0 mt-1.5 ${open ? 'rotate-180' : ''}`}
                      style={{ transition: 'transform 250ms cubic-bezier(0.16, 1.36, 0.36, 1)' }}
                    />
                  </button>

                  {open && (
                    <div className="px-3.5 pb-3.5 space-y-3 anim-in-down">
                      {subsections.map((sub) => (
                        <div key={sub.id} className="rounded-xl bg-slate-900/60 border border-slate-800 p-3">
                          <h4 className="font-bold text-slate-200 text-xs flex items-center gap-1.5 mb-2">
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${accent.dot}`} />
                            <Highlight text={sub.title} tokens={tokens} />
                          </h4>

                          <ul className="space-y-1.5 text-[11px] text-slate-300 leading-relaxed">
                            {sub.entries.map((entry, i) => (
                              <li key={i} className="flex gap-2">
                                <span className="text-slate-600 select-none">—</span>
                                <span>
                                  {entry.term && (
                                    <strong className={accent.term}>
                                      <Highlight text={entry.term} tokens={tokens} />:{' '}
                                    </strong>
                                  )}
                                  <Highlight text={entry.text} tokens={tokens} />
                                </span>
                              </li>
                            ))}
                          </ul>

                          {sub.caveat && (
                            <p className="mt-2 pt-2 border-t border-slate-800 text-[10px] text-slate-500 italic leading-relaxed">
                              <Highlight text={sub.caveat} tokens={tokens} />
                            </p>
                          )}
                        </div>
                      ))}

                      {(section.source || section.links) && (
                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                          {section.source && (
                            <span className="text-[10px] text-slate-500 mr-1">
                              Source: <Highlight text={section.source} tokens={tokens} />
                            </span>
                          )}
                          {section.links?.map((link) => (
                            <a
                              key={link.href}
                              href={link.href}
                              target="_blank"
                              rel="noreferrer"
                              className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 flex items-center gap-1 text-[10px] font-semibold transition-colors duration-200"
                            >
                              {link.label}
                              <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </Sheet>
  );
};
import React, { useEffect, useState } from 'react';
import { Loader2, FileWarning } from 'lucide-react';
import { PublicPage, BackHome } from './PublicPage';
import { Markdown } from './ui/Markdown';

/**
 * `/privacy` and `/terms`, rendered from the files that already say it.
 *
 * ---------------------------------------------------------------------------
 * ONE COPY OF THE TEXT, NOT TWO
 * ---------------------------------------------------------------------------
 *
 * The documents live in `public/legal/` and are already what the in-app
 * viewer and the sign-up gate read. These pages read the same files. Nothing
 * here restates a policy in its own words: a privacy policy that says one
 * thing on a web page and another in the app is not a privacy policy, it is
 * two claims about the same promise, and the day they drift is the day one of
 * them becomes a lie.
 *
 * So there is nothing to keep in sync. Editing the markdown changes the app,
 * this page, and whatever Google's reviewer is looking at, together.
 */

export type LegalKind = 'privacy' | 'terms';

const DOCS: Record<LegalKind, { file: string; title: string; subtitle: string }> = {
  privacy: {
    file: '/legal/privacy-policy.md',
    title: 'Privacy Policy',
    subtitle:
      'What Wandrlust collects, why it needs it, and what it will never do with it.'
  },
  terms: {
    file: '/legal/terms-of-service.md',
    title: 'Terms of Service',
    subtitle:
      'What this app is, what it is not, and what you are agreeing to by using it.'
  }
};

/**
 * Drop the document's own top-level title, and only that.
 *
 * Anything before it (a blank line, a stray byte order mark) goes with it;
 * everything after is returned untouched.
 */
const withoutTitle = (markdown: string): string => {
  const lines = markdown.replace(/^\uFEFF/, '').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (i < lines.length && /^#\s+\S/.test(lines[i].trim())) i += 1;
  return lines.slice(i).join('\n');
};

export const LegalPage: React.FC<{ kind: LegalKind }> = ({ kind }) => {
  const doc = DOCS[kind];
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBody(null);
    setFailed(false);

    fetch(doc.file)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('not found'))))
      .then((text) => { if (!cancelled) setBody(text); })
      .catch(() => { if (!cancelled) setFailed(true); });

    return () => { cancelled = true; };
  }, [doc.file]);

  return (
    <PublicPage title={doc.title} subtitle={doc.subtitle}>
      {failed ? (
        /*
          SAY IT DID NOT LOAD, AND WHERE IT STILL IS.

          A legal page that renders blank looks like a legal page with nothing
          in it. Somebody checking whether this app has a privacy policy has
          to be able to tell "the file did not load" from "there isn't one".
        */
        <div className="flex gap-2.5 p-4 rounded-2xl bg-amber-950/40 border border-amber-800/50">
          <FileWarning className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-200/90 leading-relaxed">
            This document didn’t load just now — which is a problem with the page,
            not a sign that there isn’t one. The full text is also inside the app
            under Settings, and at{' '}
            <a
              href={doc.file}
              className="text-amber-100 underline underline-offset-2 font-semibold"
            >
              {doc.file}
            </a>
            .
          </p>
        </div>
      ) : body === null ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-slate-500" />
        </div>
      ) : (
        <article className="rounded-2xl bg-slate-900 border border-slate-800 p-5 sm:p-7">
          {/*
            The file opens with its own `# Privacy Policy` heading and the page
            already shows one above it. Dropped line-wise rather than with a
            regex over the whole document: these files are CRLF, and an
            anchored pattern that has to reason about `\r` is the kind of
            thing that silently stops matching the day somebody's editor
            normalises the endings.
          */}
          <Markdown source={withoutTitle(body)} />
        </article>
      )}

      <BackHome />
    </PublicPage>
  );
};

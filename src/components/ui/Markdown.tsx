import React from 'react';

/**
 * A small markdown renderer for the documents in `public/legal/`.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT A LIBRARY
 * ---------------------------------------------------------------------------
 *
 * This renders exactly the subset those three files use, and nothing else:
 * `#` and `##` headings, `-` bullets, `---` rules, `**bold**`, `*italic*` and
 * `[text](url)` links. That was established by reading the files, not guessed
 * at — and it is the whole grammar in about eighty lines. Pulling a markdown
 * parser and its dependency tree into the bundle to render three static legal
 * documents would cost every camper's first load for nothing.
 *
 * If a document ever needs tables, code fences or nested lists, take the
 * library. Do not grow this file into one.
 *
 * ---------------------------------------------------------------------------
 * THESE FILES ARE OURS, AND THE LINK CHECK STAYS ANYWAY
 * ---------------------------------------------------------------------------
 *
 * The markdown is committed to this repo, so there is no untrusted author in
 * the loop today. The `javascript:` guard below costs one comparison and means
 * that stays true even if a document ever starts coming from somewhere else.
 * React escapes the text itself, so there is nothing else to sanitise.
 */

/** Only ever produce links that go somewhere a link should go. */
const safeHref = (href: string): string | null => {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^mailto:/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;
  return null;
};

/** `**bold**`, `*italic*` and `[text](url)`, in one pass. */
const inline = (text: string, keyPrefix: string): React.ReactNode[] => {
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${n++}`;

    if (match[1] !== undefined) {
      out.push(<strong key={key} className="font-bold text-slate-100">{match[1]}</strong>);
    } else if (match[2] !== undefined) {
      out.push(<em key={key} className="italic">{match[2]}</em>);
    } else {
      const href = safeHref(match[4] ?? '');
      out.push(
        href ? (
          <a
            key={key}
            href={href}
            className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300"
            {...(href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {match[3]}
          </a>
        ) : (
          // A link we will not follow still shows its words, so the sentence
          // stays whole rather than losing a phrase to a dropped tag.
          <span key={key}>{match[3]}</span>
        )
      );
    }

    last = pattern.lastIndex;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
};

export const Markdown: React.FC<{ source: string }> = ({ source }) => {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];

  let paragraph: string[] = [];
  let bullets: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const key = `p-${blocks.length}`;
    blocks.push(
      <p key={key} className="text-sm text-slate-300 leading-relaxed">
        {inline(paragraph.join(' '), key)}
      </p>
    );
    paragraph = [];
  };

  const flushBullets = () => {
    if (bullets.length === 0) return;
    const key = `ul-${blocks.length}`;
    blocks.push(
      <ul key={key} className="space-y-1.5 pl-1">
        {bullets.map((item, i) => (
          <li key={`${key}-${i}`} className="flex gap-2.5 text-sm text-slate-300 leading-relaxed">
            <span aria-hidden="true" className="text-emerald-500 shrink-0 mt-0.5">•</span>
            <span>{inline(item, `${key}-${i}`)}</span>
          </li>
        ))}
      </ul>
    );
    bullets = [];
  };

  const flushAll = () => { flushParagraph(); flushBullets(); };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() === '') { flushAll(); continue; }

    if (/^---+$/.test(line.trim())) {
      flushAll();
      blocks.push(<hr key={`hr-${blocks.length}`} className="border-slate-800 my-1" />);
      continue;
    }

    if (line.startsWith('## ')) {
      flushAll();
      const key = `h2-${blocks.length}`;
      blocks.push(
        <h2 key={key} className="font-['Outfit'] font-bold text-lg text-slate-100 pt-3">
          {inline(line.slice(3), key)}
        </h2>
      );
      continue;
    }

    if (line.startsWith('# ')) {
      flushAll();
      const key = `h1-${blocks.length}`;
      blocks.push(
        <h1 key={key} className="font-['Outfit'] font-extrabold text-2xl text-slate-50">
          {inline(line.slice(2), key)}
        </h1>
      );
      continue;
    }

    if (/^[-*] /.test(line.trim())) {
      flushParagraph();
      bullets.push(line.trim().slice(2));
      continue;
    }

    /*
     * A WRAPPED BULLET IS STILL THAT BULLET.
     *
     * These documents are hard-wrapped at about eighty columns, so most list
     * items run over two or three lines with the continuations indented.
     * Treated as fresh paragraphs, every long bullet broke in half — the
     * privacy policy rendered "Shared location is deliberately imprecise. If
     * you turn on camper" as a bullet and "presence, other users see your
     * position rounded to roughly one kilometre." as the paragraph after it.
     * An indented line while a list is open belongs to the last item.
     */
    if (bullets.length > 0 && /^\s+\S/.test(raw)) {
      bullets[bullets.length - 1] += ` ${line.trim()}`;
      continue;
    }

    flushBullets();
    paragraph.push(line.trim());
  }

  flushAll();

  return <div className="space-y-3">{blocks}</div>;
};

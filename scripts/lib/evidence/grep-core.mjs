// Pure part of --grep: build the searchable texts of a scan (page text, shared footer text,
// link texts and hrefs), find matches with context, merge identical snippets across pages.
// Runs inside a worker thread (grep.mjs) so a pathological regex cannot hang the CLI.

import { oneLine } from './format.mjs';

export const CONTEXT_CHARS = 150;
export const MAX_SNIPPETS = 40;
export const MAX_SNIPPETS_ONE_PAGE = 200;
export const MAX_SNIPPETS_PER_TEXT = 5;
export const MAX_PATTERN_LENGTH = 200;

/** Compile a user-given pattern case-insensitively; throws a clear error for invalid input. */
export function compilePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) throw new Error('--grep needs a non-empty pattern');
  if (pattern.length > MAX_PATTERN_LENGTH) throw new Error(`--grep pattern too long (max ${MAX_PATTERN_LENGTH} characters)`);
  let regex;
  try {
    regex = new RegExp(pattern, 'gi');
  } catch (error) {
    throw new Error(`invalid regular expression (${error.message})`);
  }
  if (new RegExp(pattern, 'i').test('')) throw new Error('--grep pattern matches the empty string (it would match everywhere); make it more specific');
  return regex;
}

/** Texts to search: [{field, text, pages}]; identical texts (shared footers, menus) appear once with all page indexes. */
export function searchTexts(scan, pageIndex) {
  const pages = pageIndex === undefined ? scan.pages : scan.pages.filter((p) => p.index === pageIndex);
  const merged = new Map();
  const add = (field, text, index) => {
    if (typeof text !== 'string' || text === '') return;
    const key = `${field}\u0000${text}`;
    const entry = merged.get(key) ?? { field, text, pages: [] };
    if (!entry.pages.includes(index)) entry.pages.push(index);
    merged.set(key, entry);
  };
  for (const page of pages) {
    const f = page.facts ?? {};
    add('bodyText', f.bodyText, page.index);
    add('footerText', f.footerText, page.index);
    for (const l of f.links ?? []) add('link', `${oneLine(l.text) || '(no text)'} -> ${l.href}`, page.index);
  }
  return [...merged.values()];
}

/** Context window of one match as [from, to). */
const windowOf = (text, match) => [Math.max(0, match.index - CONTEXT_CHARS), Math.min(text.length, match.index + match[0].length + CONTEXT_CHARS)];

const excerptOf = (text, [from, to]) => `${from > 0 ? '…' : ''}${oneLine(text.slice(from, to))}${to < text.length ? '…' : ''}`;

/** Overlapping windows of one text become one passage; `matches` counts the matches inside it. */
function mergeWindows(windows) {
  const merged = [];
  for (const [from, to] of windows) {
    const last = merged.at(-1);
    if (last && from <= last.to) {
      last.to = Math.max(last.to, to);
      last.matches += 1;
    } else {
      merged.push({ from, to, matches: 1 });
    }
  }
  return merged;
}

/**
 * Find matches; identical snippets are merged across pages. Stops at the first distinct snippet
 * beyond `total`, so the total is only known when the search finished.
 * @param {number} [perText] matches shown per text (all pages: MAX_SNIPPETS_PER_TEXT; one page: no limit, so `total` caps)
 * @param {number} [total] distinct snippets shown in all (all pages: MAX_SNIPPETS; one page: MAX_SNIPPETS_ONE_PAGE)
 * @returns {{snippets: {field: string, text: string, matches: number, pages: number[]}[], capped: boolean, shortened: number[]}} shortened: pages with more matches than shown
 */
export function findMatches(texts, regex, perText = MAX_SNIPPETS_PER_TEXT, total = MAX_SNIPPETS) {
  const snippets = new Map();
  const shortened = new Set();
  for (const source of texts) {
    regex.lastIndex = 0;
    const hits = [];
    for (let m = regex.exec(source.text); m !== null; m = regex.exec(source.text)) {
      if (m[0] === '') { regex.lastIndex += 1; continue; } // \b, lookaheads: nothing to show
      if (hits.length >= perText) { source.pages.forEach((n) => shortened.add(n)); break; }
      hits.push(m);
      if (source.field === 'link') break;
    }
    const passages = source.field === 'link'
      ? hits.map(() => ({ text: source.text, matches: 1 }))
      : mergeWindows(hits.map((m) => windowOf(source.text, m))).map((w) => ({ text: excerptOf(source.text, [w.from, w.to]), matches: w.matches }));
    for (const passage of passages) {
      const key = `${source.field}\u0000${passage.text}`;
      if (!snippets.has(key) && snippets.size >= total) return { snippets: [...snippets.values()], capped: true, shortened: [...shortened] };
      const known = snippets.get(key) ?? { field: source.field, text: passage.text, matches: passage.matches, pages: [] };
      known.pages = [...new Set([...known.pages, ...source.pages])];
      snippets.set(key, known);
    }
  }
  return { snippets: [...snippets.values()], capped: false, shortened: [...shortened] };
}

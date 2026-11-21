// The finding field `where` ("Fundstelle") is written with site-relative paths in report.json. At build time every such
// path becomes the full URL of the checked site (decisions 101a to 104a); report.json itself is not changed.

import { esc, link } from './html-escape.mjs';

const URL_CHARS = String.raw`[^\s<>"'„“”‚‘’»«]`;
/** A full URL (any case), or a path that starts the text or follows a space, comma, semicolon, colon, bracket or quote. */
const URL_OR_PATH = new RegExp(String.raw`(https?:\/\/${URL_CHARS}+)|(^|[\s,;:(\["'„“‚‘»«])(\/[^\s,;:()\[\]<>"'„“”‚‘’»«]*)`, 'giu');
const ANY_URL = /https?:\/\//i;
const URL_IN_TEXT = new RegExp(String.raw`(https?:\/\/${URL_CHARS}+)`, 'i');
const TRAILING_PUNCTUATION = /[.!?]+$/;
/** URL path characters: letters and digits of any language, and the usual URL punctuation. */
const PATH_CHARS = /^\/[\p{L}\p{N}._~%!$&*+=@/?#-]*$/u;
const BARE_CAPITALISED = /^\/\p{Lu}\p{Ll}[\p{L}\p{N}]*$/u;

/** A path token is a path unless it is truncated ("/de/…/x", "/de/.../x") or no URL path at all. */
function isPath(path) {
  return PATH_CHARS.test(path) && !path.includes('...');
}

/**
 * "Kopfzeile /Fußzeile" is an alternative of two words, no path: a bare capitalised word (no further "/", ".", "-";
 * not an acronym such as "/FAQ") that follows a word and a single space. "/Impressum" at the start, after a comma, colon
 * or bracket, or with a trailing "/" stays a path.
 */
function isAlternative(path, before) {
  return BARE_CAPITALISED.test(path) && /[\p{L}] $/u.test(before);
}

/**
 * Origin (for paths) and start page (for the appended note) of the checked site.
 * `site` is the value of report.json: a host ("www.noavia.de"), a host with path ("wh.group/de") or a full URL.
 * @param {string} site
 * @returns {{origin: string, start: string}|null} null when the value is no http(s) site
 */
export function siteBase(site) {
  const text = String(site ?? '').trim();
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!/^https?:$/.test(url.protocol)) return null;
    return { origin: url.origin, start: `${url.origin}${url.pathname}` };
  } catch {
    return null;
  }
}

/**
 * Plain text with full URLs: paths expanded, existing URLs kept, and, when the text names no path and no URL,
 * the start page appended ("(geprüft u. a. https://…)").
 * @param {string} where
 * @param {string} site report.json `site`
 * @param {{whereChecked: (url: string) => string}} t text set of the document language
 */
export function expandWhere(where, site, t) {
  const base = siteBase(site);
  const text = String(where ?? '');
  if (!base) return text;
  const expanded = text.replace(URL_OR_PATH, (match, url, lead, path, offset) => {
    if (url) return match;
    const tail = TRAILING_PUNCTUATION.exec(path)?.[0] ?? '';
    const clean = path.slice(0, path.length - tail.length);
    const next = text.slice(offset + match.length);
    const before = text.slice(0, offset + lead.length);
    if (!isPath(clean) || isAlternative(clean, before) || (clean === '/' && /^\s+[\p{L}\d]/u.test(next))) return match; // a lone slash between words is no path
    return `${lead}${base.origin}${clean}${tail}`;
  });
  return ANY_URL.test(expanded) ? expanded : `${expanded} ${t.whereChecked(base.start)}`;
}

/** Drop trailing punctuation and a closing bracket that has no opening bracket inside the URL (it ends the surrounding text). */
function splitTail(part) {
  let url = part;
  for (;;) {
    const last = url.at(-1);
    const unbalanced = (close, open) => last === close && url.split(close).length > url.split(open).length;
    if (/[.,;:!?]/.test(last) || unbalanced(')', '(') || unbalanced(']', '[')) url = url.slice(0, -1);
    else break;
  }
  return [url, part.slice(url.length)];
}

/** HTML for the expanded text: every http(s) URL a clickable link, the rest escaped, trailing punctuation outside the link. */
export function whereHtml(text) {
  return String(text ?? '').split(URL_IN_TEXT).map((part, i) => {
    if (i % 2 === 0) return esc(part);
    const [url, tail] = splitTail(part);
    return `${link(url, url)}${esc(tail)}`;
  }).join('');
}

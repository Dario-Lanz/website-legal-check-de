// Classify pages by URL path and link text. Used to find legal pages and to decide
// whether the sample misses page types that only a deeper scan would cover.

import { pageKey } from './url.mjs';

/** Ordered: the first matching type wins. Patterns cover German and English wording. */
export const PAGE_TYPE_PATTERNS = [
  ['imprint', /impressum|imprint|anbieterkennzeichnung|legal[\s_-]notice|avviso[\s-]legale|note[\s-]legali|informazioni[\s-]legali/i],
  ['privacy', /datenschutz|privacy|dsgvo|gdpr|(?:^|\/)data[\s-]protection\/?(?:\?.*)?$|data[\s-]protection[\s-](?:policy|notice|declaration|statement)|protezione[\s-]dei[\s-]dati/i],
  ['withdrawal', /widerruf|withdrawal|cancellation-policy|right-of-withdrawal/i],
  ['terms', /\bagb\b|agbs|allgemeine-geschaeftsbedingungen|gesch(ae|ä)ftsbedingungen|terms|nutzungsbedingungen/i],
  ['dispute', /streitschlichtung|streitbeilegung|verbraucherstreit|schlichtungsstelle|dispute[\s-]resolution/i],
  ['accessibility', /barrierefreiheit|accessibility/i],
  ['checkout', /checkout|\bkasse\b|bestellung-abschliessen|(?:^|\/)bezahlen\/?(?:\?.*)?$/i],
  ['cart', /warenkorb|\bcart\b|\bbasket\b|einkaufswagen/i],
  ['account', /\b(login|anmelden|konto|account|mein-konto|registrieren|register)\b/i],
  ['shop', /\/(shop|store|merch)\/?(\s|$)/i],
  ['product', /\/(produkt|product|products|produkte|artikel|item)\/|\b(order|bestellen|jetzt kaufen|buy now|in den warenkorb)\b/i],
  ['contact', /kontakt|contact/i],
  ['blog', /\/(blog|news|aktuelles|magazin|beitrag|posts?)\//i],
];

/** Page types worth one to three extra pages in the deep check (decision 15a). */
export const DEEP_CHECK_TYPES = ['product', 'cart', 'checkout', 'account', 'contact', 'blog'];

/** Legal page types the report needs; they are always added when linked. */
export const LEGAL_TYPES = ['imprint', 'privacy', 'withdrawal', 'terms', 'dispute', 'accessibility'];

/** Blog and product paths: a legal word in them ("5-datenschutz-tipps", "privacy-folie") names a topic, not a legal page. */
const NON_LEGAL_PATH = /\/(blog|news|aktuelles|magazin|beitrag|posts?|produkt|product|products|produkte|artikel|item)\//i;

/**
 * @param {string} url
 * @param {string} [linkText]
 * @returns {string} page type or "other"
 */
export function classifyPage(url, linkText = '') {
  const path = decodeSafe(pathOf(url));
  const patterns = NON_LEGAL_PATH.test(path) ? PAGE_TYPE_PATTERNS.filter(([type]) => !LEGAL_TYPES.includes(type)) : PAGE_TYPE_PATTERNS;
  const byPath = firstMatch(path, patterns);
  return byPath !== 'other' ? byPath : firstMatch(linkText, patterns);
}

/**
 * Type of a page that was loaded: by URL path first; the page title only identifies legal pages
 * and only below the root, because a title such as "Kanzlei für Datenschutz" says nothing about
 * the page type ("bestellen", "kasse" in titles and texts of ordinary pages are not shop signals).
 * @param {string} url
 * @param {string} [title]
 * @returns {string} page type or "other"
 */
export function classifyVisitedPage(url, title = '') {
  const byPath = classifyPage(url);
  if (byPath !== 'other') return byPath;
  let pathname = '/';
  try {
    pathname = new URL(url).pathname;
  } catch {
    // not a URL: treat like a root path, the title is not trusted
  }
  if (pathname === '/' || pathname === '') return 'other';
  return firstMatch(title, PAGE_TYPE_PATTERNS.filter(([type]) => LEGAL_TYPES.includes(type)));
}

function pathOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function firstMatch(text, patterns) {
  for (const [type, pattern] of patterns) {
    if (pattern.test(text)) return type;
  }
  return 'other';
}

function decodeSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Pick extra URLs for page types that the sample does not cover yet.
 * @param {(string|{url: string, text?: string})[]} candidateUrls URLs from the sitemap and from links (with link text)
 * @param {Set<string>} coveredTypes types already in the sample
 * @param {Set<string>} visited canonical URLs already scanned; a candidate that differs from one of them only by query string is skipped
 * @param {number} perType maximum extra pages per missing type
 * @returns {{type: string, url: string}[]}
 */
export function selectDeepCheckUrls(candidateUrls, coveredTypes, visited, perType = 3) {
  const picked = [];
  const counts = new Map();
  const seenKeys = new Set([...visited].map(pageKey));
  for (const candidate of candidateUrls) {
    const { url, text = '' } = typeof candidate === 'string' ? { url: candidate } : candidate;
    if (visited.has(url) || seenKeys.has(pageKey(url))) continue;
    const type = classifyPage(url, text);
    if (!DEEP_CHECK_TYPES.includes(type) || coveredTypes.has(type)) continue;
    const count = counts.get(type) ?? 0;
    if (count >= perType) continue;
    counts.set(type, count + 1);
    seenKeys.add(pageKey(url));
    picked.push({ type, url });
  }
  return picked;
}

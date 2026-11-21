// Choose the pages of the sample from the links of the start page (decision 3a):
// legal pages from header/footer/navigation first (at most two per type, not counted against the limits), then the
// other header/footer/navigation links, then links in the main content.

import { canonicalPageUrl, isForeignLanguage, isSameSite, languagePrefix, NON_PAGE_EXTENSIONS, pageKey } from './url.mjs';
import { classifyPage, LEGAL_TYPES } from './page-types.mjs';

/**
 * @param {{href: string, text?: string, region?: string}[]} links links of the start page
 * @param {URL} startUrl final URL of the start page: host of the site and language prefix to prefer
 * @param {{maxNavPages: number, maxExtraPages: number}} limits apply to non-legal pages only
 * @returns {string[]} canonical URLs in scan order
 */
export function sampleTargets(links, startUrl, limits) {
  const prefix = languagePrefix(startUrl.href);
  const foreign = (url) => isForeignLanguage(url, prefix);
  const usable = links
    .filter((l) => isSameSite(l.href, startUrl) && !NON_PAGE_EXTENSIONS.test(new URL(l.href, startUrl).pathname))
    .map((l) => ({ url: canonicalPageUrl(l.href, startUrl), type: classifyPage(l.href, l.text), region: l.region }))
    .filter((l) => l.url);
  const legal = legalTargets(usable, foreign);
  const legalKeys = new Set(legal.map(pageKey));
  const taken = new Set(legalKeys);
  // Decision 109a: ordinary pages in other languages than the start page come last (stable sort), so the limits cut them first.
  const rest = (list) => unique(list.filter((l) => !legalKeys.has(pageKey(l.url))), taken).sort((a, b) => Number(foreign(a)) - Number(foreign(b)));
  const nav = rest(usable.filter((l) => l.region !== 'main'));
  const other = rest(usable.filter((l) => l.region === 'main'));
  return [...legal, ...nav.slice(0, limits.maxNavPages), ...other.slice(0, limits.maxExtraPages)];
}

const MAX_LEGAL_PER_TYPE = 2;

/**
 * Legal pages linked outside the main content (header, footer, navigation), footer links first: at most two per type
 * in the start language (or without language prefix); a type that only exists in another language is taken once.
 */
function legalTargets(usable, foreign) {
  const legal = usable.filter((l) => LEGAL_TYPES.includes(l.type) && l.region !== 'main')
    .sort((a, b) => Number(a.region !== 'footer') - Number(b.region !== 'footer'));
  const own = [];
  const perType = new Map();
  const taken = new Set();
  for (const l of legal.filter((x) => !foreign(x.url))) {
    const key = pageKey(l.url);
    if (taken.has(key) || (perType.get(l.type) ?? 0) >= MAX_LEGAL_PER_TYPE) continue;
    taken.add(key);
    perType.set(l.type, (perType.get(l.type) ?? 0) + 1);
    own.push(l.url);
  }
  const covered = new Set(perType.keys());
  const others = [];
  for (const l of legal.filter((x) => foreign(x.url))) {
    if (covered.has(l.type)) continue;
    covered.add(l.type);
    others.push(l.url);
  }
  return [...own, ...others];
}

/** URLs in order, one per page key (origin, path and content-selecting parameters; first kept); `taken` keys are skipped and extended. */
function unique(list, taken) {
  const urls = [];
  for (const { url } of list) {
    const key = pageKey(url);
    if (taken.has(key)) continue;
    taken.add(key);
    urls.push(url);
  }
  return urls;
}

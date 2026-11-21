// URL helpers: validate the start URL and decide whether a URL belongs to the checked site.

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// Suffixes that need three labels for the registrable domain: second-level public suffixes
// and hosting platforms where every customer owns a subdomain ("shop.github.io" is not "github.io").
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'nhs.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk', 'sch.uk',
  'gv.at', 'co.at', 'or.at', 'com.au', 'net.au', 'org.au', 'co.nz', 'com.br', 'co.jp', 'co.za', 'co.in',
  'com.tr', 'com.mx', 'com.cn', 'com.hk', 'com.sg', 'com.tw', 'com.ar', 'com.ua', 'co.kr',
  'github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'herokuapp.com',
  'myshopify.com', 'wixsite.com', 'wixstudio.io', 'blogspot.com', 'wordpress.com', 'weebly.com',
  'squarespace.com', 'webflow.io', 'jimdofree.com', 'jimdosite.com', 'azurewebsites.net',
  'cloudfront.net', 'appspot.com', 'web.app', 'firebaseapp.com',
]);

/**
 * Turn user input such as "www.xyz.de" into a validated URL object.
 * @param {string} input
 * @returns {URL}
 * @throws {Error} when the input is not an http(s) URL without credentials
 */
export function normalizeStartUrl(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new Error('No URL given.');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid URL: ${trimmed}`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) throw new Error(`Only http and https are allowed: ${trimmed}`);
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed.');
  url.hash = '';
  return url;
}

/**
 * Registrable domain approximation ("shop.example.co.uk" -> "example.co.uk").
 * @param {string} hostname
 * @returns {string}
 */
export function baseDomain(hostname) {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2 || /^\d+$/.test(labels.at(-1))) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return TWO_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/**
 * True when the URL belongs to a different registrable domain than the site.
 * @param {string} requestUrl
 * @param {string} siteHostname
 */
export function isThirdParty(requestUrl, siteHostname) {
  let host;
  try {
    host = new URL(requestUrl).hostname;
  } catch {
    return false;
  }
  if (!host) return false;
  return baseDomain(host) !== baseDomain(siteHostname);
}

/**
 * Same site for crawling: same hostname, ignoring a leading "www.".
 * @param {string} candidate
 * @param {URL} start
 */
export function isSameSite(candidate, start) {
  try {
    const url = new URL(candidate, start);
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) return false;
    const strip = (h) => h.toLowerCase().replace(/^www\./, '');
    return strip(url.hostname) === strip(start.hostname);
  } catch {
    return false;
  }
}

/**
 * Canonical form used to de-duplicate crawl targets (no hash, no trailing slash).
 * @param {string} href
 * @param {URL} base
 * @returns {string|null}
 */
export function canonicalPageUrl(href, base) {
  try {
    const url = new URL(href, base);
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
    url.hash = '';
    const text = url.toString();
    return text.endsWith('/') && url.pathname !== '/' ? text.slice(0, -1) : text;
  } catch {
    return null;
  }
}

/** File types that are not HTML pages and are never crawled. */
export const NON_PAGE_EXTENSIONS = /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?|pptx?|ics|vcf|xml|json|css|js)$/i;

/** Query parameters that only vary the view of a page (variants, filters, sorting, tracking, cart actions), never its content. */
const VIEW_PARAMETER = /^(attribute_.*|e-filter-.*|filter_.*|utm_.*|fbclid|gclid|dclid|gbraid|wbraid|msclkid|srsltid|gad_source|mc_cid|orderby|sort|colou?r|size|variant|add-to-cart|quantity|e-redirect)$/i;

/**
 * Origin ("www." and the bare host are one), path (double slashes collapsed, no trailing slash) and the query parameters that select content, sorted: pages that differ only by
 * variant, filter or tracking parameters share one key; `?page_id=1` and `?page_id=2` do not.
 * @param {string} href
 * @returns {string}
 */
export function pageKey(href) {
  try {
    const url = new URL(href);
    const kept = [...url.searchParams].filter(([name]) => !VIEW_PARAMETER.test(name)).map(([name, value]) => `${name}=${value}`).sort();
    const origin = `${url.protocol}//${url.host.replace(/^www\./i, '')}`;
    return `${origin}${url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '')}${kept.length ? `?${kept.join('&')}` : ''}`;
  } catch {
    return String(href);
  }
}

const LANGUAGE_SEGMENT = /^[a-z]{2}(-[a-z]{2})?$/i;

/** Language-like first path segment ("de" for /de/impressum), else "" (page without language prefix). */
export function languagePrefix(href) {
  try {
    const first = new URL(href).pathname.split('/').find(Boolean) ?? '';
    return LANGUAGE_SEGMENT.test(first) ? first.toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * True when the page is in another language than the start page: with a language prefix on the start URL (/de/) every
 * page with another or no prefix counts as foreign (keeeper.com: "/data-protection/" is the English page);
 * without a prefix on the start URL only pages with a language prefix are foreign.
 * @param {string} href page URL
 * @param {string} startPrefix languagePrefix of the start page
 */
export function isForeignLanguage(href, startPrefix) {
  const prefix = languagePrefix(href);
  return startPrefix === '' ? prefix !== '' : prefix !== startPrefix;
}

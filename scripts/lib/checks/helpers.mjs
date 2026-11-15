// Shared helpers for the check modules. A check returns candidate findings; Claude
// verifies each against the evidence before it goes into the report.

import { LEGAL_TYPES } from '../page-types.mjs';
import { matchService } from '../third-parties.mjs';
import { isThirdParty } from '../url.mjs';

/**
 * @typedef {object} Finding
 * @property {string} check   checklist id, e.g. "IMP-01" (see references/checklist.md)
 * @property {'gap'|'hint'|'ok'} status  gap = likely violation, hint = needs manual review
 * @property {string} title   short English description
 * @property {string[]} pages page URLs concerned
 * @property {object} evidence machine-readable evidence (requests, screenshots, texts)
 */

/** @returns {Finding} */
export function finding(check, status, title, pages = [], evidence = {}) {
  return { check, status, title, pages, evidence };
}

/** Pages that loaded without error. */
export const okPages = (scan) => scan.pages.filter((p) => !p.error && !p.skipped && p.facts);

/** HTTP error status (4xx/5xx): the server answered, but not with the page. */
export const isErrorStatus = (page) => typeof page.status === 'number' && page.status >= 400;

/** Pages whose content may be judged: loaded and not answered with an HTTP error. */
export const contentPages = (scan) => okPages(scan).filter((p) => !isErrorStatus(p));

/** Vendor host names that are no service host in data/third-parties.json but carry vendors' own privacy pages. */
const VENDOR_POLICY_HOSTS = ['policies.google.com'];

/** A link to a known third-party vendor (e.g. policies.google.com) is never the site's own legal page. */
function isVendorLink(href) {
  try {
    const host = new URL(href).hostname.toLowerCase();
    return matchService(href) !== null || VENDOR_POLICY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

const matchesLink = (l, pattern) => pattern.test(l.text) || pattern.test(safePath(l.href));

/** True when any link on the page matches the pattern by text or URL. */
export function hasLink(page, pattern) {
  return page.facts.links.some((l) => matchesLink(l, pattern));
}

/**
 * How a legal link (imprint, privacy policy) is present on a page. Links to vendor hosts do not count.
 * @returns {'ok'|'hidden'|'otherDomain'|null} ok: visible link on the site itself; hidden: on the site but not visible
 *   (e.g. collapsed footer); otherDomain: only a link to another domain (group imprint); null: no such link
 */
export function legalLinkKind(page, pattern) {
  const host = hostOf(page.finalUrl ?? page.url);
  const own = (l) => host !== '' && !isThirdParty(l.href, host);
  const links = page.facts.links.filter((l) => matchesLink(l, pattern) && (own(l) || !isVendorLink(l.href)));
  if (links.some((l) => own(l) && l.visible !== false)) return 'ok';
  if (links.some(own)) return 'hidden';
  return links.length > 0 ? 'otherDomain' : null;
}

function hostOf(href) {
  try {
    return new URL(href).hostname;
  } catch {
    return '';
  }
}

/** Find the first scanned page of a type that is not an HTTP error page. */
export const pageOfType = (scan, type) => contentPages(scan).find((p) => p.pageType === type) ?? null;

/** Path and title of a page: the host name must not decide what a page is about. */
const pathAndTitle = (page) => `${safePath(page.finalUrl ?? page.url)} ${page.facts.title ?? ''}`;

/** True when a link in a footer points to the page. */
function footerLinked(scan, page) {
  const target = (page.finalUrl ?? page.url).replace(/\/$/, '');
  return okPages(scan).some((p) => p.facts.links.some((l) => l.region === 'footer' && l.href.replace(/\/$/, '') === target));
}

/** The privacy policy page; it may share a page with the imprint (e.g. "Impressum & Datenschutz"). */
export function policyPage(scan) {
  const typed = pageOfType(scan, 'privacy');
  if (typed) return typed;
  const candidates = contentPages(scan).filter((p) => PATTERNS.privacy.test(pathAndTitle(p)));
  return candidates.find((p) => footerLinked(scan, p)) ?? candidates[0] ?? null;
}

export function safePath(href) {
  try {
    const url = new URL(href);
    return decodeURIComponent(url.pathname + url.search);
  } catch {
    return String(href);
  }
}

/** Screenshot paths for a page, for the evidence column. */
export const shotsOf = (page) => Object.values(page.screenshots ?? {});

/** Pages whose prices count: legal pages name amounts (share capital, fines) that are no offer prices. */
export const pricedPages = (pages) => pages.filter((p) => p.facts.prices.length > 0 && !LEGAL_TYPES.includes(p.pageType));

/** Signals that the site sells to consumers online (prices, cart, checkout). */
export function looksLikeShop(scan) {
  const pages = okPages(scan);
  const cartButton = pages.some((p) => p.facts.buttons.some((b) => /in den warenkorb|add to cart|jetzt kaufen|buy now/i.test(b.text)));
  const pricesOnPages = pricedPages(pages).length;
  // Cart and checkout pages are shop signals by themselves; a product or shop page only together with a price.
  const cartPage = pages.some((p) => ['cart', 'checkout'].includes(p.pageType));
  const productPage = pages.some((p) => ['product', 'shop'].includes(p.pageType)) && pricesOnPages >= 1;
  return cartPage || productPage || cartButton || pricesOnPages >= 2;
}

export const PATTERNS = {
  imprint: /impressum|imprint|anbieterkennzeichnung|legal notice/i,
  privacy: /datenschutz|privacy/i,
  withdrawal: /widerruf/i,
  terms: /\bagb\b|geschäftsbedingungen|geschaeftsbedingungen|terms/i,
  accessibility: /barrierefreiheit|accessibility/i,
  vatNote: /enthalten\s+(die\s+)?(gesetzl\w*\.?\s*)?(mwst|mehrwertsteuer|umsatzsteuer|ust)\b|(inkl\.?|inklusive|incl\.?|including|einschl(\.|ießlich|iesslich)|enth(ält|\.)?)\s*(\d+(,\d+)?\s*%\s*)?(der\s+)?((jeweils\s+)?(gültig|geltend|gesetzl)\w*\.?\s*)?(mwst|ust|mehrwertsteuer|umsatzsteuer|vat)\b|(?<!(zzgl\.?|zuzüglich|exkl\.?)\s*(\d+\s*%\s*)?(gesetzl\w*\.?\s*)?)\b(mwst|ust|mehrwertsteuer|umsatzsteuer|vat)\.?\s*(ist\s+)?(enthalten|inklusive(?=\s*(?:[.;!,)]|$))|inkl\.?(?=\s*(?:[;!)]|$)))|§\s*19\s*UStG/i,
  netNote: /(zzgl\.?|zuzüglich|exkl\.?|netto)\s*(\d+\s*%\s*)?(gesetzl(\.|ichen)?\s*)?(mwst|ust|mehrwertsteuer|umsatzsteuer)/i,
  shippingNote: /versand|lieferkosten|shipping/i,
  reject: /ablehnen|nur (technisch )?(notwendige|essenzielle|essentielle|erforderliche)|nur (die )?(notwendigen|essenziellen|essentiellen|erforderlichen)|nicht zustimmen|nicht (zulassen|erlauben)|ohne einwilligung|ohne zustimmung|nein,? danke|(necessary|essential|required) only|only (necessary|essential|required)|reject|deny|decline|refuse|verweigern/i,
  accept: /akzeptieren|zustimmen|einverstanden|erlauben|zulassen|accept|allow|agree|got it|\bok\b|verstanden/i,
};

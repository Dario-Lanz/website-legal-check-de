// Duties for online sales to consumers: prices (PAngV), order button and cancellation
// button (BGB), dispute resolution notice, product safety and environmental claims.

import { finding, looksLikeShop, okPages, PATTERNS, pricedPages, shotsOf } from './helpers.mjs';
import { CANCEL_BUTTON_TEXT, servicePricePages, serviceHints } from './service-hints.mjs';

const url = (p) => p.finalUrl ?? p.url;
export const ORDER_BUTTON = /bestell|kaufen|buy|order|zahlen|bezahlen|abschlie(ß|ss)en|absenden|submit/i;
// Whole label must match: extra words ("Jetzt kaufen und weiter zur Zahlung") are not accepted.
const COMPLIANT_ORDER_BUTTON = /^(jetzt )?(zahlungspflichtig|kostenpflichtig) bestellen$|^zahlungspflichtigen vertrag abschlie(ß|ss)en$|^(jetzt )?kaufen$/i;

/** True when an order button label is "zahlungspflichtig bestellen" or an accepted equivalent. */
export function isCompliantOrderLabel(label) {
  return COMPLIANT_ORDER_BUTTON.test(String(label).replace(/\s+/g, ' ').trim());
}
export const SUBSCRIPTION = /\babo\b|abonnement|mitgliedschaft|monatlich kündbar|mindestlaufzeit|\/\s?monat|pro monat|im monat/i;
export const CANCEL_BUTTON = CANCEL_BUTTON_TEXT;
export const WITHDRAW_FUNCTION = /vertrag widerrufen|widerruf hier|widerruf erklären/i;
export const MANUFACTURER = /hersteller|manufacturer|marke|brand/i;
const ODR_LINK = /ec\.europa\.eu\/consumers\/odr/i;
export const DISPUTE_NOTICE = /streitbeilegung|schlichtungsstelle|verbraucherschlichtung/i;
export const GREEN_CLAIM = /klimaneutral|co2-?neutral|co₂-?neutral|klimapositiv|umweltfreundlich|nachhaltig(er|e|es)?\b|ökologisch|grün(er|e)? (produkt|energie)/i;

const MAX_PRICE_PAGES = 10;
const MAX_PRICES_PER_PAGE = 3;

/** Evidence of a price finding: every price page (up to 10) with up to three of its prices, and the first two page photos. */
function priceEvidence(pages) {
  return {
    priceExamples: pages.slice(0, MAX_PRICE_PAGES).map((p) => ({ page: url(p), prices: p.facts.prices.slice(0, MAX_PRICES_PER_PAGE).map(({ text, context }) => ({ text, context })) })),
    screenshots: pages.slice(0, 2).flatMap(shotsOf),
  };
}

function pricesWithoutVat(priced) {
  return priced
    .filter((p) => !PATTERNS.vatNote.test(p.facts.bodyText) && !PATTERNS.netNote.test(p.facts.bodyText));
}

/** Without shop evidence the prices only give hints (decision 108a); with it, missing VAT notes are gaps. */
function priceChecks(pages, shop = true) {
  const priced = shop ? pricedPages(pages) : servicePricePages(pages);
  const results = [];
  const suffix = shop ? '' : ' (no shop evidence detected, please check)';
  const noVat = pricesWithoutVat(priced);
  if (noVat.length > 0) {
    results.push(finding('PRC-01', shop ? 'gap' : 'hint', `Prices shown without a VAT note (inkl. MwSt.)${suffix}`, noVat.map(url), priceEvidence(noVat)));
  }
  const netOnly = priced.filter((p) => PATTERNS.netNote.test(p.facts.bodyText) && !PATTERNS.vatNote.test(p.facts.bodyText));
  if (netOnly.length > 0) {
    results.push(finding('PRC-01', 'hint', 'Only net prices (zzgl. MwSt.) – allowed only if the site addresses businesses exclusively', netOnly.map(url), priceEvidence(netOnly)));
  }
  const noShipping = priced.filter((p) => !PATTERNS.shippingNote.test(p.facts.bodyText));
  if (noShipping.length > 0) {
    results.push(finding('PRC-02', 'hint', `Prices without a note on shipping costs${suffix}`, noShipping.map(url), priceEvidence(noShipping)));
  }
  return results;
}

function orderButton(pages) {
  const checkout = pages.filter((p) => p.pageType === 'checkout');
  if (checkout.length === 0) {
    return [finding('BTN-01', 'hint', 'Final order button not reachable without account or payment; check manually', [])];
  }
  const buttons = checkout.flatMap((p) => p.facts.buttons.filter((b) => b.visible && ORDER_BUTTON.test(b.text)).map((b) => ({ page: url(p), text: b.text })));
  const bad = buttons.filter((b) => !isCompliantOrderLabel(b.text));
  if (bad.length === 0) return [];
  return [finding('BTN-01', 'gap', 'Order button label is not "zahlungspflichtig bestellen" or equally clear', [...new Set(bad.map((b) => b.page))], { buttons: bad })];
}

const ODR_TEXT_CONTEXT = 60;
const ODR_EXPLANATION_CONTEXT = 100;
// A sentence that says the platform was shut down explains it and is no outdated reference (flagged, never suppressed).
const SHUT_DOWN_WORDS = /eingestellt|abgeschaltet|shut down|discontinued/i;

/** ODR-01: the platform address as a link or as plain text (e.g. "https://ec.europa.eu/consumers/odr/" in the imprint text). */
function odrFindings(pages, links) {
  const odrLinks = links.filter((l) => ODR_LINK.test(l.href));
  const mentions = pages.flatMap((p) => {
    const match = ODR_LINK.exec(`${p.facts.bodyText}\n${p.facts.footerText ?? ''}`);
    if (!match) return [];
    const text = `${p.facts.bodyText}\n${p.facts.footerText ?? ''}`;
    const snippet = text.slice(Math.max(0, match.index - ODR_TEXT_CONTEXT), match.index + match[0].length + ODR_TEXT_CONTEXT).replace(/\s+/g, ' ').trim();
    const around = text.slice(Math.max(0, match.index - ODR_EXPLANATION_CONTEXT), match.index + match[0].length + ODR_EXPLANATION_CONTEXT);
    return [{ page: url(p), snippet, possiblyExplanatory: SHUT_DOWN_WORDS.test(around) }];
  });
  const linkPages = pages.filter((p) => p.facts.links.some((l) => ODR_LINK.test(l.href))).map(url);
  const pageList = [...new Set([...linkPages, ...mentions.map((m) => m.page)])];
  if (pageList.length === 0) return [];
  return [finding('ODR-01', 'gap', 'Outdated reference to the EU online dispute resolution platform', pageList, {
    links: odrLinks.slice(0, 3).map((l) => l.href), textMentions: mentions.slice(0, 5),
  })];
}

function textChecks(pages) {
  const all = pages.map((p) => p.facts.bodyText).join('\n');
  const links = pages.flatMap((p) => p.facts.links);
  const results = [];
  if (SUBSCRIPTION.test(all) && !CANCEL_BUTTON.test(all)) {
    results.push(finding('KUE-01', 'hint', 'Subscription wording found, but no "Verträge hier kündigen" button', []));
  }
  if (!WITHDRAW_FUNCTION.test(all)) {
    results.push(finding('WID-02', 'hint', 'No online withdrawal function labelled "Vertrag widerrufen" found (§ 356a BGB since 19.06.2026)', []));
  }
  results.push(...odrFindings(pages, links));
  if (!DISPUTE_NOTICE.test(all)) results.push(finding('VSB-01', 'hint', 'No statement on consumer dispute resolution found (VSBG)', []));
  return results;
}

function productChecks(pages) {
  const products = pages.filter((p) => p.pageType === 'product');
  const noMaker = products.filter((p) => !MANUFACTURER.test(p.facts.bodyText));
  return noMaker.length > 0 ? [finding('GPSR-01', 'hint', 'Product pages without manufacturer information (GPSR Art. 19)', noMaker.map(url))] : [];
}

function greenClaims(pages) {
  const hits = pages.filter((p) => GREEN_CLAIM.test(p.facts.bodyText))
    .map((p) => ({ page: url(p), claim: p.facts.bodyText.match(GREEN_CLAIM)[0] }));
  return hits.length > 0 ? [finding('UWG-02', 'hint', 'Environmental claims found; they need specific proof', hits.map((h) => h.page), { claims: hits.slice(0, 5) })] : [];
}

export function checkShop(scan) {
  const pages = okPages(scan);
  const results = [...greenClaims(pages)];
  if (!looksLikeShop(scan)) return [...priceChecks(pages, false), ...serviceHints(pages), ...results];
  return [...priceChecks(pages), ...orderButton(pages), ...textChecks(pages), ...productChecks(pages), ...results];
}

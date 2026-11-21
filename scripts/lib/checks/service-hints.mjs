// Sites with prices but without shop evidence (no cart, checkout or shop platform), e.g. fitness studios or B2B
// service providers (decision 108a): their price, subscription and online-booking signals give hints ("Bitte prüfen"),
// never gaps. With real shop evidence shop.mjs keeps its own checks.

import { LEGAL_TYPES } from '../page-types.mjs';
import { finding, pricedPages, shotsOf } from './helpers.mjs';

const url = (p) => p.finalUrl ?? p.url;
const NO_SHOP = 'no shop evidence detected, please check';
// Wording of a recurring contract next to a price. The checklist Words[subscription-price] lists it.
export const SUBSCRIPTION_PRICE = /\babo\b|abonnement|mitgliedschaft|monatlich|laufzeit|\/\s?monat|pro monat|im monat|\/\s?month|per month/i;
export const CANCEL_BUTTON_TEXT = /verträge hier kündigen|vertrag hier kündigen|kündigungsbutton/i;
// A contract concluded online, named in a form. The checklist Words[booking-form] lists it.
export const BOOKING_CONTRACT = /(mitgliedschaft|vertrag)\s+(online\s+)?abschlie(ß|ss)en|jetzt\s+kostenpflichtig|zahlungspflichtig\s+(buchen|bestellen)/i;
// A booking counts only together with payment wording in the same form ("Termin buchen" alone is a contact request).
const BOOKING_VERB = /(termin|kurs|platz|ticket|reise)\s+(jetzt\s+)?buchen|buchung/i;
const PAYMENT_WORDS = /zahlung|bezahl|kreditkarte|iban|sepa|paypal|kostenpflichtig|rechnung/i;

// Conservative offer wording: a lone amount counts as a price only with it ("220.000 EURO" in a project report does not).
const OFFER_WORDING = /\b(buchen|bestellen|kostet|preis(e|liste)?|tarife?|pakete?)\b|\bab\s+\d[\d.,]*\s?(€|eur)/i;

/**
 * Pages whose prices give hints without shop evidence: prices on at least two content pages, or on one page that
 * also uses offer wording. (Amounts in cent without € are no prices at all: the collector requires € or EUR.)
 */
export function servicePricePages(pages) {
  const priced = pricedPages(pages);
  return priced.length >= 2 ? priced : priced.filter((p) => OFFER_WORDING.test(p.facts.bodyText));
}

const contentPages = (pages) => pages.filter((p) => !LEGAL_TYPES.includes(p.pageType));

/** KUE-01: subscription wording in the context of a price, and no cancellation button anywhere. */
function subscriptionHint(pages) {
  const hits = contentPages(pages).filter((p) => p.facts.prices.some((price) => SUBSCRIPTION_PRICE.test(price.context ?? price.text)));
  if (hits.length === 0 || CANCEL_BUTTON_TEXT.test(pages.map((p) => p.facts.bodyText).join('\n'))) return [];
  return [finding('KUE-01', 'hint', `Subscription wording next to prices, but no "Verträge hier kündigen" button (${NO_SHOP})`, hits.map(url), {
    priceExamples: hits.slice(0, 3).map((p) => p.facts.prices.find((price) => SUBSCRIPTION_PRICE.test(price.context ?? price.text))),
  })];
}

const isBookingForm = (form) => BOOKING_CONTRACT.test(form.text ?? '') || (BOOKING_VERB.test(form.text ?? '') && PAYMENT_WORDS.test(form.text ?? ''));

/** BTN-01: a form that concludes a contract or a paid booking online. */
function bookingHint(pages) {
  const hits = contentPages(pages).filter((p) => p.facts.forms.some(isBookingForm));
  if (hits.length === 0) return [];
  return [finding('BTN-01', 'hint', `Online booking or contract form found; its final button must say „zahlungspflichtig bestellen“ or equally clear (${NO_SHOP})`, hits.map(url), {
    forms: hits.slice(0, 3).map((p) => p.facts.forms.find(isBookingForm).text.slice(0, 200)),
    screenshots: hits.slice(0, 2).flatMap(shotsOf),
  })];
}

/** Hints for a site with prices but without shop evidence. */
export function serviceHints(pages) {
  return [...subscriptionHint(pages), ...bookingHint(pages)];
}

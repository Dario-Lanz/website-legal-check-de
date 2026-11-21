// Decision 108a: prices alone are no shop, but without shop evidence they still give hints:
// PRC-01/PRC-02 (prices), KUE-01 (subscription wording at prices), BTN-01 (online booking or contract form).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkShop } from '../scripts/lib/checks/shop.mjs';
import { looksLikeShop } from '../scripts/lib/checks/helpers.mjs';
import { BOOKING_CONTRACT, SUBSCRIPTION_PRICE } from '../scripts/lib/checks/service-hints.mjs';

const facts = (over = {}) => ({ title: '', links: [], buttons: [], forms: [], prices: [], banner: null, bodyText: '', footerText: '', ...over });
const page = (index, path, pageType, over = {}) => ({ index, url: `https://x.de${path}`, finalUrl: `https://x.de${path}`, status: 200, pageType, facts: facts(over) });
const scanOf = (pages) => ({ startUrl: 'https://x.de/', host: 'x.de', pages, requests: [], cookies: [], transport: {} });
const price = (text, context = text) => [{ text, context }];
const only = (findings, ...checks) => findings.filter((f) => checks.includes(f.check));

const studio = scanOf([
  page(1, '/', 'other', { prices: price('29 €', 'Mitgliedschaft ab 29 € / Monat'), bodyText: 'Fitnessstudio. Mitgliedschaft ab 29 € / Monat, Laufzeit 12 Monate.' }),
  page(2, '/mitgliedschaft', 'other', {
    prices: price('29 €', '29 € / Monat'), bodyText: 'Tarife: 29 € / Monat. Zahlung per SEPA.',
    forms: [{ action: 'https://x.de/join', method: 'post', text: 'Name E-Mail IBAN Mitgliedschaft online abschließen' }],
  }),
]);

test('fitness studio (price, /Monat, online membership form, no cart): hints only, no gap', () => {
  assert.equal(looksLikeShop(studio), false);
  const result = checkShop(studio);
  assert.deepEqual(result.filter((f) => f.status === 'gap'), []);
  assert.deepEqual(only(result, 'PRC-01').map((f) => f.status), ['hint']);
  assert.deepEqual(only(result, 'PRC-02').map((f) => f.status), ['hint']);
  const kue = only(result, 'KUE-01');
  assert.deepEqual(kue.map((f) => f.status), ['hint']);
  assert.match(kue[0].title, /no shop evidence/i);
  const btn = only(result, 'BTN-01');
  assert.deepEqual(btn.map((f) => f.status), ['hint']);
  assert.deepEqual(btn[0].pages, ['https://x.de/mitgliedschaft']);
  assert.deepEqual(only(result, 'WID-01', 'WID-02', 'AGB-01', 'VSB-01'), [], 'consumer-contract checks need shop evidence');
});

test('B2B price page with a net note: a net-price hint and the shipping hint, nothing else', () => {
  const scan = scanOf([page(1, '/leistungen', 'other', { prices: price('1.900 €', 'ab 1.900 € netto'), bodyText: 'Beratung ab 1.900 € netto.' })]);
  const result = checkShop(scan);
  assert.deepEqual(result.map((f) => `${f.check}:${f.status}`).sort(), ['PRC-01:hint', 'PRC-02:hint']);
  assert.match(only(result, 'PRC-01')[0].title, /net prices/i);
});

test('prices without any VAT note on a content page: PRC-01 hint, not gap', () => {
  const scan = scanOf([page(1, '/preise', 'other', { prices: price('99 €'), bodyText: 'Paket 99 €' })]);
  assert.deepEqual(only(checkShop(scan), 'PRC-01').map((f) => f.status), ['hint']);
});

test('legal pages with amounts and pages without prices give nothing', () => {
  const scan = scanOf([page(1, '/impressum', 'imprint', { prices: price('25.000 €', 'Stammkapital 25.000 €') }), page(2, '/', 'other', { bodyText: 'Hallo' })]);
  assert.deepEqual(checkShop(scan).filter((f) => /^(PRC|KUE|BTN)/.test(f.check)), []);
});

test('with real shop evidence everything stays as before: gap where applicable', () => {
  const shop = scanOf([
    page(1, '/', 'other', { prices: price('9 €'), bodyText: 'Preis 9 €', buttons: [{ text: 'In den Warenkorb', visible: true }] }),
    page(2, '/kasse', 'checkout', { buttons: [{ text: 'Jetzt bestellen', visible: true }] }),
  ]);
  assert.equal(looksLikeShop(shop), true);
  const result = checkShop(shop);
  assert.deepEqual(only(result, 'PRC-01').map((f) => f.status), ['gap']);
  assert.deepEqual(only(result, 'BTN-01').map((f) => f.status), ['gap']);
  assert.ok(only(result, 'WID-02').length > 0);
});

test('subscription wording must stand at a price; a cancel button silences KUE-01', () => {
  for (const context of ['29 € / Monat', '29 € pro Monat', 'monatlich 29 €', 'Abo 9 €', 'Mitgliedschaft 19 €', '12 Monate Laufzeit 99 €', '9 €/month']) {
    assert.ok(SUBSCRIPTION_PRICE.test(context), context);
  }
  assert.equal(SUBSCRIPTION_PRICE.test('Wir arbeiten seit Monaten daran'), false);
  const noSub = scanOf([page(1, '/', 'other', { prices: price('99 €', 'Workshop 99 €'), bodyText: 'Wir informieren monatlich im Newsletter. Workshop 99 €' })]);
  assert.deepEqual(only(checkShop(noSub), 'KUE-01'), [], 'wording elsewhere on the page is not at the price');
  const withCancel = scanOf([page(1, '/', 'other', { prices: price('9 €', '9 € / Monat'), bodyText: '9 € / Monat. Verträge hier kündigen' })]);
  assert.deepEqual(only(checkShop(withCancel), 'KUE-01'), []);
});

test('booking and contract forms: conservative patterns', () => {
  for (const text of ['Mitgliedschaft online abschließen', 'Vertrag abschließen', 'Jetzt kostenpflichtig buchen', 'jetzt kostenpflichtig']) {
    assert.ok(BOOKING_CONTRACT.test(text), text);
  }
  const form = (text) => scanOf([page(1, '/x', 'other', { forms: [{ action: '/b', method: 'post', text }], prices: price('5 €') })]);
  assert.deepEqual(only(checkShop(form('Termin buchen Bezahlung per Kreditkarte')), 'BTN-01').map((f) => f.status), ['hint'], 'booking with payment');
  assert.deepEqual(only(checkShop(form('Termin buchen Name E-Mail Nachricht')), 'BTN-01'), [], 'booking without payment is a contact request');
  assert.deepEqual(only(checkShop(form('Newsletter abonnieren E-Mail')), 'BTN-01'), []);
  assert.deepEqual(only(checkShop(form('Kontakt Name E-Mail Nachricht senden')), 'BTN-01'), []);
});

// N2: one stray amount on one content page (trianel: "220.000,- EURO" in a project text) gives no price hints.
test('N2: a single price on a single page without offer wording gives no price hints', () => {
  const trianel = scanOf([
    page(1, '/', 'other', { bodyText: 'Windparks' }),
    page(2, '/referenzen/windpark', 'other', { prices: price('220.000,- EURO', 'Betrag von jährlich 220.000,- EURO, der auf die Kommunen verteilt wird'), bodyText: 'Ein Betrag von jährlich 220.000,- EURO, der auf die Kommunen verteilt wird. 0,2 Cent pro erzeugter Kilowattstunde.' }),
  ]);
  assert.deepEqual(checkShop(trianel).filter((f) => /^(PRC|KUE|BTN)/.test(f.check)), []);
});

test('N2: one priced page with offer wording, or prices on two content pages, give the hints', () => {
  const offer = (bodyText) => scanOf([page(1, '/leistung', 'other', { prices: price('99 €'), bodyText })]);
  for (const text of ['Jetzt Termin buchen: 99 €', 'Unser Preis: 99 €', 'Paket Basic 99 €', 'Das kostet 99 €', 'Tarif S ab 99 €', 'Workshop bestellen 99 €']) {
    assert.ok(only(checkShop(offer(text)), 'PRC-01', 'PRC-02').length > 0, text);
  }
  const two = scanOf([page(1, '/a', 'other', { prices: price('5 €'), bodyText: 'x 5 €' }), page(2, '/b', 'other', { prices: price('6 €'), bodyText: 'y 6 €' })]);
  assert.ok(only(checkShop(two), 'PRC-01').length > 0);
});

test('N2: cent amounts without a currency sign are no prices', async () => {
  const { chromium } = await import('playwright');
  const { collectPageFacts } = await import('../scripts/lib/collect-page.mjs');
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage();
    await p.setContent('<body><p>Zuwendung von 0,2 Cent pro erzeugter Kilowattstunde und 12 ct/kWh.</p></body>');
    assert.deepEqual((await p.evaluate(collectPageFacts)).prices, []);
  } finally {
    await browser.close();
  }
});

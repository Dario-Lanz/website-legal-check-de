// Blind real runs (21.11.): empty prices from skipped content, "Euro" spelled out, evidence of the price hints.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { collectPageFacts } from '../scripts/lib/collect-page.mjs';
import { checkShop } from '../scripts/lib/checks/shop.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

const pricesOf = async (html) => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<body>${html}</body>`);
    return (await page.evaluate(collectPageFacts)).prices;
  } finally {
    await page.close();
  }
};

test('prices in content that is not rendered (content-visibility: hidden) are no prices (keeeper /de/kitchen/)', async () => {
  assert.deepEqual(await pricesOf('<div style="content-visibility:hidden;contain-intrinsic-size:100px"><div><span>75€</span></div></div>'), []);
  const real = await pricesOf('<p>Preis: 75 €</p>');
  assert.equal(real.length, 1);
  assert.ok(real[0].text.trim() !== '' && real[0].context.trim() !== '');
});

test('"Euro" spelled out counts as currency; look-alike words do not', async () => {
  for (const html of ['<p>ab 5.000 Euro</p>', '<p>ab 900 Euro netto</p>', '<p>12,50 EUR</p>', '<p>7 EURO</p>', '<p>ab 3 euro</p>']) {
    assert.equal((await pricesOf(html)).length, 1, html);
  }
  for (const html of ['<p>5 Europäer kamen</p>', '<p>Treffen in 3 Europa-Städten</p>', '<p>2026 EUROPA</p>']) {
    assert.deepEqual(await pricesOf(html), [], html);
  }
});

const facts = (over) => ({ title: '', links: [], buttons: [], forms: [], prices: [], banner: null, bodyText: '', footerText: '', ...over });
const page = (index, path, over) => ({ index, url: `https://x.de${path}`, finalUrl: `https://x.de${path}`, status: 200, pageType: 'other', facts: facts(over), screenshots: { ansicht: `belege/p${index}.jpg` } });
const prices = (...texts) => texts.map((text) => ({ text, context: `ab ${text}` }));

test('the price hints without shop evidence carry the same evidence as the shop variant: every price page, several prices per page', () => {
  const scan = { startUrl: 'https://x.de/', host: 'x.de', requests: [], cookies: [], transport: {}, pages: [
    page(1, '/', { prices: prices('5.000 Euro', '900 Euro', '1.900 € netto', '2.000 Euro', '3.000 Euro'), bodyText: 'ab 5.000 Euro, ab 900 Euro, ab 1.900 € netto' }),
    page(2, '/a', { prices: prices('4.700 €'), bodyText: 'ab 4.700 € netto' }),
  ] };
  const result = checkShop(scan).filter((f) => f.check.startsWith('PRC'));
  assert.ok(result.length >= 2);
  for (const f of result) {
    assert.ok(Array.isArray(f.evidence.priceExamples) && f.evidence.priceExamples.length > 0, `${f.check} ${f.status} ${f.title}`);
  }
  const net = result.find((f) => f.check === 'PRC-01');
  const home = net.evidence.priceExamples.find((e) => e.page === 'https://x.de/');
  assert.deepEqual(home.prices.map((p) => p.text), ['5.000 Euro', '900 Euro', '1.900 € netto'], 'up to three prices per page');
  assert.deepEqual(net.evidence.priceExamples.map((e) => e.page), ['https://x.de/', 'https://x.de/a']);
});

test('the shop gap keeps its evidence with the new structure', () => {
  const scan = { startUrl: 'https://x.de/', host: 'x.de', requests: [], cookies: [], transport: {}, pages: [
    { ...page(1, '/', { prices: prices('9 €'), bodyText: 'Preis 9 €', buttons: [{ text: 'In den Warenkorb', visible: true }] }) },
  ] };
  const gap = checkShop(scan).find((f) => f.check === 'PRC-01' && f.status === 'gap');
  assert.deepEqual(gap.evidence.priceExamples[0], { page: 'https://x.de/', prices: [{ text: '9 €', context: 'ab 9 €' }] });
});

test('R2: content-visibility: auto sections that were not scrolled into view yet are real content, hidden ones are not', async () => {
  const auto = await pricesOf('<div style="height:3000px">Platzhalter</div><section style="content-visibility:auto;contain-intrinsic-size:auto 500px"><p>Preis: 75 €</p></section>');
  assert.equal(auto.length, 1);
  assert.ok(auto[0].context.includes('75'), 'context falls back to textContent');
  assert.deepEqual(await pricesOf('<section style="content-visibility:hidden"><p>Preis: 75 €</p></section>'), []);
  assert.deepEqual(await pricesOf('<div style="content-visibility:hidden"><div><span>75€</span></div></div>'), []);
});

test('R2: a price in a closed <details> is found as before', async () => {
  assert.equal((await pricesOf('<details><summary>Mehr</summary><p>Preis 49 €</p></details>')).length, 1);
});

test('R3: "Euro" inside a compound word is no currency', async () => {
  for (const html of ['<p>500 Euro-Paletten</p>', '<p>Wir liefern 20 Euro-Paletten</p>']) assert.deepEqual(await pricesOf(html), [], html);
  for (const html of ['<p>nur 5 Euro.</p>', '<p>nur 5 Euro, netto</p>', '<p>nur 5 Euro netto</p>']) assert.equal((await pricesOf(html)).length, 1, html);
});

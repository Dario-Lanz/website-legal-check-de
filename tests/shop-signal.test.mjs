// Fix 4: the shop signal needs real shop evidence; prices alone (B2B service sites, "ab 1.900 € netto", "/Monat") are no shop.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkShop } from '../scripts/lib/checks/shop.mjs';
import { looksLikeShop } from '../scripts/lib/checks/helpers.mjs';
import { runChecks } from '../scripts/lib/checks/index.mjs';

const facts = (over = {}) => ({ title: '', links: [], buttons: [], forms: [], prices: [], banner: null, bodyText: '', footerText: '', htmlClasses: '', ...over });
const page = (index, url, pageType, over = {}) => ({ index, url, finalUrl: url, status: 200, pageType, facts: facts(over) });
const scanOf = (pages, over = {}) => ({ startUrl: pages[0].url, host: 'x.de', pages, requests: [], cookies: [], transport: { httpRedirectsToHttps: true }, ...over });
const price = (text) => [{ text, context: text }];

test('prices on several ordinary pages are no shop (service site with "Bis zu 0 € statt 1.900 €" and "/Monat")', () => {
  const scan = scanOf([
    page(1, 'https://x.de/', 'other', { prices: price('Bis zu 0 € statt 1.900 €'), bodyText: 'ab 1.900 € netto, 99 €/Monat' }),
    page(2, 'https://x.de/workshops', 'other', { prices: [...price('4.700 € statt 17.900 €'), ...price('900 €/Monat')] }),
    page(3, 'https://x.de/paket', 'other', { prices: price('1.200 €') }),
  ]);
  assert.equal(looksLikeShop(scan), false);
  const result = checkShop(scan);
  assert.deepEqual(result.map((f) => f.check).filter((c) => /^(WID|AGB|VSB)/.test(c)), [], 'consumer-contract checks need shop evidence');
  assert.deepEqual(result.filter((f) => /^(BTN|KUE|PRC)/.test(f.check) && f.status !== 'hint'), [], 'prices without shop evidence give hints only (decision 108a)');
  assert.equal(runChecks(scan).siteProfile.shopSignals, false);
});

test('real shop evidence still makes a shop', () => {
  const plain = (extra) => scanOf([page(1, 'https://x.de/', 'other', extra.facts ?? {})], extra.scan);
  assert.equal(looksLikeShop(plain({ facts: { links: [{ href: 'https://x.de/cart/', text: 'Cart', region: 'header', visible: true }] } })), true, 'cart link');
  assert.equal(looksLikeShop(plain({ facts: { links: [{ href: 'https://x.de/x', text: 'Zur Kasse', region: 'header', visible: true }] } })), true, 'checkout link text');
  assert.equal(looksLikeShop(plain({ facts: { buttons: [{ text: 'In den Warenkorb', visible: true }] } })), true, 'add-to-cart button');
  assert.equal(looksLikeShop(plain({ facts: { forms: [{ action: 'https://x.de/?add-to-cart=12', method: 'post', text: '' }] } })), true, 'add-to-cart form');
  assert.equal(looksLikeShop(plain({ scan: { requests: [{ url: 'https://cdn.shopify.com/s/files/1/x.css' }] } })), true, 'Shopify');
  assert.equal(looksLikeShop(plain({ facts: { htmlClasses: 'woocommerce-page', generator: 'WordPress 6.8' } })), true, 'WooCommerce add-on');
  assert.equal(looksLikeShop(scanOf([page(1, 'https://x.de/produkt/a', 'product', { prices: price('9 €') })])), true, 'product page with price');
  assert.equal(looksLikeShop(scanOf([page(1, 'https://x.de/cart', 'cart')])), true, 'cart page');
});

test('plain WordPress and a nav link "Kasse"-free page stay no shop', () => {
  assert.equal(looksLikeShop(scanOf([page(1, 'https://x.de/', 'other', { generator: 'WordPress 6.8', links: [{ href: 'https://x.de/krankenkasse', text: 'Krankenkasse', region: 'nav', visible: true }] })])), false);
});

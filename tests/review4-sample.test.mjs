// Review of v1.19.0 (items 3, 8, 9, 12): bounded legal targets, stricter "data protection", dispute pages,
// same-site cart links, view parameters.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPage, LEGAL_TYPES } from '../scripts/lib/page-types.mjs';
import { sampleTargets } from '../scripts/lib/sample-targets.mjs';
import { looksLikeShop, policyPage, PATTERNS } from '../scripts/lib/checks/helpers.mjs';
import { pageKey } from '../scripts/lib/url.mjs';

const SITE = new URL('https://x.com/de');
const link = (path, text = '', region = 'nav') => ({ href: `https://x.com${path}`, text, region, visible: true });
const targets = (links) => sampleTargets(links, SITE, { maxNavPages: 40, maxExtraPages: 20 });

test('legal links in the main content are no priority targets (blog teaser, product copy)', () => {
  const t = sampleTargets([link('/de/blog/5-datenschutz-tipps/', '5 Datenschutz-Tipps', 'main'), link('/de/impressum/', 'Impressum', 'footer')], SITE, { maxNavPages: 40, maxExtraPages: 0 });
  assert.deepEqual(t, ['https://x.com/de/impressum']);
});

test('at most two legal targets per type and language; footer links come first', () => {
  const links = [
    ...[1, 2, 3, 4].map((i) => link(`/de/loesung-${i}/privacy-${i}`, `Privacy Lösung ${i}`, 'header')),
    link('/de/datenschutz/', 'Datenschutz', 'footer'),
  ];
  const priority = sampleTargets(links, SITE, { maxNavPages: 0, maxExtraPages: 0 });
  assert.equal(priority.length, 2, 'only two legal targets per type, however many links');
  assert.equal(priority[0], 'https://x.com/de/datenschutz', 'footer link first');
});

test('"Privacy-Folie" products, "5 Datenschutz-Tipps" blog posts and "Cloud Data Protection" solutions are not privacy pages', () => {
  assert.equal(classifyPage('https://x.com/de/produkte/privacy-folie', 'Privacy-Folie'), 'product');
  assert.equal(classifyPage('https://x.com/de/blog/5-datenschutz-tipps/', '5 Datenschutz-Tipps'), 'blog');
  assert.equal(classifyPage('https://x.com/de/loesungen/cloud-data-protection', 'Cloud Data Protection'), 'other');
  assert.equal(PATTERNS.privacy.test('Cloud Data Protection'), false);
  for (const [url, text] of [['https://x.com/data-protection', ''], ['https://x.com/info', 'Data protection'], ['https://x.com/info', 'Data Protection Policy'], ['https://x.com/data-protection/', '']]) {
    assert.equal(classifyPage(url, text), 'privacy', `${url} ${text}`);
  }
  assert.ok(PATTERNS.privacy.test('Data protection notice'));
});

test('policyPage prefers a footer-linked privacy page over an earlier header solution page', () => {
  const page = (index, url, links = []) => ({ index, url, finalUrl: url, status: 200, pageType: 'privacy', facts: { title: '', links, buttons: [], forms: [], prices: [], bodyText: '' } });
  const footerLink = { href: 'https://x.com/de/datenschutz', text: 'Datenschutz', region: 'footer', visible: true };
  const scan = { startUrl: 'https://x.com/', requests: [], pages: [
    page(1, 'https://x.com/de', [footerLink]), page(2, 'https://x.com/de/loesung/privacy-tool'), page(3, 'https://x.com/de/datenschutz'),
  ] };
  assert.equal(policyPage(scan).url, 'https://x.com/de/datenschutz');
});

test('dispute resolution pages are a legal type and always scanned', () => {
  assert.ok(LEGAL_TYPES.includes('dispute'));
  for (const [url, text] of [['https://x.com/streitschlichtung', ''], ['https://x.com/de/streitbeilegung/', ''], ['https://x.com/info', 'Verbraucherstreitbeilegung'], ['https://x.com/info', 'Streitschlichtung'], ['https://x.com/dispute-resolution', '']]) {
    assert.equal(classifyPage(url, text), 'dispute', `${url} ${text}`);
  }
  const filler = Array.from({ length: 60 }, (_, i) => link(`/de/s-${i}/`));
  assert.equal(targets([...filler, link('/de/streitschlichtung/', 'Streitschlichtung', 'footer')])[0], 'https://x.com/de/streitschlichtung');
});

test('checkout and cart words: basket is a word, "bezahlen" alone is no checkout', () => {
  assert.equal(classifyPage('https://x.com/basketball-club'), 'other');
  assert.equal(classifyPage('https://x.com/info', 'Basketball'), 'other');
  assert.equal(classifyPage('https://x.com/basket'), 'cart');
  assert.equal(classifyPage('https://x.com/info', 'Rechnung online bezahlen'), 'other');
  assert.equal(classifyPage('https://x.com/rechnung/online-bezahlen'), 'other');
  assert.equal(classifyPage('https://x.com/kasse'), 'checkout');
  assert.equal(classifyPage('https://x.com/zur-kasse/'), 'checkout');
});

test('a cart or checkout link counts as shop evidence only on the same registrable domain', () => {
  const scanWith = (href, text) => ({ startUrl: 'https://x.com/', host: 'x.com', requests: [], pages: [{ index: 1, url: 'https://x.com/', finalUrl: 'https://x.com/', status: 200, pageType: 'other', facts: { title: '', links: [{ href, text, region: 'header', visible: true }], buttons: [], forms: [], prices: [], bodyText: '' } }] });
  assert.equal(looksLikeShop(scanWith('https://x.com/cart/', 'Cart')), true);
  assert.equal(looksLikeShop(scanWith('https://other-shop.example/cart/', 'Cart')), false, 'other domain');
  assert.equal(looksLikeShop(scanWith('https://x.com/club', 'Basketball')), false);
  assert.equal(looksLikeShop(scanWith('https://x.com/rechnung', 'Rechnung online bezahlen')), false);
  assert.equal(looksLikeShop(scanWith('https://x.com/info', 'Zur Kasse')), true);
  assert.equal(looksLikeShop(scanWith('https://x.com/info', 'Krankenkasse')), false);
});

test('ad click ids are view parameters', () => {
  for (const q of ['srsltid=A', 'msclkid=A', 'gad_source=1', 'mc_cid=A', 'dclid=A', 'gbraid=A', 'wbraid=A']) {
    assert.equal(pageKey(`https://x.com/a?${q}`), 'https://x.com/a', q);
  }
  assert.notEqual(pageKey('https://x.com/a?page_id=1'), pageKey('https://x.com/a?page_id=2'));
});

// N1: keeeper.com, start /de/: footer links lead to English pages without prefix, the German pages are in the navigation.
const keeeperLinks = [
  link('/de/shop/', 'Shop', 'nav'),
  link('/data-protection/', 'Privacy Policy', 'footer'), link('/legal-notice/', 'Imprint', 'footer'),
  link('/de/datenschutz/', 'Datenschutz', 'nav'), link('/de/impressum/', 'Impressum', 'nav'), link('/de/barrierefreiheit/', 'Barrierefreiheit', 'nav'),
];

test('N1: with a language prefix on the start URL, pages without it are another language and the start language comes first', () => {
  const t = sampleTargets(keeeperLinks, SITE, { maxNavPages: 0, maxExtraPages: 0 });
  assert.deepEqual(t.slice(0, 3).sort(), ['https://x.com/de/barrierefreiheit', 'https://x.com/de/datenschutz', 'https://x.com/de/impressum']);
  assert.equal(t.some((u) => /data-protection|legal-notice/.test(u)), false, 'English duplicates of covered types are not priority targets');
  const nav = sampleTargets([link('/en-less/', 'x', 'nav'), link('/de/kontakt/', 'Kontakt', 'nav'), link('/kontakt-ohne-prefix/', 'K', 'nav')], SITE, { maxNavPages: 40, maxExtraPages: 0 });
  assert.equal(nav[0], 'https://x.com/de/kontakt', 'unprefixed ordinary pages sort after the start language');
});

test('N1: a legal type that exists only without prefix is still scanned (once)', () => {
  const t = sampleTargets([link('/legal-notice/', 'Imprint', 'footer'), link('/de/datenschutz/', 'Datenschutz', 'nav')], SITE, { maxNavPages: 0, maxExtraPages: 0 });
  assert.deepEqual(t, ['https://x.com/de/datenschutz', 'https://x.com/legal-notice']);
});

test('N1: imprint and privacy page checks use the start-language page, not the English footer page', async () => {
  const { pageOfType } = await import('../scripts/lib/checks/helpers.mjs');
  const page = (index, url, pageType, links = []) => ({ index, url, finalUrl: url, status: 200, pageType, facts: { title: '', links, buttons: [], forms: [], prices: [], bodyText: '' } });
  const scan = { startUrl: 'https://x.com/', requests: [], pages: [
    page(1, 'https://x.com/de', 'other', [{ href: 'https://x.com/legal-notice/', text: 'Imprint', region: 'footer' }, { href: 'https://x.com/data-protection/', text: 'Privacy Policy', region: 'footer' }]),
    page(2, 'https://x.com/legal-notice', 'imprint'), page(3, 'https://x.com/data-protection', 'privacy'),
    page(4, 'https://x.com/de/impressum', 'imprint'), page(5, 'https://x.com/de/datenschutz', 'privacy'),
  ] };
  assert.equal(pageOfType(scan, 'imprint').url, 'https://x.com/de/impressum');
  assert.equal(policyPage(scan).url, 'https://x.com/de/datenschutz');
  const onlyEnglish = { ...scan, pages: scan.pages.slice(0, 3) };
  assert.equal(pageOfType(onlyEnglish, 'imprint').url, 'https://x.com/legal-notice', 'fallback when the start language has none');
});

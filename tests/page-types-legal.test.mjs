// v1.18.x follow-ups (decision 106a): legal page types in English and Italian, no query-only duplicates in the sample.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPage, selectDeepCheckUrls } from '../scripts/lib/page-types.mjs';
import { sampleTargets } from '../scripts/lib/sample-targets.mjs';

test('English and Italian legal URLs and link texts get the legal types', () => {
  const cases = {
    'https://x.com/data-protection': 'privacy', 'https://x.com/data-protection/': 'privacy', 'https://x.com/legal-notice': 'imprint',
    'https://x.com/legal_notice': 'imprint', 'https://x.com/it/avviso-legale/': 'imprint', 'https://x.com/it/note-legali': 'imprint',
    'https://x.com/it/informazioni-legali': 'imprint', 'https://x.com/it/protezione-dei-dati/': 'privacy', 'https://x.com/it/privacy': 'privacy',
  };
  for (const [url, type] of Object.entries(cases)) assert.equal(classifyPage(url), type, url);
  assert.equal(classifyPage('https://x.com/info', 'Legal notice'), 'imprint', 'space variant in link text');
  assert.equal(classifyPage('https://x.com/info', 'Data protection'), 'privacy');
  assert.equal(classifyPage('https://x.com/info', 'Avviso legale'), 'imprint');
  assert.equal(classifyPage('https://x.com/info', 'Protezione dei dati'), 'privacy');
  assert.equal(classifyPage('https://x.com/protezione-solare'), 'other', 'look-alike');
});

test('Italian legal pages get legal priority in the sample', () => {
  const site = new URL('https://x.com/it');
  const link = (path, text = '') => ({ href: `https://x.com${path}`, text, region: 'nav', visible: true });
  const filler = Array.from({ length: 60 }, (_, i) => link(`/it/pagina-${i}/`));
  const targets = sampleTargets([...filler, link('/it/avviso-legale/'), link('/it/protezione-dei-dati/')], site, { maxNavPages: 40, maxExtraPages: 20 });
  assert.deepEqual(targets.slice(0, 2).sort(), ['https://x.com/it/avviso-legale', 'https://x.com/it/protezione-dei-dati']);
});

test('URLs that differ only by query string are one candidate in the sample (first kept)', () => {
  const site = new URL('https://x.com/de');
  const link = (path, region = 'nav') => ({ href: `https://x.com${path}`, text: '', region, visible: true });
  const targets = sampleTargets([
    link('/de/inspiration/?e-filter-1=home'), link('/de/inspiration/?e-filter-1=kitchen'), link('/de/inspiration/'), link('/de/kontakt/', 'main'), link('/de/kontakt/?utm_source=1', 'main'),
    link('/de/impressum/'), link('/de/impressum/?utm_campaign=a'),
  ], site, { maxNavPages: 40, maxExtraPages: 20 });
  assert.equal(targets.filter((u) => u.includes('/inspiration')).length, 1);
  assert.equal(targets.find((u) => u.includes('/inspiration')), 'https://x.com/de/inspiration/?e-filter-1=home');
  assert.equal(targets.filter((u) => u.includes('/kontakt')).length, 1);
  assert.equal(targets.filter((u) => u.includes('/impressum')).length, 1);
});

test('deep check does not pick colour variants of one product or a path that was visited', () => {
  const base = 'https://x.com/de/produkt/morten/';
  const picked = selectDeepCheckUrls([
    `${base}?attribute_colname=graphite`, `${base}?attribute_colname=nordic+blue`, `${base}?attribute_colname=soft+purple`, 'https://x.com/de/produkt/anna/',
    'https://x.com/de/kontakt?utm_source=1', 'https://x.com/de/kontakt/?fbclid=2',
  ], new Set(), new Set(['https://x.com/de/kontakt']), 3);
  assert.deepEqual(picked.map((p) => p.url), [`${base}?attribute_colname=graphite`, 'https://x.com/de/produkt/anna/']);
});

test('query parameters that select content keep pages apart; variant, filter and tracking parameters do not', () => {
  const site = new URL('https://x.com/');
  const link = (q) => ({ href: `https://x.com/index.php${q}`, text: '', region: 'nav', visible: true });
  const pick = (...qs) => sampleTargets(qs.map(link), site, { maxNavPages: 40, maxExtraPages: 20 });
  assert.equal(pick('?page_id=1', '?page_id=2').length, 2, 'WordPress without permalinks');
  assert.equal(pick('?p=5', '?p=6', '?product=a', '?product=b', '?id=1', '?id=2').length, 6);
  assert.equal(pick('?attribute_colname=red', '?attribute_colname=blue').length, 1);
  assert.equal(pick('?page_id=1&utm_source=a', '?page_id=1&fbclid=x&gclid=y').length, 1, 'tracking ignored, content kept');
  assert.equal(pick('?page_id=1&attribute_x=red', '?page_id=2&attribute_x=red').length, 2);
  assert.equal(pick('?b=1&a=2', '?a=2&b=1').length, 1, 'parameter order does not matter');
  for (const q of ['e-filter-6c4fd0c-category=home', 'filter_color=red', 'orderby=price', 'sort=asc', 'color=red', 'colour=red', 'size=m', 'variant=2', 'add-to-cart=3', 'quantity=2']) {
    assert.equal(pick(`?${q}`, '').length, 1, q);
  }
  assert.equal(pick('?q=schuhe', '?q=hosen').length, 2, 'search terms select content');
});

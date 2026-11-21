// Fix 1 (v1.18.1 work): legal pages linked in header/footer/navigation are always in the sample.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleTargets } from '../scripts/lib/sample-targets.mjs';

const SITE = new URL('https://www.shop.example/de');
const link = (path, region = 'nav', text = '') => ({ href: `https://www.shop.example${path}`, text, region, visible: true });
const filler = (n) => Array.from({ length: n }, (_, i) => link(`/de/seite-${i}/`));

test('legal pages behind many navigation links are scanned and never cut by the nav limit', () => {
  const links = [
    ...filler(60),
    link('/de/impressum/'), link('/de/datenschutz/'), link('/de/allgemeine-geschaeftsbedingungen/'), link('/de/barrierefreiheit/'),
  ];
  const targets = sampleTargets(links, SITE, { maxNavPages: 40, maxExtraPages: 20 });
  for (const p of ['impressum', 'datenschutz', 'allgemeine-geschaeftsbedingungen', 'barrierefreiheit']) {
    assert.ok(targets.some((u) => u.includes(p)), p);
  }
  assert.equal(targets.slice(0, 4).every((u) => /impressum|datenschutz|geschaeftsbedingungen|barrierefreiheit/.test(u)), true, 'legal pages come first');
});

test('a --max-extra of 0 does not drop legal pages', () => {
  const links = [...filler(5), link('/de/impressum/', 'header'), link('/de/widerrufsbelehrung/', 'footer')];
  const targets = sampleTargets(links, SITE, { maxNavPages: 2, maxExtraPages: 0 });
  assert.ok(targets.some((u) => u.endsWith('/de/impressum')));
  assert.ok(targets.some((u) => u.endsWith('/de/widerrufsbelehrung')));
});

test('same path prefix as the start URL comes first; other languages come after and do not crowd out the sample', () => {
  const links = [
    link('/pl/'), link('/fr/'), link('/en/privacy/'), link('/en/imprint/'), link('/de/datenschutz/'), link('/de/impressum/'),
    link('/de/kontakt/'),
  ];
  const targets = sampleTargets(links, SITE, { maxNavPages: 40, maxExtraPages: 20 });
  assert.ok(targets.indexOf('https://www.shop.example/de/datenschutz') < targets.indexOf('https://www.shop.example/pl'));
  assert.ok(targets.indexOf('https://www.shop.example/de/kontakt') < targets.indexOf('https://www.shop.example/pl'));
  // other-language legal pages of a type that the start language already has are no longer priority pages
  const limited = sampleTargets(links, SITE, { maxNavPages: 2, maxExtraPages: 0 });
  assert.equal(limited.some((u) => u.includes('/en/')), false);
});

test('a legal type that exists only in another language is still scanned', () => {
  const targets = sampleTargets([link('/de/impressum/'), link('/en/privacy/')], SITE, { maxNavPages: 40, maxExtraPages: 20 });
  assert.ok(targets.includes('https://www.shop.example/en/privacy'));
});

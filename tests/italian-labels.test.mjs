// Fix 5: Italian imprint and privacy link labels (user decision: Italian only).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkLegalPages } from '../scripts/lib/checks/legal-pages.mjs';
import { PATTERNS } from '../scripts/lib/checks/helpers.mjs';

const footer = (text, href) => ({ href: `https://www.shop.example/it/${href}/`, text, region: 'nav', visible: true });
const scanOf = (links) => ({
  startUrl: 'https://www.shop.example/it/', requests: [], cookies: [], transport: {},
  pages: [{ index: 1, url: 'https://www.shop.example/it/', finalUrl: 'https://www.shop.example/it/', status: 200, pageType: 'other', facts: { title: '', links, buttons: [], forms: [], prices: [], banner: null, bodyText: '', footerText: '' } }],
});
const ids = (links, check) => checkLegalPages(scanOf(links)).filter((f) => f.check === check).map((f) => f.status);

test('Italian imprint and privacy labels are recognised as links', () => {
  for (const text of ['Avviso legale', 'Note legali', 'Informazioni legali']) assert.ok(PATTERNS.imprint.test(text), text);
  for (const text of ['Protezione dei dati', 'Privacy', 'Informativa sulla privacy']) assert.ok(PATTERNS.privacy.test(text), text);
});

test('an Italian page with these footer links raises no IMP-01/DSE-01 gap (keeeper.com /it/)', () => {
  const links = [footer('Protezione dei dati', 'protezione-dei-dati'), footer('Avviso legale', 'avviso-legale')];
  assert.deepEqual(ids(links, 'IMP-01'), ['ok']);
  assert.deepEqual(ids(links, 'DSE-01'), ['ok']);
  assert.deepEqual(ids([footer('Contatti', 'contatti')], 'IMP-01'), ['gap'], 'positive control: no label, still a gap');
});

test('look-alike words are no labels', () => {
  assert.equal(PATTERNS.imprint.test('Note legate al prodotto'), false);
  assert.equal(PATTERNS.privacy.test('Protezione solare'), false);
});

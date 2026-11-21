// Review of v1.19.0 (items 10, 11): location links and net notes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PATTERNS } from '../scripts/lib/checks/helpers.mjs';
import { texts } from '../scripts/lib/report/i18n.mjs';
import { expandWhere, whereHtml } from '../scripts/lib/report/where-links.mjs';

const de = texts('de');
const ex = (text, site = 'x.de') => expandWhere(text, site, de);

test('URL detection ignores case: HTTP://X.DE/A stays as it is and counts as a URL', () => {
  assert.equal(ex('HTTP://X.DE/A'), 'HTTP://X.DE/A');
  assert.equal(ex('Siehe Https://x.de/a und /b'), 'Siehe Https://x.de/a und https://x.de/b');
  assert.match(whereHtml('HTTP://X.DE/A'), /<a href="HTTP:\/\/X\.DE\/A">/);
});

test('truncated paths with an ellipsis stay text', () => {
  assert.equal(ex('/de/…/flexodruck'), '/de/…/flexodruck (geprüft u. a. https://x.de/)');
  assert.equal(ex('/de/.../x'), '/de/.../x (geprüft u. a. https://x.de/)');
});

test('paths in quotes and brackets are expanded and then no start page is appended', () => {
  assert.equal(ex('„/impressum“'), '„https://x.de/impressum“');
  assert.equal(ex('"/kontakt"'), '"https://x.de/kontakt"');
  assert.equal(ex('[/de/a]'), '[https://x.de/de/a]');
  assert.equal(ex("'/kontakt'"), "'https://x.de/kontakt'");
});

test('a slash before a capitalised German word is no path ("Kopfzeile /Fußzeile")', () => {
  assert.equal(ex('Kopfzeile /Fußzeile'), 'Kopfzeile /Fußzeile (geprüft u. a. https://x.de/)');
  assert.equal(ex('Header /Footer'), 'Header /Footer (geprüft u. a. https://x.de/)');
  for (const path of ['/de/sale/', '/rechtliches/datenschutz-cookies', '/kontakt/', '/cn/', '/kontakt', '/Impressum/', '/A-b', '/x.html']) {
    assert.equal(ex(`Seite ${path}`), `Seite https://x.de${path}`, path);
  }
});

test('a closing bracket that ends the surrounding parenthetical stays outside the link', () => {
  assert.match(whereHtml('Seite (https://x.de/a)'), /\(<a href="https:\/\/x\.de\/a">https:\/\/x\.de\/a<\/a>\)$/);
  assert.match(whereHtml('Seite (siehe https://x.de/wiki_(a)), Ende'), /<a href="https:\/\/x\.de\/wiki_\(a\)">/);
  assert.equal(ex('Seite (dazu /cn/)'), 'Seite (dazu https://x.de/cn/)');
});

test('a site with a path prefix expands paths against the origin', () => {
  assert.equal(expandWhere('/cn/', 'wh.group/de', de), 'https://wh.group/cn/');
});

test('net note: "netto" must sit directly at the price', () => {
  for (const text of ['€ 1.900 netto', 'ab 1.900 € netto', 'netto 1.900 €', 'netto ab 1.900 €', 'Nettopreis: ab € 1.900', '99,- € netto']) {
    assert.ok(PATTERNS.netNote.test(text), text);
  }
  for (const text of ['Bei Netto: 5 € sparen', 'Netto Marken-Discount: 5 € sparen', 'netto sparen: 5 €', 'netto: 3 €']) {
    assert.equal(PATTERNS.netNote.test(text), false, text);
  }
});

test('net note: long digit runs do not blow up the regex', () => {
  const started = Date.now();
  PATTERNS.netNote.test(`${'1'.repeat(50_000)} und ${'1.'.repeat(20_000)}`);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('N3: umlauts and capitals are fine in paths; only the "Word /Noun" alternative is no path', () => {
  for (const path of ['/über-uns', '/de/über-uns', '/Impressum', '/FAQ', '/Über-uns/', '/de/Kontakt']) {
    assert.equal(ex(path), `https://x.de${path}`, path);
    assert.equal(ex(`Seiten: ${path}, /agb`), `Seiten: https://x.de${path}, https://x.de/agb`, `after colon: ${path}`);
  }
  assert.equal(ex('Kopfzeile /Fußzeile'), 'Kopfzeile /Fußzeile (geprüft u. a. https://x.de/)');
  assert.equal(ex('Header /Footer'), 'Header /Footer (geprüft u. a. https://x.de/)');
  assert.equal(ex('Seite /kontakt und /Über-uns'), 'Seite https://x.de/kontakt und https://x.de/Über-uns');
  assert.equal(ex('Seite /FAQ'), 'Seite https://x.de/FAQ', 'an acronym is a path');
  assert.equal(ex('/de/…/über-uns'), '/de/…/über-uns (geprüft u. a. https://x.de/)');
});

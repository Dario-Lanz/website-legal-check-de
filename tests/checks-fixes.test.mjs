// Regression tests for the review findings on checks and report building (v1.15.1 review).

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { buildReports } from '../scripts/build-reports.mjs';
import { checkConsent } from '../scripts/lib/checks/consent.mjs';
import { checkConsentChoice } from '../scripts/lib/checks/consent-choice.mjs';
import { PATTERNS, looksLikeShop, policyPage } from '../scripts/lib/checks/helpers.mjs';
import { checkImprintDetails, checkPolicyContent } from '../scripts/lib/checks/legal-content.mjs';
import { checkLegalPages } from '../scripts/lib/checks/legal-pages.mjs';
import { checkShop } from '../scripts/lib/checks/shop.mjs';
import { checkSite } from '../scripts/lib/checks/site.mjs';
import { matchService } from '../scripts/lib/third-parties.mjs';
import { esc, escHtml } from '../scripts/lib/report/model.mjs';

const facts = (over = {}) => ({ title: '', links: [], buttons: [], forms: [], prices: [], banner: null, bodyText: '', footerText: '', ...over });
const page = (index, url, pageType, over = {}) => ({ index, url, finalUrl: url, status: 200, pageType, facts: facts(over.facts), ...over, ...(over.facts ? { facts: facts(over.facts) } : {}) });
const scanOf = (pages, over = {}) => ({ startUrl: pages[0]?.url ?? 'https://x.de/', pages, requests: [], cookies: [], transport: { httpRedirectsToHttps: true }, ...over });

// Finding 4
test('TDD-04: unrecognised buttons give a hint, wider reject and accept wording is recognised', () => {
  const run = (buttons) => checkConsent(scanOf([page(1, 'https://x.de/', 'other', { facts: { banner: { buttons, text: 't' } } })]))
    .find((f) => f.check === 'TDD-04');
  assert.equal(run(['Einstellungen', 'Speichern']).status, 'hint');
  assert.equal(run([]).status, 'hint');
  for (const reject of ['Nur essenzielle Cookies', 'Nur essentielle', 'Weiter ohne Einwilligung', 'Nein, danke', 'Necessary only', 'Refuse']) {
    assert.equal(run(['Alles gut', reject, 'Akzeptieren']).status, 'ok', reject);
  }
  for (const accept of ['Alle Cookies erlauben', 'Cookies zulassen', 'Erlauben', 'Agree', 'Got it']) {
    assert.equal(run([accept]).status, 'gap', accept);
  }
});

// Finding 5
test('PRC-01: VAT notes in the common wordings are recognised', () => {
  for (const text of ['inkl. gesetzlicher MwSt.', 'einschließlich Mehrwertsteuer', 'einschl. MwSt.', 'MwSt. enthalten', 'inkl. 7,0 % MwSt.',
    'inkl. jeweils gültiger MwSt.', 'inklusive der jeweils geltenden Mehrwertsteuer', 'incl. VAT', 'inkl. 19% MwSt']) {
    assert.ok(PATTERNS.vatNote.test(text), text);
  }
  assert.ok(!PATTERNS.vatNote.test('Preis 10 Euro, Versand extra'));
});

// Finding 6
test('SEC-02: the main-frame navigation from http to https is not mixed content', () => {
  const p = page(1, 'https://x.de/', 'other');
  const doc = { page: 1, url: 'http://x.de/', resourceType: 'document', mainFrame: true };
  assert.equal(checkSite(scanOf([p], { requests: [doc] })).filter((f) => f.check === 'SEC-02').length, 0);
  const iframe = { page: 1, url: 'http://widget.example/', resourceType: 'document', mainFrame: false };
  assert.equal(checkSite(scanOf([p], { requests: [doc, iframe] })).filter((f) => f.check === 'SEC-02').length, 1, 'an http iframe stays mixed content');
  const img = { page: 1, url: 'http://x.de/a.png', resourceType: 'image' };
  assert.equal(checkSite(scanOf([p], { requests: [doc, img] })).filter((f) => f.check === 'SEC-02').length, 1);
});

// Finding 9
test('gtag/js maps to Google Analytics, other Tag Manager paths stay Tag Manager', () => {
  assert.equal(matchService('https://www.googletagmanager.com/gtag/js?id=G-1')?.name, 'Google Analytics');
  assert.equal(matchService('https://www.googletagmanager.com/gtm.js?id=GTM-1')?.name, 'Google Tag Manager');
});

test('TDD-07: script loads do not break the denied Consent Mode judgement', () => {
  const req = (url, resourceType) => ({ url, resourceType, thirdParty: true, ...(() => { const s = matchService(url); return { service: s.name, category: s.category }; })() });
  const reject = (requests) => ({ reject: { clicked: true, button: 'Ablehnen', bannerGone: true, visited: ['https://x.de/'], requests, newCookies: [] } });
  const scan = (requests) => scanOf([page(1, 'https://x.de/', 'other')], { consentRuns: reject(requests) });
  const script = req('https://www.googletagmanager.com/gtag/js?id=G-1', 'script');
  const analyticsJs = req('https://www.google-analytics.com/analytics.js', 'script');
  const ping = req('https://www.google-analytics.com/g/collect?gcs=G100', 'ping');
  const found = checkConsentChoice(scan([script, ping, analyticsJs]));
  assert.deepEqual(found.map((f) => [f.check, f.status]), [['TDD-07', 'hint']]);
  const granted = checkConsentChoice(scan([script, req('https://www.google-analytics.com/g/collect?gcs=G111', 'ping')]));
  assert.deepEqual(granted.map((f) => [f.check, f.status]), [['TDD-06', 'gap']]);
  const scriptsOnly = checkConsentChoice(scan([script]));
  assert.deepEqual(scriptsOnly.map((f) => [f.check, f.status]), [['TDD-06', 'gap']]);
});

// Finding 10
test('policyPage ignores the host and prefers the footer-linked page', () => {
  const home = page(1, 'https://datenschutz-xyz.de/', 'other', { facts: { title: 'Start' } });
  const about = page(2, 'https://datenschutz-xyz.de/ueber-uns', 'other', { facts: { title: 'Über uns' } });
  assert.equal(policyPage(scanOf([home, about])), null);
  const a = page(2, 'https://x.de/a/privacy-notes', 'other', { facts: { title: 'Notes' } });
  const b = page(3, 'https://x.de/b/privacy', 'other', { facts: { title: 'Privacy' } });
  const start = page(1, 'https://x.de/', 'other', { facts: { links: [{ href: 'https://x.de/b/privacy', text: 'Datenschutz', region: 'footer', visible: true }] } });
  assert.equal(policyPage(scanOf([start, a, b])).index, 3);
});

test('looksLikeShop needs prices or a cart button for product pages', () => {
  assert.equal(looksLikeShop(scanOf([page(1, 'https://x.de/p/ueber-uns', 'product')])), false);
  assert.equal(looksLikeShop(scanOf([page(1, 'https://x.de/produkt/a', 'product', { facts: { prices: ['9,99 €'] } })])), true);
  assert.equal(looksLikeShop(scanOf([page(1, 'https://x.de/warenkorb', 'cart')])), true);
});

// Finding 11
test('IMP-04: register court AG, doctors, architecture and § 5 Abs. 1 TMG', () => {
  const run = (text) => checkImprintDetails(scanOf([page(1, 'https://x.de/impressum', 'imprint', { facts: { bodyText: text } })])).map((f) => f.evidence);
  assert.deepEqual(run('Max Muster e.K. Handelsregister: AG Charlottenburg, HRA 1'), []);
  assert.deepEqual(run('Muster e.K., AG Köln HRA 5'), []);
  assert.deepEqual(run('Muster GmbH, vertreten durch Max, AG Köln HRB 5'), []);
  assert.deepEqual(run('Muster Ärztin, Ärztekammer Nordrhein'), []);
  assert.deepEqual(run('Dr. Muster, Ärztin'), [{ missing: 'chamber' }]);
  assert.deepEqual(run('Die Ärzte Muster'), [{ missing: 'chamber' }]);
  assert.deepEqual(run('Wir bieten Informationsarchitektur an'), []);
  assert.deepEqual(run('Muster, Architekt, Architektenkammer'), []);
  assert.deepEqual(run('Angaben gemäß § 5 Abs. 1 TMG'), [{ outdated: '§ 5 TMG' }]);
  assert.deepEqual(run('Angaben gemäß § 7 Abs. 1 TMG'), [{ outdated: '§ 5 TMG' }]);
});

// Finding 12
test('DSE-03: Artikel 6, further rights wording and storage periods in days are recognised', () => {
  const base = 'Verantwortlich ist X. Beschwerde bei der Aufsichtsbehörde. Widerruf jederzeit.';
  const missing = (text) => checkPolicyContent(scanOf([page(1, 'https://x.de/datenschutz', 'privacy', { facts: { bodyText: `${base} ${text}` } })]))[0]?.evidence.missing ?? [];
  assert.deepEqual(missing('Rechtsgrundlage ist Artikel 6 DSGVO. Betroffenenrechte: Berichtigung. Logdaten werden nach 7 Tagen entfernt.'), []);
  assert.deepEqual(missing('Rechtsgrundlage. Berichtigung. Daten werden für 30 Tage gespeichert.'), []);
  assert.ok(missing('Start 6 Uhr. Berichtigung. Löschfrist 1 Jahr.').includes('legalBasis'));
});

// Finding 13
test('IMP-01/DSE-01: vendor links do not count; an invisible link is a hint (review 2, finding 5)', () => {
  const link = (href, extra = {}) => ({ href, text: 'Datenschutz', region: 'footer', visible: true, ...extra });
  const run = (links) => checkLegalPages(scanOf([page(1, 'https://x.de/', 'other', { facts: { links, footerText: '' } })])).find((f) => f.check === 'DSE-01');
  assert.equal(run([link('https://x.de/datenschutz')]).status, 'ok');
  assert.equal(run([link('https://policies.google.com/privacy')]).status, 'gap');
  assert.equal(run([link('https://x.de/datenschutz', { visible: false })]).status, 'hint');
  assert.equal(run([link('https://impressum.x.de/datenschutz')]).status, 'ok');
});

// Finding 14
test('legal page with HTTP status >= 400: gap under IMP-01/DSE-01 and no content checks', () => {
  const links = [{ href: 'https://x.de/datenschutz', text: 'Datenschutz', region: 'footer', visible: true }, { href: 'https://x.de/impressum', text: 'Impressum', region: 'footer', visible: true }];
  const start = page(1, 'https://x.de/', 'other', { facts: { links } });
  const priv = page(2, 'https://x.de/datenschutz', 'privacy', { status: 404, facts: { bodyText: 'Not found' } });
  const imp = page(3, 'https://x.de/impressum', 'imprint', { status: 500, facts: { bodyText: 'Error' } });
  const scan = scanOf([start, priv, imp]);
  const pages = checkLegalPages(scan);
  assert.deepEqual(pages.filter((f) => f.check === 'DSE-01').map((f) => f.status), ['gap']);
  assert.deepEqual(pages.filter((f) => f.check === 'IMP-01').map((f) => f.status), ['gap']);
  assert.deepEqual(pages.filter((f) => f.check === 'IMP-02'), []);
  assert.deepEqual(checkPolicyContent(scan), []);
  assert.deepEqual(checkImprintDetails(scan), []);
});

// Finding 21 (checks side)
test('no scanned page: no "ok" legal links and no crash in the consent check', () => {
  const failed = { index: 1, url: 'https://x.de/', error: 'timeout', facts: null };
  const scan = scanOf([failed]);
  const results = checkLegalPages(scan);
  assert.ok(!results.some((f) => f.status === 'ok'));
  assert.deepEqual(results.map((f) => f.check).sort(), ['DSE-01', 'IMP-01']);
  assert.doesNotThrow(() => checkConsent({ ...scan, requests: [{ url: 'https://www.google-analytics.com/a', page: 1, thirdParty: true, service: 'Google Analytics', category: 'analytics' }] }));
  assert.doesNotThrow(() => checkConsent({ pages: [], requests: [], cookies: [] }));
});

// Finding 22
test('IMP-02/03: copyright years are no postal code, "privat" is no VAT ID', () => {
  const run = (text) => checkLegalPages(scanOf([page(1, 'https://x.de/impressum', 'imprint', { facts: { bodyText: text } })]));
  const has = (results, check, status) => results.some((f) => f.check === check && f.status === status);
  const results = run('© 2024 Muster, privat, info@x.de');
  assert.ok(has(results, 'IMP-02', 'hint'));
  assert.ok(has(results, 'IMP-03', 'hint'));
  const austria = run('Muster, 1010 Wien, info@x.de, UID ATU1, USt-IdNr');
  assert.ok(!has(austria, 'IMP-02', 'hint'));
  assert.ok(!has(run('Muster, A-1010 Wien, info@x.de'), 'IMP-02', 'hint'));
});

// Finding 20
test('escHtml leaves typography alone, esc applies it', () => {
  assert.equal(escHtml('§ 5 <b> 19 %'), '§ 5 &lt;b&gt; 19 %');
  assert.equal(esc('§ 5'), '§ 5');
});

// Finding 3
async function buildFixture(mockupFile, figureSrc = 'belege/seite-01-ansicht.png') {
  const run = await mkdtemp(path.join(tmpdir(), 'wlc-fix-'));
  const daten = path.join(run, 'daten');
  await mkdir(path.join(daten, 'belege'), { recursive: true });
  const browser = await chromium.launch();
  try {
    const p = await browser.newPage();
    await p.setContent('<body style="margin:0;background:#08f;height:300px"></body>');
    await p.screenshot({ path: path.join(daten, 'belege', 'seite-01-ansicht.png') });
  } finally {
    await browser.close();
  }
  await writeFile(path.join(daten, 'mock.html'), '<!doctype html><meta charset="utf-8"><h1>Vorschlag</h1>');
  await writeFile(path.join(run, 'victim.txt'), 'keep me');
  const report = path.join(daten, 'report.json');
  await writeFile(report, JSON.stringify({
    site: 'example.de', date: '07.11.2026', pagesScanned: 1, checklistStatus: '07.11.2026',
    findings: [{ prio: 1, kind: 'gap', title: 'T', what: 'W', where: '/x/', law: '§ 25 TDDDG', fix: 'F', evidence: 'E', summary: 'S', plain: { where: 'pw', law: 'pl', evidence: 'pe' },
      figures: [{ src: figureSrc, caption: 'c' }], mockup: { file: mockupFile, description: 'd' } }],
  }));
  return { run, daten, report };
}

test('long build: mock-up sources stay, a second build with the same report.json works', async () => {
  const { run, daten, report } = await buildFixture('mock.html');
  try {
    await buildReports(report, '20261107_example', { long: true });
    assert.ok((await readdir(daten)).includes('mock.html'));
    await buildReports(report, '20261107_example', { long: true });
  } finally {
    await rm(run, { recursive: true, force: true });
  }
});

test('long build: paths outside daten/, wrong types and figures outside belege/ are refused, nothing is deleted', async () => {
  for (const [mockup, figure, message] of [
    ['../victim.txt', undefined, /outside/],
    ['sub/../../victim.txt', undefined, /outside/],
    ['mock.txt', undefined, /\.html/],
    ['mock.html', '../victim.txt', /outside/],
    ['mock.html', 'mock.html', /belege/],
  ]) {
    const { run, report } = await buildFixture(mockup, figure);
    try {
      await assert.rejects(buildReports(report, '20261107_example', { long: true }), message, `${mockup} ${figure}`);
      assert.equal(await readFile(path.join(run, 'victim.txt'), 'utf8'), 'keep me');
    } finally {
      await rm(run, { recursive: true, force: true });
    }
  }
});

test('long build: a missing mock-up file gives a clear error', async () => {
  const { run, report } = await buildFixture('gone.html');
  try {
    await assert.rejects(buildReports(report, '20261107_example', { long: true }), /Mock-up file not found: gone\.html/);
  } finally {
    await rm(run, { recursive: true, force: true });
  }
});

test('mock-ups are rendered without JavaScript', async () => {
  const { run, report, daten } = await buildFixture('mock.html');
  try {
    await writeFile(path.join(daten, 'mock.html'), '<!doctype html><meta charset="utf-8"><body style="background:#fff"><script>document.body.style.background="#f00"</script><h1>X</h1>');
    const { prepareImages } = await import('../scripts/lib/report/images.mjs');
    const browser = await chromium.launch();
    try {
      const { mockups } = await prepareImages(browser, daten, [{ figures: [], mockup: { file: 'mock.html' } }]);
      const probe = await browser.newPage();
      const pixel = await probe.evaluate(async (src) => {
        const img = new Image(); img.src = src; await img.decode();
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
        return [...ctx.getImageData(img.naturalWidth - 5, img.naturalHeight - 5, 1, 1).data];
      }, mockups.get('mock.html'));
      assert.ok(pixel[1] > 200 && pixel[2] > 200, `page stayed white, got ${pixel}`);
    } finally {
      await browser.close();
    }
  } finally {
    await rm(run, { recursive: true, force: true });
  }
});

// Finding 19
test('long report running header: no HTML entities in the CSS string', async () => {
  const { renderLangfassung } = await import('../scripts/lib/report/langfassung.mjs');
  const { buildModel } = await import('../scripts/lib/report/model.mjs');
  const model = buildModel({ site: 'a&b"c.de', date: '07.11.2026', pagesScanned: 1, checklistStatus: '07.11.2026', findings: [] });
  const css = renderLangfassung(model, { promptChapter: false }).match(/@top-right \{ content: "([^]*?)";/)[1];
  assert.ok(!/&amp;|&quot;|&#39;/.test(css), css);
  assert.ok(css.includes('\\26 ') && css.includes('\\"'), css);
});
